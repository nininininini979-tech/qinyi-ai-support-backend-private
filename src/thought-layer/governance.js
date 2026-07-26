import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateStageTrigger({ completedConversations = 0, lastEvaluationAt, signals = [], now = new Date(), conversationThreshold = 100, dayThreshold = 7 }) {
  const elapsed = lastEvaluationAt ? now.getTime() - new Date(lastEvaluationAt).getTime() : Number.POSITIVE_INFINITY;
  const triggers = [];
  if (completedConversations >= conversationThreshold) triggers.push("conversation_threshold");
  if (elapsed >= dayThreshold * DAY_MS) triggers.push("weekly_schedule");
  for (const signal of signals) {
    if (["repeated_error", "major_complaint", "model_change", "knowledge_change"].includes(signal)) triggers.push(signal);
  }
  return {
    shouldCreateCandidate: triggers.length > 0,
    triggers: [...new Set(triggers)],
    activation: "human_approval_required",
    affectsRunningSessions: false
  };
}

export function createStageCandidate({ trigger, metrics, evidenceIds = [], currentVersion, analysis }) {
  return {
    id: `stage-candidate-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    status: "awaiting_human_approval",
    trigger,
    currentVersion,
    metrics,
    evidenceIds,
    analysis,
    requiredChecks: ["held_out_evaluation", "high_risk_regression", "latency_and_cost", "privacy_review", "rollback_target"],
    activationRule: "Never update a running session. Publish only after human approval."
  };
}

async function readState(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { completedConversations: 0, countedSessions: {}, outcomes: {}, risks: {}, samples: [], lastEvaluationAt: null };
    throw error;
  }
}

async function atomicJson(filename, value) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, filename);
}

export class NullStageGovernor {
  async initialize() {}
  async recordOutcome() { return null; }
  setStageAnalyzer() {}
  async close() {}
}

export class LocalStageGovernor {
  constructor({ directory, conversationThreshold = 100, dayThreshold = 7, stageAnalyzer }) {
    this.directory = directory;
    this.stateFile = path.join(directory, "stage-state.json");
    this.proposalDir = path.join(directory, "proposals");
    this.conversationThreshold = conversationThreshold;
    this.dayThreshold = dayThreshold;
    this.queue = Promise.resolve();
    this.scheduleTimer = null;
    this.stageAnalyzer = stageAnalyzer;
  }

  async initialize() {
    await fs.mkdir(this.proposalDir, { recursive: true, mode: 0o700 });
    await this.recordOutcome({ outcome: null, validConversation: false });
    this.scheduleTimer = setInterval(() => {
      void this.recordOutcome({ outcome: null, validConversation: false }).catch(() => {});
    }, DAY_MS);
    this.scheduleTimer.unref?.();
  }

  recordOutcome(input) {
    const run = () => this.recordOutcomeSerial(input);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  setStageAnalyzer(stageAnalyzer) {
    this.stageAnalyzer = stageAnalyzer;
  }

  async recordOutcomeSerial({ outcome, riskLevel = "low", evidenceIds = [], signals = [], currentVersion = "company-policy-v1", sessionId, validConversation = true, stageSample }) {
    const state = await readState(this.stateFile);
    if (!state.lastEvaluationAt) state.lastEvaluationAt = new Date().toISOString();
    state.countedSessions ||= {};
    state.samples ||= [];
    const sessionKey = sessionId ? crypto.createHash("sha256").update(String(sessionId)).digest("hex") : crypto.randomUUID();
    if (validConversation && !state.countedSessions[sessionKey]) {
      state.countedSessions[sessionKey] = true;
      state.completedConversations += 1;
    }
    if (outcome) {
      state.outcomes[outcome] = Number(state.outcomes[outcome] || 0) + 1;
      state.risks[riskLevel] = Number(state.risks[riskLevel] || 0) + 1;
    }
    if (stageSample) state.samples.push(stageSample);
    state.samples = state.samples.slice(-100);
    const trigger = evaluateStageTrigger({
      completedConversations: state.completedConversations,
      lastEvaluationAt: state.lastEvaluationAt,
      signals,
      conversationThreshold: this.conversationThreshold,
      dayThreshold: this.dayThreshold
    });
    let candidate = null;
    if (trigger.shouldCreateCandidate) {
      const snapshot = {
        id: `stage-snapshot-${crypto.randomUUID()}`,
        trigger,
        metrics: { completedConversations: state.completedConversations, outcomes: state.outcomes, risks: state.risks },
        evidenceIds,
        currentVersion,
        samples: state.samples
      };
      const analysis = this.stageAnalyzer ? await this.stageAnalyzer(snapshot) : undefined;
      candidate = createStageCandidate({
        trigger,
        metrics: snapshot.metrics,
        evidenceIds,
        currentVersion,
        analysis
      });
      await atomicJson(path.join(this.proposalDir, `${candidate.id}.json`), candidate);
      state.completedConversations = 0;
      state.countedSessions = {};
      state.outcomes = {};
      state.risks = {};
      state.samples = [];
      state.lastEvaluationAt = new Date().toISOString();
    }
    await atomicJson(this.stateFile, state);
    return candidate;
  }

  async close() {
    clearInterval(this.scheduleTimer);
    await this.queue;
  }
}

export async function createStageGovernor(config, rootDir) {
  if (!config.THOUGHT_MEMORY_ENABLED) return new NullStageGovernor();
  const directory = path.resolve(rootDir, config.THOUGHT_MEMORY_DIR || "data/runtime/thought-layer", "governance");
  const governor = new LocalStageGovernor({
    directory,
    conversationThreshold: config.THOUGHT_STAGE_CONVERSATIONS || 100,
    dayThreshold: config.THOUGHT_STAGE_DAYS || 7
  });
  await governor.initialize();
  return governor;
}
