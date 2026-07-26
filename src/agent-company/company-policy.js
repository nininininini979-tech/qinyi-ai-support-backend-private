import { reviewDeterministically } from "../thought-layer/reviewer.js";
import { riskAtLeast } from "../thought-layer/risk.js";

export class CompanyPolicyEngine {
  preflight({ contract, candidate }) {
    const result = candidate.result;
    return reviewDeterministically({
      candidate: result.answer,
      contract,
      citations: result.citations || [],
      grounded: Boolean(result.grounded)
    });
  }

  requiresIndependentC({ contract, preflight, forceIndependent = false }) {
    return forceIndependent || preflight.decision !== "pass" || riskAtLeast(contract.risk.level, "medium") || contract.risk.securityFlags.length > 0;
  }

  validatePublishDecision({ decision, candidates }) {
    if (decision.action !== "publish") return decision;
    const selected = candidates.find((item) => item.id === decision.selectedCandidateId);
    if (!selected) throw new Error("A selected a candidate that does not exist");
    if (selected.review?.decision !== "pass") throw new Error("Company policy forbids publishing a candidate that C did not pass");
    return decision;
  }

  publicProduct(candidate) {
    return candidate.result;
  }
}
