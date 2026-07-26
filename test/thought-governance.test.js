import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStageGovernor, evaluateStageTrigger } from "../src/thought-layer/governance.js";

test("D creates candidates at stage boundaries but never activates them", () => {
  const trigger = evaluateStageTrigger({
    completedConversations: 100,
    lastEvaluationAt: new Date().toISOString(),
    conversationThreshold: 100
  });
  assert.equal(trigger.shouldCreateCandidate, true);
  assert.equal(trigger.activation, "human_approval_required");
  assert.equal(trigger.affectsRunningSessions, false);
});

test("local D writes a human-approval candidate after the configured conversation count", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-stage-governor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const governor = new LocalStageGovernor({ directory, conversationThreshold: 2, dayThreshold: 7 });
  await governor.initialize();
  assert.equal(await governor.recordOutcome({ outcome: "accepted_first_pass" }), null);
  const candidate = await governor.recordOutcome({ outcome: "accepted_after_rework", riskLevel: "high" });
  assert.equal(candidate.status, "awaiting_human_approval");
  const files = await fs.readdir(path.join(directory, "proposals"));
  assert.equal(files.length, 1);
});

test("local D waits for queued writes before closing", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-stage-close-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const governor = new LocalStageGovernor({ directory });
  await governor.initialize();

  void governor.recordOutcome({ outcome: "accepted_first_pass" });
  await governor.close();

  const state = JSON.parse(await fs.readFile(path.join(directory, "stage-state.json"), "utf8"));
  assert.equal(state.completedConversations, 1);
});

test("D counts a multi-turn session once toward the conversation threshold", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-stage-session-count-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const governor = new LocalStageGovernor({ directory, conversationThreshold: 2, dayThreshold: 7 });
  await governor.initialize();
  await governor.recordOutcome({ outcome: "accepted_first_pass", sessionId: "same-session" });
  await governor.recordOutcome({ outcome: "accepted_first_pass", sessionId: "same-session" });
  const state = JSON.parse(await fs.readFile(path.join(directory, "stage-state.json"), "utf8"));
  assert.equal(state.completedConversations, 1);
});

test("D Agent analysis is attached to a stage proposal", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-stage-agent-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let snapshot;
  const governor = new LocalStageGovernor({
    directory,
    conversationThreshold: 2,
    stageAnalyzer: async (value) => {
      snapshot = value;
      return { summary: "D 独立分析", proposedBy: "agent-d" };
    }
  });
  await governor.initialize();
  await governor.recordOutcome({ outcome: "accepted_first_pass", sessionId: "one", stageSample: { outcome: "accepted_first_pass", issueCodes: [] } });
  const candidate = await governor.recordOutcome({ outcome: "accepted_first_pass", sessionId: "two", stageSample: { outcome: "accepted_first_pass", issueCodes: ["example"] } });
  assert.equal(candidate.analysis.summary, "D 独立分析");
  assert.equal(candidate.analysis.proposedBy, "agent-d");
  assert.equal(snapshot.samples.length, 2);
});
