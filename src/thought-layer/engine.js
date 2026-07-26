import { loadAutonomyPrompt } from "../support/playbook.js";
import { buildGenerationPrompt, buildReviewerPrompt } from "./prompts.js";
import { compileTaskContract, sessionThoughtState } from "./contract.js";
import { combineReviews, parseModelReview, reviewDeterministically } from "./reviewer.js";
import { riskAtLeast } from "./risk.js";

function candidateView(result) {
  return {
    answer: result.answer,
    grounded: Boolean(result.grounded),
    citations: result.citations || [],
    evidence: result.reviewEvidence || []
  };
}

function publicIssues(review) {
  return review.issues.map(({ code, severity, reason, repairConstraint }) => ({ code, severity, reason, repairConstraint }));
}

function chooseBest(items) {
  return [...items].sort((left, right) => right.review.score - left.review.score)[0];
}

export class ThoughtLayerEngine {
  constructor({ config, provider, playbookDir, memory, governor }) {
    this.config = config;
    this.provider = provider;
    this.playbookDir = playbookDir;
    this.memory = memory;
    this.governor = governor;
    this.maxFailures = Number(config.THOUGHT_REVIEW_MAX_FAILURES || 3);
  }

  async generate({ message, identity, session, contract, playbookPrompt, branch = "initial", priorCandidate, issues }) {
    const generationPrompt = buildGenerationPrompt({ contract, playbookPrompt, branch, priorCandidate, issues });
    return this.provider.answer({
      message,
      identity,
      session,
      thoughtContext: { contract, generationPrompt, branch, externalReview: true }
    });
  }

  async review({ contract, result, forceIndependent = false }) {
    const view = candidateView(result);
    const deterministic = reviewDeterministically({ candidate: view.answer, contract, citations: view.citations, grounded: view.grounded });
    const needsIndependent = forceIndependent || deterministic.decision !== "pass" || riskAtLeast(contract.risk.level, "medium") || contract.risk.securityFlags.length > 0;
    if (!needsIndependent) return deterministic;

    if (typeof this.provider.review !== "function") {
      return combineReviews(deterministic, {
        decision: contract.risk.level === "low" ? "pass" : "escalate",
        score: deterministic.score,
        issues: contract.risk.level === "low" ? [] : [{ code: "independent_reviewer_unavailable", severity: "fatal", reason: "当前提供方没有独立审核能力。", repairConstraint: "转人工或启用独立审核器。" }]
      });
    }

    const reviewPrompt = buildReviewerPrompt({ contract, candidate: view.answer, citations: view.citations, evidence: view.evidence });
    const independent = parseModelReview(await this.provider.review({ contract, candidate: view.answer, reviewPrompt }));
    return combineReviews(deterministic, independent);
  }

  async recordAccepted({ sessionId, contract, result, review, failures }) {
    await this.memory.appendEvent({ sessionId, type: "accepted_response", payload: { contract, result: candidateView(result), review, failures } });
    await this.memory.appendCrystal({
      sessionId,
      type: "accepted_case",
      payload: { contractId: contract.id, contractHash: contract.hash, language: contract.language, risk: contract.risk, requirements: contract.demand.requirements, citations: result.citations || [], failures }
    });
    void this.governor?.recordOutcome({
      outcome: failures ? "accepted_after_rework" : "accepted_first_pass",
      riskLevel: contract.risk.level,
      sessionId,
      evidenceIds: (result.citations || []).map((item) => item.filename).filter(Boolean)
    }).catch(() => {});
  }

  async answer({ message, identity, session = {}, sessionId, options = {} }) {
    const contract = compileTaskContract({ message, session, options });
    const playbookPrompt = await loadAutonomyPrompt(this.playbookDir, message);
    await this.memory.appendEvent({ sessionId, type: "customer_input", payload: { message, identity: { tenantId: identity.tenantId }, contract, options } });

    let result = await this.generate({ message, identity, session, contract, playbookPrompt });
    if (result.action && result.action !== "answer") {
      await this.memory.appendEvent({ sessionId, type: "provider_controlled_response", payload: { contractId: contract.id, action: result.action } });
      return result;
    }
    let review = await this.review({ contract, result });
    let failures = review.decision === "pass" ? 0 : 1;

    if (review.decision === "pass") {
      session.thought = sessionThoughtState(contract, failures);
      await this.recordAccepted({ sessionId, contract, result, review, failures });
      return result;
    }

    let priorCandidate = result.answer;
    let latestResult = result;
    let issues = publicIssues(review);
    await this.memory.appendEvent({ sessionId, type: "failed_review_round", payload: { contractId: contract.id, failures, reviewed: [{ branch: "initial", result: candidateView(result), review }] } });
    while (failures < this.maxFailures) {
      const branches = await Promise.all([
        this.generate({ message, identity, session, contract, playbookPrompt, branch: "fresh_1" }),
        this.generate({ message, identity, session, contract, playbookPrompt, branch: "fresh_2" }),
        this.generate({ message, identity, session, contract, playbookPrompt, branch: "repair", priorCandidate, issues })
      ]);
      const reviewed = await Promise.all(branches.map(async (candidate, index) => ({
        branch: ["fresh_1", "fresh_2", "repair"][index],
        result: candidate,
        review: await this.review({ contract, result: candidate, forceIndependent: true })
      })));
      const passing = reviewed.filter((item) => item.review.decision === "pass");
      if (passing.length) {
        const selected = chooseBest(passing);
        session.thought = sessionThoughtState(contract, failures);
        await this.memory.appendEvent({ sessionId, type: "candidate_comparison", payload: { contractId: contract.id, reviewed: reviewed.map((item) => ({ branch: item.branch, result: candidateView(item.result), review: item.review })), selected: selected.branch } });
        await this.recordAccepted({ sessionId, contract, result: selected.result, review: selected.review, failures });
        return selected.result;
      }
      failures += 1;
      const best = chooseBest(reviewed);
      latestResult = best.result;
      priorCandidate = best.result.answer;
      issues = publicIssues(best.review);
      await this.memory.appendEvent({ sessionId, type: "failed_review_round", payload: { contractId: contract.id, failures, reviewed: reviewed.map((item) => ({ branch: item.branch, result: candidateView(item.result), review: item.review })) } });
    }

    session.thought = sessionThoughtState(contract, failures);
    const handoffReport = {
      contractId: contract.id,
      contractHash: contract.hash,
      customerGoal: contract.demand.goal,
      confirmed: contract.demand.requirements.filter((item) => item.status === "confirmed"),
      provisional: contract.demand.requirements.filter((item) => item.status === "provisional"),
      conflicting: contract.demand.requirements.filter((item) => item.status === "conflicting"),
      unknowns: contract.demand.unknowns,
      risk: contract.risk,
      citations: latestResult.citations || [],
      failureRounds: failures,
      lastIssues: issues,
      recommendedNextQuestions: contract.demand.unknowns.slice(0, 3)
    };
    await this.memory.appendEvent({ sessionId, type: "automatic_handoff", payload: handoffReport });
    await this.memory.appendCrystal({ sessionId, type: "handoff_summary", payload: handoffReport });
    void this.governor?.recordOutcome({ outcome: "automatic_handoff", riskLevel: contract.risk.level, sessionId, signals: ["repeated_error"], evidenceIds: handoffReport.citations.map((item) => item.filename).filter(Boolean) }).catch(() => {});
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

  recordGovernanceSignal({ sessionId, signal, riskLevel = "critical" }) {
    return this.governor?.recordOutcome({ outcome: "governance_signal", riskLevel, sessionId, signals: [signal], validConversation: false });
  }
}
