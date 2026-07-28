import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { FileOperationsStore } from "../src/operations/store.js";
import { OperationsService } from "../src/operations/service.js";
import { registerWorkflowRoutes } from "../src/operations/workflow-routes.js";

const ACCOUNTS = [
  { username: "admin01", displayName: "管理员1", role: "administrator" },
  { username: "admin02", displayName: "管理员2", role: "administrator" },
  { username: "admin03", displayName: "管理员3", role: "administrator" },
  { username: "admin04", displayName: "管理员4", role: "administrator" },
  { username: "developer01", displayName: "开发者1", role: "developer" }
];

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-workflows-"));
  const store = await new FileOperationsStore({ directory }).init();
  const service = new OperationsService({ store });
  const auth = {
    async listAccounts() { return ACCOUNTS; },
    async authenticate(token) {
      const account = ACCOUNTS.find((item) => item.username === token);
      return account ? { ...account, id: account.username } : null;
    }
  };
  const app = Fastify();
  await registerWorkflowRoutes(app, { service, auth });
  t.after(async () => {
    await app.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { app, service, store };
}

function headers(username) {
  return { authorization: `Bearer ${username}` };
}

async function createHandoff(service) {
  const identity = { tenantId: "public", visitorId: "visitor", sessionId: "session" };
  const exchange = await service.recordExchange({
    ...identity, message: "需要文件检查和人工服务",
    result: { action: "answer", answer: "我会继续提供 AI 建议。", citations: [] }
  });
  const handoff = await service.createHandoff({
    ...identity, reason: "explicit_request", unresolvedQuestion: "需要人工"
  });
  return { identity, exchange, handoff };
}

test("handoff transfer requires target confirmation and keeps the whole conversation and attachments", async (t) => {
  const { app, service, store } = await fixture(t);
  const { identity, exchange, handoff } = await createHandoff(service);

  let response = await app.inject({ method: "POST", url: `/api/admin/handoffs/${handoff.id}/claim`, headers: headers("admin01") });
  assert.equal(response.statusCode, 200);
  response = await app.inject({
    method: "POST", url: `/api/admin/conversations/${exchange.conversationId}/attachment-metadata`, headers: headers("admin01"),
    payload: { filename: "proof.pdf", mimeType: "application/pdf", size: 1024, storageKey: "private/proof.pdf" }
  });
  assert.equal(response.statusCode, 201);
  response = await app.inject({
    method: "POST", url: `/api/admin/handoffs/${handoff.id}/internal-notes`, headers: headers("admin01"),
    payload: { content: "请美工检查出血线，此备注不得给访客。" }
  });
  assert.equal(response.statusCode, 201);
  response = await app.inject({
    method: "POST", url: `/api/admin/handoffs/${handoff.id}/transfers`, headers: headers("admin01"),
    payload: { targetUsername: "admin02", internalNote: "请接续处理美工问题。" }
  });
  assert.equal(response.statusCode, 201);
  const transferId = response.json().id;
  assert.equal((await service.listNotifications({ status: "pending", recipientUsername: "admin01" })).filter((item) => item.type === "handoff_transfer_requested").length, 0);
  assert.equal((await service.listNotifications({ status: "pending", recipientUsername: "admin02" })).filter((item) => item.type === "handoff_transfer_requested").length, 1);
  assert.equal((await service.listNotifications({ status: "pending", recipientUsername: "admin03" })).filter((item) => item.type === "handoff_transfer_requested").length, 0);

  assert.equal((await app.inject({
    method: "POST", url: `/api/admin/handoff-transfers/${transferId}/accept`, headers: headers("admin03"), payload: {}
  })).statusCode, 409);
  response = await app.inject({
    method: "POST", url: `/api/admin/handoff-transfers/${transferId}/accept`, headers: headers("admin02"), payload: {}
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().handoff.assigneeUsername, "admin02");
  assert.equal((await service.listNotifications({ status: "pending", recipientUsername: "admin02" })).filter((item) => item.type === "handoff_transfer_requested").length, 0);
  assert.equal((await service.listNotifications({ status: "dismissed", recipientUsername: "admin02" })).filter((item) => item.type === "handoff_transfer_requested").length, 1);

  const conversation = await service.getConversation(exchange.conversationId);
  assert.equal(conversation.attachments.length, 1);
  assert.ok(conversation.messages.some((item) => item.content === "需要文件检查和人工服务"));
  assert.ok(conversation.messages.some((item) => /已移交/.test(item.content)));
  await service.addHumanMessage({
    conversationId: exchange.conversationId, content: "我已查看附件。", actor: "管理员2", actorUsername: "admin02"
  });

  const publicEvents = await service.ticketEvents({ ...identity, ticketId: handoff.id });
  const publicJson = JSON.stringify(publicEvents);
  assert.doesNotMatch(publicJson, /出血线|接续处理|admin0[12]|管理员[12]/);
  assert.match(publicJson, /已移交/);

  const audit = await store.listEvents({ kind: "audit", limit: 100 });
  assert.ok(audit.some((item) => item.action === "handoff.transfer_requested"));
  assert.ok(audit.some((item) => item.action === "handoff.transfer_accepted"));
  assert.doesNotMatch(JSON.stringify(audit), /出血线|接续处理/);
});

test("a transfer target can forward or return a request without changing the original assignment", async (t) => {
  const { app, service } = await fixture(t);
  const { handoff } = await createHandoff(service);
  await app.inject({ method: "POST", url: `/api/admin/handoffs/${handoff.id}/claim`, headers: headers("admin01") });
  let response = await app.inject({
    method: "POST", url: `/api/admin/handoffs/${handoff.id}/transfers`, headers: headers("admin01"),
    payload: { targetUsername: "admin02" }
  });
  const firstTransferId = response.json().id;
  response = await app.inject({
    method: "POST", url: `/api/admin/handoff-transfers/${firstTransferId}/forward`, headers: headers("admin02"),
    payload: { targetUsername: "admin03", internalNote: "由管理员3处理" }
  });
  assert.equal(response.statusCode, 201);
  const forwardedId = response.json().id;
  assert.equal((await service.listNotifications({ status: "pending", recipientUsername: "admin02" })).filter((item) => item.type === "handoff_transfer_requested").length, 0);
  const forwardedNotices = (await service.listNotifications({ status: "pending", recipientUsername: "admin03" })).filter((item) => item.type === "handoff_transfer_requested");
  assert.equal(forwardedNotices.length, 1);
  assert.equal(forwardedNotices[0].transferId, forwardedId);
  response = await app.inject({
    method: "POST", url: `/api/admin/handoff-transfers/${forwardedId}/return`, headers: headers("admin03"),
    payload: { internalNote: "暂时退回" }
  });
  assert.equal(response.statusCode, 200);
  assert.equal((await service.listNotifications({ status: "pending", recipientUsername: "admin03" })).filter((item) => item.type === "handoff_transfer_requested").length, 0);
  assert.equal((await service.listNotifications({ status: "dismissed" })).filter((item) => item.type === "handoff_transfer_requested").length, 2);
  assert.equal((await service.listHandoffs()).find((item) => item.id === handoff.id).assigneeUsername, "admin01");
  const history = await service.listHandoffTransfers(handoff.id);
  assert.deepEqual(new Set(history.map((item) => item.status)), new Set(["forwarded", "returned"]));
});

test("schedule separates AI availability from scheduled and extra-duty human availability", async (t) => {
  const { app, service } = await fixture(t);
  const morning = await service.publicAvailability({ at: new Date("2026-07-27T00:30:00.000Z") });
  assert.equal(morning.ai.online, true);
  assert.equal(morning.ai.repliesContinueDuringHumanService, true);
  assert.equal(morning.human.online, true);
  assert.equal(morning.human.source, "schedule");
  const lunch = await service.publicAvailability({ at: new Date("2026-07-27T05:00:00.000Z") });
  assert.equal(lunch.human.online, false);

  assert.equal((await app.inject({
    method: "PUT", url: "/api/developer/operator-schedule", headers: headers("admin01"),
    payload: { timezone: "Asia/Shanghai", windows: [{ days: [1], start: "09:00", end: "10:00" }] }
  })).statusCode, 403);
  assert.equal((await app.inject({
    method: "PUT", url: "/api/developer/operator-schedule", headers: headers("developer01"),
    payload: { timezone: "Asia/Shanghai", windows: [{ id: "monday", label: "周一", days: [1], start: "09:00", end: "10:00" }] }
  })).statusCode, 200);
  assert.equal((await app.inject({
    method: "PUT", url: "/api/admin/operator-duty", headers: headers("admin01"), payload: { active: true }
  })).statusCode, 200);
  const extra = await service.publicAvailability({ at: new Date("2026-07-27T05:00:00.000Z") });
  assert.equal(extra.human.online, true);
  assert.equal(extra.human.source, "extra_duty");
});

test("anonymous analytics accepts only safe dimensions and maintains business and technical views", async (t) => {
  const { app, store } = await fixture(t);
  let response = await app.inject({
    method: "POST", url: "/api/support/analytics/events",
    payload: { type: "page_view", dimensions: { path: "/zh-CN/?secret=1", locale: "zh-CN", surface: "home", deviceClass: "desktop", source: "direct" } }
  });
  assert.equal(response.statusCode, 202);
  response = await app.inject({
    method: "POST", url: "/api/support/analytics/events",
    payload: { type: "cta_click", dimensions: { path: "/zh-CN/quote/", locale: "zh-CN", surface: "quote", targetId: "quote-primary" } }
  });
  assert.equal(response.statusCode, 202);
  assert.equal((await app.inject({
    method: "POST", url: "/api/support/analytics/events", payload: { type: "chat_body", dimensions: {} }
  })).statusCode, 400);
  assert.equal((await app.inject({
    method: "POST", url: "/api/support/analytics/events", payload: { type: "page_view", dimensions: {}, message: "不得保存的正文" }
  })).statusCode, 400);

  const business = await app.inject({ method: "GET", url: "/api/admin/analytics", headers: headers("admin01") });
  assert.equal(business.json().totals.pageViews, 1);
  assert.equal(business.json().totals.clicks, 1);
  const technical = await app.inject({ method: "GET", url: "/api/developer/analytics", headers: headers("developer01") });
  assert.equal(technical.json().rawEventCount, 2);
  assert.deepEqual(technical.json().traffic, { pageViews: 1, clicks: 1, totalMeaningfulEvents: 2 });
  assert.equal(technical.json().rawRetentionDays, 90);
  assert.equal(technical.json().aggregateRetentionMonths, 13);
  assert.equal(technical.json().storesIpAddresses, false);

  const snapshot = await store.read();
  const serialized = JSON.stringify(snapshot.anonymousAnalytics);
  assert.doesNotMatch(serialized, /secret=1|不得保存的正文|visitor|session|ipAddress/);
  assert.match(serialized, /\/zh-CN\//);
});
