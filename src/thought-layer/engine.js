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

  async dispatch({ sessionId, from, to, type, payload, correlationId }) {
    const response = await this.bus.send({ from, to, type, payload, correlationId });
    await this.memory.appendEvent({
      sessionId,
      type: "agent_communication",
      agentId: to,
      correlationId,
      payload: { from, to, messageType: type, responseAgent: response?.producedBy || response?.reviewedBy || response?.proposedBy }
    });
    return response;
  }

  async generate({ message, identity, session, sessionId, contract, playbookPrompt, branch = "initial", priorCandidate, issues }) {
    const workOrder = this.agents.a.createWorkOrder({ message, identity, session, contract, playbookPrompt, branch, priorCandidate, issues });
    return this.dispatch({ sessionId, from: AGENT_IDS.A, to: AGENT_IDS.B, type: "work_order", payload: workOrder, correlationId: contract.id });
  }

  async review({ sessionId, contract, candidate, forceIndependent = false }) {
    const preflight = this.policyEngine.preflight({ contract, candidate });
    if (!this.policyEngine.requiresIndependentC({ contract, preflight, forceIndependent })) {
      return { ...candidate, review: preflight, reviewedBy: "company-policy" };
    }
    const reviewed = await this.dispatch({
      sessionId,
      from: AGENT_IDS.A,
      to: AGENT_IDS.C,
      type: "review_request",
      payload: { contract, candidate: { id: candidate.id, result: candidate.result }, preflight },
      correlationId: contract.id
    });
    return { ...candidate, review: reviewed.review, reviewRun: reviewed.run };
  }

  async decide({ sessionId, contract, candidates, failures }) {
    const decision = await this.agents.a.decide({ contract: { id: contract.id, hash: contract.hash, risk: contract.risk }, candidates, failures, maxFailures: this.maxFailures });
    await this.memory.appendEvent({ sessionId, type: "a_decision", agentId: AGENT_IDS.A, runId: decision.run?.runId, payload: { contractId: contract.id, decision, candidates: candidates.map((item) => ({ id: item.id, branch: item.branch, review: item.review })) } });
    return decision;
  }

  async recordAccepted({ sessionId, contract, candidate, failures, decision }) {
    await this.memory.appendEvent({ sessionId, type: "accepted_response", payload: { contract, candidate: candidateView(candidate), review: candidate.review, decision, failures } });
    await this.memory.appendCrystal({
      sessionId,
      type: "accepted_case",
      payload: { contractId: contract.id, contractHash: contract.hash, language: contract.language, risk: contract.risk, requirements: contract.demand.requirements, citations: candidate.result.citations || [], failures }
    });
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

  async answer({ message, identity, session = {}, sessionId, options = {} }) {
    const contract = this.agents.a.compileContract({ message, session, options });
    const playbookPrompt = await loadAutonomyPrompt(this.playbookDir, message);
    await this.memory.appendEvent({ sessionId, type: "customer_input", payload: { message, identity: { tenantId: identity.tenantId }, contract, options } });

    let initial = await this.generate({ message, identity, session, sessionId, contract, playbookPrompt });
    if (initial.result.action && initial.result.action !== "answer") {
      await this.memory.appendEvent({ sessionId, type: "provider_controlled_response", payload: { contractId: contract.id, action: initial.result.action, producedBy: initial.producedBy } });
      return initial.result;
    }
    initial = await this.review({ sessionId, contract, candidate: initial });
    let failures = initial.review.decision === "pass" ? 0 : 1;
    let candidates = [initial];
    let decision = await this.decide({ sessionId, contract, candidates, failures });

    if (decision.action === "publish") {
      const selected = candidates.find((item) => item.id === decision.selectedCandidateId);
      session.thought = sessionThoughtState(contract, failures);
      await this.recordAccepted({ sessionId, contract, candidate: selected, failures, decision });
      return this.policyEngine.publicProduct(selected);
    }

    let priorCandidate = initial.result.answer;
    let issues = publicIssues(initial.review);
    await this.memory.appendEvent({ sessionId, type: "failed_review_round", payload: { contractId: contract.id, failures, candidates: candidates.map((item) => ({ ...candidateView(item), review: item.review })) } });

    while (decision.action === "rework" && failures < this.maxFailures) {
      const generated = await Promise.all([
        this.generate({ message, identity, session, sessionId, contract, playbookPrompt, branch: "fresh_1" }),
        this.generate({ message, identity, session, sessionId, contract, playbookPrompt, branch: "fresh_2" }),
        this.generate({ message, identity, session, sessionId, contract, playbookPrompt, branch: "repair", priorCandidate, issues })
      ]);
      candidates = await Promise.all(generated.map((candidate) => this.review({ sessionId, contract, candidate, forceIndependent: true })));
      const hasPassing = candidates.some((item) => item.review.decision === "pass");
      if (!hasPassing) failures += 1;
      decision = await this.decide({ sessionId, contract, candidates, failures });
      if (decision.action === "publish") {
        const selected = candidates.find((item) => item.id === decision.selectedCandidateId);
        session.thought = sessionThoughtState(contract, failures);
        await this.memory.appendEvent({ sessionId, type: "candidate_comparison", payload: { contractId: contract.id, candidates: candidates.map((item) => ({ ...candidateView(item), review: item.review })), decision } });
        await this.recordAccepted({ sessionId, contract, candidate: selected, failures, decision });
        return this.policyEngine.publicProduct(selected);
      }
      const best = bestCandidate(candidates);
      priorCandidate = best.result.answer;
      issues = publicIssues(best.review);
      await this.memory.appendEvent({ sessionId, type: "failed_review_round", payload: { contractId: contract.id, failures, candidates: candidates.map((item) => ({ ...candidateView(item), review: item.review })), decision } });
    }

    const latest = bestCandidate(candidates);
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
      citations: latest?.result.citations || [],
      failureRounds: failures,
      lastIssues: latest ? publicIssues(latest.review) : issues,
      aDecision: decision,
      recommendedNextQuestions: contract.demand.unknowns.slice(0, 3)
    };
    await this.memory.appendEvent({ sessionId, type: "automatic_handoff", payload: handoffReport });
    await this.memory.appendCrystal({ sessionId, type: "handoff_summary", payload: handoffReport });
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
