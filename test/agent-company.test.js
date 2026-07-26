import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { AgentApiWindow, agentApiProfile, createAgentApiWindows } from "../src/agent-company/api-windows.js";
import { AAgent, DAgent } from "../src/agent-company/agents.js";
import { CompanyPolicyEngine } from "../src/agent-company/company-policy.js";
import { AGENT_IDS, createEnvelope } from "../src/agent-company/protocol.js";
import { buildGenerationPrompt, buildReviewerPrompt } from "../src/thought-layer/prompts.js";
import { compileTaskContract } from "../src/thought-layer/contract.js";
import { ThoughtLayerEngine } from "../src/thought-layer/engine.js";

test("company protocol forbids B and C from communicating directly", () => {
  assert.throws(() => createEnvelope({ from: AGENT_IDS.B, to: AGENT_IDS.C, type: "review_request", payload: {} }), /forbidden/);
  assert.doesNotThrow(() => createEnvelope({ from: AGENT_IDS.A, to: AGENT_IDS.B, type: "work_order", payload: {} }));
});

test("B generation prompt does not contain A governance instructions", () => {
  const prompt = buildGenerationPrompt({ contract: compileTaskContract({ message: "介绍产品" }), evidenceBundle: { citations: [], evidence: [] } });
  assert.doesNotMatch(prompt, /制度性控制面|作出流程裁决/);
  assert.match(prompt, /产品经理型客服 B/);
});

test("C review prompt bounds and consolidates structured issues", () => {
  const prompt = buildReviewerPrompt({ contract: compileTaskContract({ message: "介绍定制拼图" }), candidate: "候选" });
  assert.match(prompt, /最多 4 项/);
  assert.match(prompt, /reason 不超过 80/);
});

test("four API windows have independent profiles and instances", () => {
  const config = loadConfig({ NODE_ENV: "test", SUPPORT_PROVIDER: "mock" });
  const windows = createAgentApiWindows(config, { b: {}, c: {} });
  assert.notEqual(windows.a, windows.b);
  assert.notEqual(windows.b, windows.c);
  assert.notEqual(windows.c, windows.d);
  assert.deepEqual(["a", "b", "c", "d"].map((role) => agentApiProfile(config, role).role), ["a", "b", "c", "d"]);
});

test("remote Agent API windows require their own key", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "test", SUPPORT_PROVIDER: "mock", AGENT_C_PROVIDER: "openai-compatible" }), /AGENT_C_API_KEY/);
});

test("company policy prevents A from publishing a candidate rejected by C", async () => {
  const window = {
    isRemote: true,
    profile: { provider: "openai-compatible", model: "a-test", charterVersion: "a-v1" },
    async invoke() { return '{"action":"publish","selectedCandidateId":"failed"}'; }
  };
  const a = new AAgent({ window, policyEngine: new CompanyPolicyEngine() });
  const candidates = [{ id: "failed", review: { decision: "fail", score: 10 } }];
  const decision = await a.decide({ candidates, failures: 1, maxFailures: 3, timeoutMs: 5000 });
  assert.equal(decision.action, "rework");
  assert.ok(decision.reasonCodes.includes("company_stop_condition_enforced"));
});

test("company stop conditions prevent A from handing off before three failed rounds", async () => {
  const window = {
    isRemote: true,
    profile: { provider: "openai-compatible", model: "a-test", charterVersion: "a-v1" },
    async invoke() { return '{"action":"handoff","reasonCodes":["remote_choice"]}'; }
  };
  const a = new AAgent({ window, policyEngine: new CompanyPolicyEngine() });
  const candidates = [{ id: "failed", review: { decision: "fail", score: 10 } }];
  const decision = await a.decide({ candidates, failures: 1, maxFailures: 3, timeoutMs: 5000 });
  assert.equal(decision.action, "rework");
  assert.ok(decision.reasonCodes.includes("company_stop_condition_enforced"));
});

test("company stop conditions prevent A from reworking an already passing candidate", async () => {
  const window = {
    isRemote: true,
    profile: { provider: "openai-compatible", model: "a-test", charterVersion: "a-v1" },
    async invoke() { return '{"action":"rework","reasonCodes":["remote_choice"]}'; }
  };
  const a = new AAgent({ window, policyEngine: new CompanyPolicyEngine() });
  const candidates = [{ id: "passed", review: { decision: "pass", score: 95 } }];
  const decision = await a.decide({ candidates, failures: 0, maxFailures: 3, timeoutMs: 5000 });
  assert.equal(decision.action, "publish");
  assert.equal(decision.selectedCandidateId, "passed");
});

test("contract exposes an empty C2 and keeps approximate quantities provisional", () => {
  const contract = compileTaskContract({ message: "大约500套礼品拼图" });
  assert.deepEqual(contract.c2, {});
  assert.equal(contract.demand.requirements.find((item) => item.kind === "procurement_quantity")?.status, "provisional");
});

test("ordinary low-risk work runs B without dispatching C", async () => {
  const events = [];
  const memory = {
    async appendEvent(event) { events.push(event); },
    async appendCrystal() {}
  };
  const provider = {
    async answer() { return { action: "answer", answer: "可先依据已审核目录整理产品方向。", grounded: true, citations: [{ filename: "catalog.md" }] }; },
    async review() { throw new Error("C must not run for an ordinary passing response"); }
  };
  const engine = new ThoughtLayerEngine({
    config: { THOUGHT_REVIEW_MAX_FAILURES: 3 },
    provider,
    playbookDir: path.resolve("service-playbook"),
    memory
  });
  await engine.answer({ message: "介绍产品", identity: { tenantId: "t", userId: "u" }, sessionId: "s", session: { history: [] } });
  const routes = events.filter((item) => item.type === "agent_communication").map((item) => item.payload.to);
  assert.deepEqual(routes, [AGENT_IDS.B]);
});

test("D remote request explicitly asks for JSON", async () => {
  let request;
  const window = {
    isRemote: true,
    profile: { provider: "openai-compatible", model: "d-test", charterVersion: "d-v1" },
    async invoke(input) {
      request = input;
      return '{"summary":"ok","directions":[],"proposedChanges":[]}';
    }
  };
  await new DAgent({ window }).handle({ from: AGENT_IDS.A, type: "stage_snapshot", payload: { samples: [] } });
  assert.match(request.userPrompt, /JSON/);
  assert.equal(request.json, true);
});

test("D keeps its fixed proposal contract when a remote API echoes the snapshot", async () => {
  const window = {
    isRemote: true,
    profile: { provider: "openai-compatible", model: "d-test", charterVersion: "d-v1" },
    async invoke() { return '{"metrics":{},"samples":[]}'; }
  };
  const result = await new DAgent({ window }).handle({ from: AGENT_IDS.A, type: "stage_snapshot", payload: { samples: [{ outcome: "automatic_handoff", issueCodes: ["missing_evidence"] }] } });
  assert.match(result.summary, /1 个脱敏样本/);
  assert.ok(result.directions.length > 0);
  assert.deepEqual(result.proposedChanges, []);
});

test("Agent API window applies per-call timeout and token budgets", async () => {
  let captured;
  const window = new AgentApiWindow({ profile: { role: "b", provider: "openai-compatible", apiKey: "test", baseURL: "https://example.com", model: "test", charterVersion: "v1" } });
  window.client = { chat: { completions: { async create(params, options) { captured = { params, options }; return { choices: [{ message: { content: "ok" } }] }; } } } };
  await window.invoke({ systemPrompt: "system", userPrompt: "user", timeoutMs: 4321, maxTokens: 321 });
  assert.equal(captured.params.max_tokens, 321);
  assert.equal(captured.options.timeout, 4321);
});

test("inherited Agent API window aborts the provider at its per-call deadline", async () => {
  let observedSignal;
  const window = new AgentApiWindow({
    profile: { role: "b", provider: "inherit", model: "test", charterVersion: "v1" },
    legacyAdapter: {
      answer: ({ signal }) => new Promise((resolve, reject) => {
        observedSignal = signal;
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      })
    }
  });
  await assert.rejects(window.invoke({ legacyMethod: "answer", legacyInput: {}, timeoutMs: 10 }), { name: "AbortError" });
  assert.equal(observedSignal.aborted, true);
});
