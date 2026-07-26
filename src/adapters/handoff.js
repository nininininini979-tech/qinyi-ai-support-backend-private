import crypto from "node:crypto";

export class DemoHandoffAdapter {
  constructor() {
    this.tickets = new Map();
  }

  async create({ tenantId, userId, sessionId, reason, unresolvedQuestion, handoffReport }) {
    const idempotencyKey = `${tenantId}:${userId}:${sessionId}`;
    if (this.tickets.has(idempotencyKey)) return this.tickets.get(idempotencyKey);
    const ticket = {
      id: `DEMO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      status: "queued",
      reason,
      createdAt: new Date().toISOString(),
      // Demo only. A production adapter should send a reviewed, masked summary to Zendesk/Meiqia.
      preview: unresolvedQuestion.slice(0, 160),
      report: handoffReport ? {
        contractId: handoffReport.contractId,
        confirmed: handoffReport.confirmed,
        unknowns: handoffReport.unknowns,
        risk: handoffReport.risk,
        failureRounds: handoffReport.failureRounds,
        lastIssues: handoffReport.lastIssues,
        recommendedNextQuestions: handoffReport.recommendedNextQuestions
      } : undefined
    };
    this.tickets.set(idempotencyKey, ticket);
    return ticket;
  }
}
