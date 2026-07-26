import { loadAutonomyPrompt } from "../support/playbook.js";
import { AAgent, BAgent, CAgent, DAgent } from "../agent-company/agents.js";
import { CompanyPolicyEngine } from "../agent-company/company-policy.js";
import { createAgentApiWindows } from "../agent-company/api-windows.js";
import { AGENT_IDS, InProcessAgentBus } from "../agent-company/protocol.js";
import { sessionThoughtState } from "./contract.js";

function candidateView(candidate) {
  const result = candidate.result;
  return {
    id: candidate.id,
    branch: candidate.branch,
    answer: result.answer,
    grounded: Boolean(result.grounded),
    citations: result.citations || [],
    evidence: result.reviewEvidence || [],
    producedBy: candidate.producedBy,
    run: candidate.run
  };
}

function publicIssues(review) {
  return review.issues.map(({ code, severity, reason, repairConstraint }) => ({ code, severity, reason, repairConstraint }));
}

function bestCandidate(candidates) {
  return [...candidates].sort((left, right) => (right.review?.score || 0) - (left.review?.score || 0))[0];
}

const nullEvidenceResolver = { async resolve() { return { citations: [], evidence: [] }; } };

class DeadlineExceededError extends Error {
  constructor() {
    super("Agent company reply deadline exceeded");
    this.name = "DeadlineExceededError";
  }
}

function remainingMs(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

function assertActive(operation) {
  if (operation?.cancelled || remainingMs(operation?.deadlineAt || 0) < 1) {
    if (operation) operation.cancelled = true;
    throw new DeadlineExceededError();
  }
}

async function withinDeadline(promise, timeoutMs, operation) {
  if (timeoutMs < 1) {
    if (operation) operation.cancelled = true;
    throw new DeadlineExceededError();
  }
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new DeadlineExceededError()), timeoutMs); })
    ]);
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "DeadlineExceededError" || /timed?\s*out|timeout|deadline/i.test(String(error?.message || ""))) {
      if (operation) operation.cancelled = true;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isDeadlineError(error) {
  return error?.name === "AbortError" || error?.name === "DeadlineExceededError" || /timed?\s*out|timeout|deadline/i.test(String(error?.message || ""));
}

function timeoutAnswer(contract, professional) {
  const zh = professional
    ? "为保证专业结论可靠，本轮证据整理与审核未能在时限内完成。请补充最关键的规格或目标，我会缩小范围继续分析；精确价格、交期与可行性仍需业务确认。"
    : "为保证准确性，本轮未在时限内完成全部核验。我先不提供未经审核的结论；请补充最关键的产品、数量或用途，也可以由业务人员继续确认。";
  const en = professional
    ? "To keep the professional analysis reliable, the evidence review did not finish within this response window. Please provide the most important specification or objective so I can narrow the scope. Exact pricing, lead time, and feasibility still require business confirmation."
    : "To protect accuracy, the required checks did not finish within this response window. I will not provide an unreviewed conclusion. Please add the key product, quantity, or intended use, or ask a specialist to confirm it.";
  if (contract.language.bilingual) return `${zh}\n\n${en}`;
  return contract.language.output === "en" ? en : zh;
}

export class ThoughtLayerEngine {
  constructor({ config, provider, reviewProvider, playbookDir, memory, governor, agents, apiWindows, evidenceResolver, policyEngine = new CompanyPolicyEngine() }) {
    this.config = config;
    this.playbookDir = playbookDir;
    this.memory = memory;
    this.governor = governor;
    this.maxFailures = Number(config.THOUGHT_REVIEW_MAX_FAILURES || 3);
    this.policyEngine = policyEngine;
    const windows = apiWindows || createAgentApiWindows({
      AGENT_A_PROVIDER: "mock",
      AGENT_B_PROVIDER: "inherit",
      AGENT_C_PROVIDER: "inherit",
      AGENT_D_PROVIDER: "mock"
    }, { b: provider, c: reviewProvider || provider });
    this.agents = agents || {
      a: new AAgent({ window: windows.a, policyEngine }),
      b: new BAgent({ window: windows.b, evidenceResolver: evidenceResolver || nullEvidenceResolver }),
      c: new CAgent({ window: windows.c, evidenceResolver: evidenceResolver || nullEvidenceResolver }),
      d: new DAgent({ window: windows.d })
    };
    this.bus = new InProcessAgentBus();
    for (const agent of Object.values(this.agents)) this.bus.register(agent);
  }

  async dispatch({ sessionId, from, to, type, payload, correlationId, timeoutMs, operation }) {
    assertActive(operation);
    const response = await withinDeadline(this.bus.send({ from, to, type, payload, correlationId }), timeoutMs || 30_000, operation);
    assertActive(operation);
    await this.memory.appendEvent({
      sessionId,
      type: "agent_communication",
      agentId: to,
      correlationId,
      payload: { from, to, messageType: type, responseAgent: response?.producedBy || response?.reviewedBy || response?.proposedBy }
    });
    return response;
  }

  async generate({ message, identity, session, sessionId, contract, playbookPrompt, deadlineAt, operation, branch = "initial", priorCandidate, issues }) {
    assertActive(operation);
    const remaining = remainingMs(deadlineAt);
    const reserve = contract.b2.professionalConsultation ? 10_000 : 7_000;
    const timeoutMs = Math.min(contract.b2.professionalConsultation ? 30_000 : 22_000, remaining - reserve);
    if (timeoutMs < 1000) throw new DeadlineExceededError();
    const workOrder = this.agents.a.createWorkOrder({ message, identity, session, contract, playbookPrompt, branch, priorCandidate, issues, timeoutMs, compact: remaining < (contract.b2.professionalConsultation ? 25_000 : 15_000) });
    return this.dispatch({ sessionId, from: AGENT_IDS.A, to: AGENT_IDS.B, type: "work_order", payload: workOrder, correlationId: contract.id, timeoutMs: timeoutMs + 500, operation });
  }

  async review({ sessionId, contract, candidate, deadlineAt, operation, forceIndependent = false }) {
    assertActive(operation);
    const preflight = this.policyEngine.preflight({ contract, candidate });
    if (!this.policyEngine.requiresIndependentC({ contract, preflight, forceIndependent })) {
      return { ...candidate, review: preflight, reviewedBy: "company-policy" };
    }
    const timeoutMs = Math.min(contract.b2.professionalConsultation ? 25_000 : 15_000, remainingMs(deadlineAt) - 5_000);
    if (timeoutMs < 1000) throw new DeadlineExceededError();
    const reviewed = await this.dispatch({
      sessionId,
      from: AGENT_IDS.A,
      to: AGENT_IDS.C,
      type: "review_request",
      payload: { contract, candidate: { id: candidate.id, result: candidate.result }, preflight, timeoutMs },
      correlationId: contract.id,
      timeoutMs: timeoutMs + 500,
      operation
    });
    return { ...candidate, review: reviewed.review, reviewRun: reviewed.run };
  }

  async decide({ sessionId, contract, candidates, failures, deadlineAt, operation }) {
    assertActive(operation);
    const timeoutMs = Math.min(8_000, Math.max(0, remainingMs(deadlineAt) - 1000));
    const decision = await this.agents.a.decide({ contract: { id: contract.id, hash: contract.hash, risk: contract.risk }, candidates, failures, maxFailures: this.maxFailures, timeoutMs });
    assertActive(operation);
    await this.memory.appendEvent({ sessionId, type: "a_decision", agentId: AGENT_IDS.A, runId: decision.run?.runId, payload: { contractId: contract.id, decision, candidates: candidates.map((item) => ({ id: item.id, branch: item.branch, review: item.review })) } });
    return decision;
  }

  async recordAccepted({ sessionId, contract, candidate, failures, decision, operation }) {
    assertActive(operation);
    await this.memory.appendEvent({ sessionId, type: "accepted_response", payload: { contract, candidate: candidateView(candidate), review: candidate.review, decision, failures } });
    assertActive(operation);
    await this.memory.appendCrystal({
      sessionId,
      type: "accepted_case",
      payload: { contractId: contract.id, contractHash: contract.hash, language: contract.language, risk: contract.risk, requirements: contract.demand.requirements, citations: candidate.result.citations || [], failures }
    });
    assertActive(operation);
    void this.governor?.recordOutcome({
      outcome: failures ? "accepted_after_rework" : "accepted_first_pass",
      riskLevel: contract.risk.level,
      sessionId,
      evidenceIds: (candidate.result.citations || []).map((item) => item.filename).filter(Boolean),
      stageSample: {
        outcome: failures ? "accepted_after_rework" : "accepted_first_pass",
        contractHash: contract.hash,
        riskLevel: contract.risk.level,
        riskFlags: contract.risk.flags,
        failures,
        selectedBranch: candidate.branch,
        issueCodes: (candidate.review.issues || []).map((item) => item.code),
        decisionReasons: decision.reasonCodes || []
      }
    }).catch(() => {});
  }

  async answer(input) {
    const professional = Boolean(input.options?.professionalConsultation);
    const budgetMs = professional
      ? Number(this.config.THOUGHT_PROFESSIONAL_DEADLINE_MS || 90_000)
      : Number(this.config.THOUGHT_NORMAL_DEADLINE_MS || 40_000);
    const operation = { deadlineAt: Date.now() + budgetMs, cancelled: false };
    try {
      return await withinDeadline(this.answerWithinDeadline({ ...input, deadlineAt: operation.deadlineAt, operation }), budgetMs, operation);
    } catch (error) {
      if (!isDeadlineError(error)) throw error;
      operation.cancelled = true;
      const contract = this.agents.a.compileContract({ message: input.message, session: input.session || {}, options: input.options || {} });
      void this.memory.appendEvent({ sessionId: input.sessionId, type: "reply_timeout", agentId: AGENT_IDS.A, payload: { contractId: contract.id, professional, budgetMs } }).catch(() => {});
      return {
        action: "answer",
        answer: timeoutAnswer(contract, professional),
        grounded: false,
        citations: [],
        timedOut: true
      };
    }
  }

  async answerWithinDeadline({ message, identity, session = {}, sessionId, options = {}, deadlineAt, operation }) {
    assertActive(operation);
    const contract = this.agents.a.compileContract({ message, session, options });
    const playbookPrompt = await loadAutonomyPrompt(this.playbookDir, message);
    assertActive(operation);
    await this.memory.appendEvent({ sessionId, type: "customer_input", payload: { message, identity: { tenantId: identity.tenantId }, contract, options } });
    assertActive(operation);

    let initial = await this.generate({ message, identity, session, sessionId, contract, playbookPrompt, deadlineAt, operation });
    if (initial.result.action && initial.result.action !== "answer") {
      await this.memory.appendEvent({ sessionId, type: "provider_controlled_response", payload: { contractId: contract.id, action: initial.result.action, producedBy: initial.producedBy } });
      return initial.result;
    }
    initial = await this.review({ sessionId, contract, candidate: initial, deadlineAt, operation });
    let failures = initial.review.decision === "pass" ? 0 : 1;
    let candidates = [initial];
    let decision = await this.decide({ sessionId, contract, candidates, failures, deadlineAt, operation });

    if (decision.action === "publish") {
      const selected = candidates.find((item) => item.id === decision.selectedCandidateId);
      session.thought = sessionThoughtState(contract, failures);
      void this.recordAccepted({ sessionId, contract, candidate: selected, failures, decision, operation }).catch(() => {});
      return this.policyEngine.publicProduct(selected);
    }

    let priorCandidate = initial.result.answer;
    let issues = publicIssues(initial.review);
    await this.memory.appendEvent({ sessionId, type: "failed_review_round", payload: { contractId: contract.id, failures, candidates: candidates.map((item) => ({ ...candidateView(item), review: item.review })) } });

    while (decision.action === "rework" && failures < this.maxFailures) {
      const generated = await Promise.all([
        this.generate({ message, identity, session, sessionId, contract, playbookPrompt, deadlineAt, operation, branch: "fresh_1" }),
        this.generate({ message, identity, session, sessionId, contract, playbookPrompt, deadlineAt, operation, branch: "fresh_2" }),
        this.generate({ message, identity, session, sessionId, contract, playbookPrompt, deadlineAt, operation, branch: "repair", priorCandidate, issues })
      ]);
      candidates = await Promise.all(generated.map((candidate) => this.review({ sessionId, contract, candidate, deadlineAt, operation, forceIndependent: true })));
      const hasPassing = candidates.some((item) => item.review.decision === "pass");
      if (!hasPassing) failures += 1;
      decision = await this.decide({ sessionId, contract, candidates, failures, deadlineAt, operation });
      if (decision.action === "publish") {
        const selected = candidates.find((item) => item.id === decision.selectedCandidateId);
        await this.memory.appendEvent({ sessionId, type: "candidate_comparison", payload: { contractId: contract.id, candidates: candidates.map((item) => ({ ...candidateView(item), review: item.review })), decision } });
        assertActive(operation);
        session.thought = sessionThoughtState(contract, failures);
        void this.recordAccepted({ sessionId, contract, candidate: selected, failures, decision, operation }).catch(() => {});
        return this.policyEngine.publicProduct(selected);
      }
      const best = bestCandidate(candidates);
      priorCandidate = best.result.answer;
      issues = publicIssues(best.review);
      await this.memory.appendEvent({ sessionId, type: "failed_review_round", payload: { contractId: contract.id, failures, candidates: candidates.map((item) => ({ ...candidateView(item), review: item.review })), decision } });
    }

    const latest = bestCandidate(candidates);
    const handoffReport = {
      contractId: contract.id,
      contractHash: contract.hash,
      customerGoal: contract.demand.goal,
      confirmed: contract.demand.requirements.filter((item) => item.status === "confirmed"),
      provisional: contract.demand.requirements.filter((item) => item.status === "provisional"),
      conflicting: contract.demand.requirements.filter((item) => item.status === "conflicting"),
      unknowns: contract.demand.unknowns,
      risk: contract.risk,
      citations: latest?.result.citations || [],
      failureRounds: failures,
      lastIssues: latest ? publicIssues(latest.review) : issues,
      aDecision: decision,
      recommendedNextQuestions: contract.demand.unknowns.slice(0, 3)
    };
    assertActive(operation);
    await this.memory.appendEvent({ sessionId, type: "automatic_handoff", payload: handoffReport });
    assertActive(operation);
    await this.memory.appendCrystal({ sessionId, type: "handoff_summary", payload: handoffReport });
    assertActive(operation);
    void this.governor?.recordOutcome({
      outcome: "automatic_handoff",
      riskLevel: contract.risk.level,
      sessionId,
      signals: ["repeated_error"],
      evidenceIds: handoffReport.citations.map((item) => item.filename).filter(Boolean),
      stageSample: {
        outcome: "automatic_handoff",
        contractHash: contract.hash,
        riskLevel: contract.risk.level,
        riskFlags: contract.risk.flags,
        failures,
        issueCodes: handoffReport.lastIssues.map((item) => item.code),
        decisionReasons: decision.reasonCodes || []
      }
    }).catch(() => {});
    session.thought = sessionThoughtState(contract, failures);
    return {
      action: "handoff_required",
      answer: contract.language.output === "en"
        ? "I could not produce a sufficiently reliable answer after repeated review. I have organized the confirmed requirements, open questions, sources, and review issues for a human specialist to continue."
        : "经过多轮审核仍未能形成足够可靠的答复。我已整理已确认需求、待确认项、资料来源和审核问题，交由人工人员继续处理。",
      grounded: false,
      citations: [],
      handoffReport
    };
  }

  async analyzeStage(snapshot) {
    return this.bus.send({ from: AGENT_IDS.A, to: AGENT_IDS.D, type: "stage_snapshot", payload: snapshot, correlationId: snapshot.id || "stage" });
  }

  recordGovernanceSignal({ sessionId, signal, riskLevel = "critical" }) {
    return this.governor?.recordOutcome({ outcome: "governance_signal", riskLevel, sessionId, signals: [signal], validConversation: false });
  }
}
