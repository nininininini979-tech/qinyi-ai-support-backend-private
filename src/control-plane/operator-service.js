const MODES = new Set(["observe", "draft", "auto", "paused"]);

export class OperatorControlPlane {
  constructor({ mode = "auto", agents = {} } = {}) {
    if (!MODES.has(mode)) throw new Error(`Unsupported operator mode: ${mode}`);
    this.mode = mode;
    this.agents = agents;
  }

  status() {
    return {
      mode: this.mode,
      agentCompany: Object.fromEntries(Object.entries(this.agents).map(([role, agent]) => [role, {
        id: agent.id,
        provider: agent.profile.provider,
        model: agent.profile.model,
        charterVersion: agent.profile.charterVersion
      }])),
      controls: ["pause", "resume", "draft_only", "automatic_routine", "human_takeover", "approve_stage_proposal", "rollback"]
    };
  }

  setMode(mode) {
    if (!MODES.has(mode)) throw new Error(`Unsupported operator mode: ${mode}`);
    this.mode = mode;
    return this.status();
  }
}
