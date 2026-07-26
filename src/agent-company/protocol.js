import crypto from "node:crypto";

export const AGENT_IDS = Object.freeze({ A: "agent-a", B: "agent-b", C: "agent-c", D: "agent-d" });

const ROUTES = new Map([
  [`${AGENT_IDS.A}:${AGENT_IDS.B}`, new Set(["work_order"])],
  [`${AGENT_IDS.B}:${AGENT_IDS.A}`, new Set(["candidate"])],
  [`${AGENT_IDS.A}:${AGENT_IDS.C}`, new Set(["review_request"])],
  [`${AGENT_IDS.C}:${AGENT_IDS.A}`, new Set(["review_result"])],
  [`${AGENT_IDS.A}:${AGENT_IDS.D}`, new Set(["stage_snapshot"])],
  [`${AGENT_IDS.D}:${AGENT_IDS.A}`, new Set(["stage_proposal"])]
]);
const RESPONSE_TYPE = { work_order: "candidate", review_request: "review_result", stage_snapshot: "stage_proposal" };

export function createEnvelope({ from, to, type, payload, correlationId = crypto.randomUUID(), causationId, createdAt = new Date().toISOString() }) {
  const allowed = ROUTES.get(`${from}:${to}`);
  if (!allowed?.has(type)) throw new Error(`Agent route is forbidden: ${from} -> ${to} (${type})`);
  return Object.freeze({ id: crypto.randomUUID(), from, to, type, correlationId, causationId, createdAt, payload });
}

export class InProcessAgentBus {
  constructor({ eventSink } = {}) {
    this.agents = new Map();
    this.eventSink = eventSink;
  }

  register(agent) {
    if (!agent?.id || typeof agent.handle !== "function") throw new Error("Agent must expose id and handle(envelope)");
    if (this.agents.has(agent.id)) throw new Error(`Agent is already registered: ${agent.id}`);
    this.agents.set(agent.id, agent);
  }

  async send(input) {
    const envelope = createEnvelope(input);
    const recipient = this.agents.get(envelope.to);
    if (!recipient) throw new Error(`Agent is not registered: ${envelope.to}`);
    await this.eventSink?.({ direction: "request", envelope });
    const response = await recipient.handle(envelope);
    const responseEnvelope = createEnvelope({
      from: envelope.to,
      to: envelope.from,
      type: RESPONSE_TYPE[envelope.type],
      payload: response,
      correlationId: envelope.correlationId,
      causationId: envelope.id
    });
    await this.eventSink?.({ direction: "response", envelope: responseEnvelope });
    const responseRecipient = this.agents.get(responseEnvelope.to);
    if (!responseRecipient) throw new Error(`Response Agent is not registered: ${responseEnvelope.to}`);
    return responseRecipient.handle(responseEnvelope);
  }
}

export function agentRunMetadata({ agentId, profile, runId = crypto.randomUUID(), parentRunId, startedAt = new Date().toISOString() }) {
  return { agentId, runId, parentRunId, startedAt, provider: profile.provider, model: profile.model, charterVersion: profile.charterVersion };
}
