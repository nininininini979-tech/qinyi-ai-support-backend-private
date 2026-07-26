import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileOperationsStore } from "../src/operations/store.js";
import { OperationsService } from "../src/operations/service.js";

async function createService(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-handoff-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new FileOperationsStore({ directory }).init();
  t.after(() => store.close());
  return new OperationsService({ store });
}

test("operations keeps separate sessions and handoffs for the same visitor", async (t) => {
  const service = await createService(t);
  const identity = { tenantId: "tenant", visitorId: "visitor" };

  const first = await service.recordExchange({
    ...identity,
    sessionId: "session-1",
    message: "第一项需求",
    result: { action: "answer", answer: "第一项回复", citations: [] }
  });
  const firstHandoff = await service.createHandoff({
    ...identity,
    sessionId: "session-1",
    reason: "explicit_request",
    unresolvedQuestion: "第一项需求"
  });

  const second = await service.recordExchange({
    ...identity,
    sessionId: "session-2",
    message: "第二项需求",
    result: { action: "answer", answer: "第二项回复", citations: [] }
  });
  const secondHandoff = await service.createHandoff({
    ...identity,
    sessionId: "session-2",
    reason: "explicit_request",
    unresolvedQuestion: "第二项需求"
  });

  assert.notEqual(first.conversationId, second.conversationId);
  assert.notEqual(firstHandoff.id, secondHandoff.id);
  assert.equal((await service.listConversations()).length, 2);
  assert.deepEqual((await service.getConversation(first.conversationId)).handoffs.map((item) => item.id), [firstHandoff.id]);
  assert.deepEqual((await service.getConversation(second.conversationId)).handoffs.map((item) => item.id), [secondHandoff.id]);

  assert.equal(await service.closeConversation({ ...identity, sessionId: "session-2" }), true);
  assert.equal((await service.getConversation(first.conversationId)).status, "open");
  assert.equal((await service.getConversation(second.conversationId)).status, "closed");
  assert.equal((await service.listHandoffs()).find((item) => item.id === firstHandoff.id).status, "waiting_human");
  assert.equal((await service.listHandoffs()).find((item) => item.id === secondHandoff.id).status, "closed");
});

test("handoff state changes are validated and visitor replies return the current state", async (t) => {
  const service = await createService(t);
  const identity = { tenantId: "tenant", visitorId: "visitor", sessionId: "session" };
  const exchange = await service.recordExchange({
    ...identity,
    message: "需要人工",
    result: { action: "handoff", answer: "正在为您联系人工客服。", citations: [] }
  });
  const handoff = await service.createHandoff({
    ...identity,
    reason: "explicit_request",
    unresolvedQuestion: "需要人工"
  });

  await assert.rejects(
    service.updateHandoff(handoff.id, { status: "resolved" }, "管理员甲"),
    (error) => error.statusCode === 409
  );
  await service.updateHandoff(handoff.id, { status: "acknowledged" }, "管理员甲");
  await service.updateHandoff(handoff.id, { status: "human_active", assignee: "管理员甲" }, "管理员甲");
  await assert.rejects(
    service.updateHandoff(handoff.id, { status: "human_active", assignee: "管理员乙" }, "管理员乙"),
    (error) => error.statusCode === 409
  );
  await assert.rejects(
    service.addHumanMessage({ conversationId: exchange.conversationId, content: "越权回复", actor: "管理员乙" }),
    (error) => error.statusCode === 409
  );
  await assert.rejects(
    service.updateHandoff(handoff.id, { status: "resolved" }, "管理员乙"),
    (error) => error.statusCode === 409
  );

  const human = await service.addHumanMessage({
    conversationId: exchange.conversationId,
    content: "您好，我已接管本次对话。",
    actor: "管理员甲"
  });
  assert.equal(human.handoff.status, "waiting_customer");

  const visitor = await service.addVisitorMessage({ ...identity, content: "数量为 500 套。" });
  assert.equal(visitor.handoff.status, "human_active");
  assert.equal((await service.getConversation(exchange.conversationId)).mode, "human_active");

  await assert.rejects(
    service.updateHandoff(handoff.id, { status: "acknowledged" }, "管理员甲"),
    (error) => error.statusCode === 409
  );
  const resolved = await service.updateHandoff(handoff.id, { status: "resolved" }, "管理员甲");
  assert.equal(resolved.status, "resolved");
  assert.equal((await service.getConversation(exchange.conversationId)).mode, "ai");
});

test("a new handoff records the customer exchange before the system notice", async (t) => {
  const service = await createService(t);
  const identity = { tenantId: "tenant", visitorId: "visitor", sessionId: "session" };
  const handoff = await service.createHandoff({
    ...identity,
    reason: "explicit_request",
    unresolvedQuestion: "我要人工"
  });
  await service.recordExchange({
    ...identity,
    message: "我要人工",
    result: { action: "handoff", answer: "正在为您联系人工客服。", citations: [] }
  });

  const conversation = (await service.getConversation(handoff.conversationId));
  assert.deepEqual(conversation.messages.map((item) => item.role), ["customer", "assistant", "system"]);
  assert.equal(conversation.handoffs.length, 1);
  assert.equal(conversation.handoffs[0].systemNoticePending, undefined);
});

test("recording a stateless response attaches the public session token to the existing handoff", async (t) => {
  const service = await createService(t);
  const identity = { tenantId: "tenant", visitorId: "visitor" };
  const handoff = await service.createHandoff({
    ...identity,
    sessionId: "pre-save-session-id",
    reason: "explicit_request",
    unresolvedQuestion: "我要人工"
  });
  const exchange = await service.recordExchange({
    ...identity,
    sessionId: "encrypted-public-session-token",
    message: "我要人工",
    result: { action: "handoff", answer: "正在为您联系人工客服。", ticketId: handoff.id, citations: [] }
  });

  assert.equal(exchange.conversationId, handoff.conversationId);
  assert.equal((await service.listConversations()).length, 1);
  assert.equal((await service.activeHandoff({ ...identity, sessionId: "encrypted-public-session-token" })).id, handoff.id);
});
