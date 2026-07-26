import OpenAI from "openai";

const ROLE_PREFIX = { a: "AGENT_A", b: "AGENT_B", c: "AGENT_C", d: "AGENT_D" };
const DEFAULT_PROVIDER = { a: "mock", b: "inherit", c: "inherit", d: "mock" };

export function agentApiProfile(config, role) {
  const prefix = ROLE_PREFIX[role];
  if (!prefix) throw new Error(`Unknown agent API role: ${role}`);
  return Object.freeze({
    role,
    provider: config[`${prefix}_PROVIDER`] || DEFAULT_PROVIDER[role],
    apiKey: config[`${prefix}_API_KEY`],
    baseURL: config[`${prefix}_BASE_URL`],
    model: config[`${prefix}_MODEL`] || `${role}-local-placeholder`,
    charterVersion: config[`${prefix}_CHARTER_VERSION`] || `${role}-charter-v1`
  });
}

export class AgentApiWindow {
  constructor({ profile, legacyAdapter }) {
    this.profile = profile;
    this.legacyAdapter = legacyAdapter;
    this.client = profile.provider === "openai-compatible"
      ? new OpenAI({ apiKey: profile.apiKey, baseURL: profile.baseURL, timeout: 30_000, maxRetries: 1 })
      : null;
  }

  get isRemote() {
    return Boolean(this.client);
  }

  async invoke({ systemPrompt, userPrompt, json = false, legacyMethod, legacyInput }) {
    if (this.profile.provider === "mock") return null;
    if (this.profile.provider === "inherit") {
      if (!this.legacyAdapter || typeof this.legacyAdapter[legacyMethod] !== "function") {
        throw new Error(`Agent ${this.profile.role.toUpperCase()} has no inherited ${legacyMethod} adapter`);
      }
      return this.legacyAdapter[legacyMethod](legacyInput);
    }
    const completion = await this.client.chat.completions.create({
      model: this.profile.model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0,
      max_tokens: 1200,
      ...(json ? { response_format: { type: "json_object" } } : {})
    });
    return completion.choices?.[0]?.message?.content || "";
  }
}

export function createAgentApiWindows(config, adapters = {}) {
  return Object.fromEntries(["a", "b", "c", "d"].map((role) => [
    role,
    new AgentApiWindow({ profile: agentApiProfile(config, role), legacyAdapter: adapters[role] })
  ]));
}
