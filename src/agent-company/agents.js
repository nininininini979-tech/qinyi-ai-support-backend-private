import crypto from "node:crypto";
import { compileTaskContract } from "../thought-layer/contract.js";
import { buildGenerationPrompt, buildReviewerPrompt, A_GOVERNANCE_PROMPT, D_STAGE_PROMPT } from "../thought-layer/prompts.js";
import { combineReviews, parseModelReview } from "../thought-layer/reviewer.js";
import { AGENT_IDS, agentRunMetadata } from "./protocol.js";
import { toPlainText } from "../support/plain-text.js";

function parseJson(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch { return null; }
}

function candidateId() {
  return `candidate-${crypto.randomUUID()}`;
}

function normalizeDAnalysis(proposed, fallback) {
  if (!proposed || typeof proposed !== "object") return fallback;
  return {
    summary: typeof proposed.summary === "string" && proposed.summary.trim() ? proposed.summary.trim() : fallback.summary,
    dominantIssues: Array.isArray(proposed.dominantIssues) ? proposed.dominantIssues.slice(0, 10) : fallback.dominantIssues,
    directions: Array.isArray(proposed.directions) && proposed.directions.length ? proposed.directions.slice(0, 10).map(String) : fallback.directions,
    proposedChanges: Array.isArray(proposed.proposedChanges) ? proposed.proposedChanges.slice(0, 10) : fallback.proposedChanges
  };
}

export class AAgent {
  constructor({ window, policyEngine }) {
    this.id = AGENT_IDS.A;
    this.window = window;
    this.profile = window.profile;
    this.policyEngine = policyEngine;
  }

  compileContract(input) {
    return compileTaskContract(input);
  }

  createWorkOrder(input) {
    return Object.freeze({ ...input, issuedBy: this.id, contractHash: input.contract.hash });
  }

  fallbackDecision({ candidates, failures, maxFailures }) {
    const passing = candidates.filter((item) => item.review?.decision === "pass");
    if (passing.length) {
      const selected = [...passing].sort((left, right) => right.review.score - left.review.score)[0];
      return { action: "publish", selectedCandidateId: selected.id, reasonCodes: ["c_pass", "highest_validated_score"] };
    }
    return failures >= maxFailures
      ? { action: "handoff", reasonCodes: ["review_failure_limit"] }
      : { action: "rework", reasonCodes: ["no_candidate_passed_c"] };
  }

  async decide(input) {
    const requiredStageDecision = this.fallbackDecision(input);
    let decision = requiredStageDecision;
    if (this.window.isRemote && Number(input.timeoutMs || 0) >= 1000) {
      try {
        const result = await this.window.invoke({
          systemPrompt: A_GOVERNANCE_PROMPT,
          userPrompt: `只返回 JSON 裁决。可选 action 为 publish、rework、handoff；publish 必须给 selectedCandidateId。\n${JSON.stringify(input)}`,
          json: true,
          timeoutMs: input.timeoutMs,
          maxTokens: 350
        });
        const proposed = parseJson(result);
        if (proposed && ["publish", "rework", "handoff"].includes(proposed.action)) {
          decision = { action: proposed.action, selectedCandidateId: proposed.selectedCandidateId, reasonCodes: Array.isArray(proposed.reasonCodes) ? proposed.reasonCodes.slice(0, 8).map(String) : ["a_remote_decision"] };
        }
      } catch {
        decision = { ...this.fallbackDecision(input), reasonCodes: ["a_api_unavailable", ...this.fallbackDecision(input).reasonCodes] };
      }
    }
    if (decision.action !== requiredStageDecision.action) {
      decision = { ...requiredStageDecision, reasonCodes: ["company_stop_condition_enforced", ...requiredStageDecision.reasonCodes] };
    }
    try {
      decision = this.policyEngine.validatePublishDecision({ decision, candidates: input.candidates });
    } catch {
      decision = this.policyEngine.validatePublishDecision({
        decision: { ...this.fallbackDecision(input), reasonCodes: ["invalid_a_api_decision", ...this.fallbackDecision(input).reasonCodes] },
        candidates: input.candidates
      });
    }
    return { ...decision, decidedBy: this.id, run: agentRunMetadata({ agentId: this.id, profile: this.profile }) };
  }

  async handle(envelope) {
    if (!["candidate", "review_result", "stage_proposal"].includes(envelope.type)) throw new Error(`A cannot handle ${envelope.type}`);
    return envelope.payload;
  }
}

export class BAgent {
  constructor({ window, evidenceResolver }) {
    this.id = AGENT_IDS.B;
    this.window = window;
    this.profile = window.profile;
    this.evidenceResolver = evidenceResolver;
  }

  async handle(envelope) {
    if (envelope.from !== AGENT_IDS.A || envelope.type !== "work_order") throw new Error("B only accepts A work orders");
    const order = envelope.payload;
    const evidenceBundle = this.window.isRemote
      ? await this.evidenceResolver.resolve({ message: order.message, session: order.session, identity: order.identity })
      : null;
    const generationPrompt = buildGenerationPrompt({
      contract: order.contract,
      playbookPrompt: order.playbookPrompt,
      branch: order.branch,
      priorCandidate: order.priorCandidate,
      issues: order.issues,
      evidenceBundle,
      compact: order.compact
    });
    const output = await this.window.invoke({
      systemPrompt: generationPrompt,
      userPrompt: order.message,
      timeoutMs: order.timeoutMs,
      maxTokens: order.contract.b2.professionalConsultation ? 700 : 500,
      legacyMethod: "answer",
      legacyInput: {
        message: order.message,
        identity: order.identity,
        session: order.session,
        thoughtContext: { contract: order.contract, generationPrompt, branch: order.branch, externalReview: true }
      }
    });
    const result = typeof output === "string"
      ? { action: "answer", answer: toPlainText(output), grounded: Boolean(evidenceBundle?.citations.length), citations: evidenceBundle?.citations || [], reviewEvidence: evidenceBundle?.evidence || [] }
      : output || { action: "answer", answer: "当前生成 Agent 尚未连接。", grounded: false, citations: [] };
    return { id: candidateId(), branch: order.branch, result, producedBy: this.id, run: agentRunMetadata({ agentId: this.id, profile: this.profile }) };
  }
}

export class CAgent {
  constructor({ window, evidenceResolver }) {
    this.id = AGENT_IDS.C;
    this.window = window;
    this.profile = window.profile;
    this.evidenceResolver = evidenceResolver;
  }

  async handle(envelope) {
    if (envelope.from !== AGENT_IDS.A || envelope.type !== "review_request") throw new Error("C only accepts A review requests");
    const { contract, candidate, preflight, timeoutMs } = envelope.payload;
    const result = candidate.result;
    const citations = result.citations || [];
    const hydrated = result.reviewEvidence?.length || !this.evidenceResolver
      ? { evidence: result.reviewEvidence || [] }
      : await this.evidenceResolver.resolve({ message: contract.demand.goal, session: { history: [] } });
    const reviewPrompt = buildReviewerPrompt({ contract, candidate: result.answer, citations, evidence: hydrated.evidence });
    const output = await this.window.invoke({
      systemPrompt: reviewPrompt,
      userPrompt: "请执行独立审核并只返回规定的 JSON。",
      json: true,
      timeoutMs,
      maxTokens: 900,
      legacyMethod: "review",
      legacyInput: { contract, candidate: result.answer, reviewPrompt }
    });
    const independent = output === null
      ? { decision: contract.risk.level === "low" ? "pass" : "escalate", score: preflight.score, issues: contract.risk.level === "low" ? [] : [{ code: "c_api_unavailable", severity: "fatal", reason: "C API 尚未连接。", repairConstraint: "连接独立 C API 或转人工。" }] }
      : parseModelReview(output);
    const review = combineReviews(preflight, independent);
    return { candidateId: candidate.id, review, reviewedBy: this.id, run: agentRunMetadata({ agentId: this.id, profile: this.profile }) };
  }
}

export class DAgent {
  constructor({ window }) {
    this.id = AGENT_IDS.D;
    this.window = window;
    this.profile = window.profile;
  }

  async handle(envelope) {
    if (envelope.from !== AGENT_IDS.A || envelope.type !== "stage_snapshot") throw new Error("D only accepts A stage snapshots");
    const snapshot = envelope.payload;
    const samples = Array.isArray(snapshot.samples) ? snapshot.samples : [];
    const failed = samples.filter((item) => item.outcome === "automatic_handoff");
    const issueCounts = {};
    for (const sample of samples) for (const code of sample.issueCodes || []) issueCounts[code] = Number(issueCounts[code] || 0) + 1;
    const dominantIssues = Object.entries(issueCounts).sort((left, right) => right[1] - left[1]).slice(0, 5).map(([code, count]) => ({ code, count }));
    let analysis = {
      summary: `本阶段包含 ${samples.length} 个脱敏样本，其中 ${failed.length} 个自动转人工。`,
      dominantIssues,
      directions: dominantIssues.length ? dominantIssues.map((item) => `复核 ${item.code} 的重复失败`) : ["复核高频失败类型", "验证返工收益", "检查成本、延迟与隐私影响"],
      proposedChanges: []
    };
    if (this.window.isRemote) {
      const output = await this.window.invoke({
        systemPrompt: D_STAGE_PROMPT,
        userPrompt: `分析下面的阶段快照。请只返回一个有效 JSON 对象，不要使用 Markdown，不要原样复述输入。固定结构为：{"summary":"阶段结论","dominantIssues":[{"code":"问题代码","count":1}],"directions":["改良方向"],"proposedChanges":[]}。\n阶段快照：${JSON.stringify(snapshot)}`,
        json: true
      });
      const proposed = parseJson(output);
      analysis = normalizeDAnalysis(proposed, analysis);
    }
    return { ...analysis, proposedBy: this.id, run: agentRunMetadata({ agentId: this.id, profile: this.profile }) };
  }
}
