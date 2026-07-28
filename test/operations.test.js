import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileOperationsStore } from "../src/operations/store.js";
import { OperationsAuthService } from "../src/operations/auth.js";
import { OperationsService } from "../src/operations/service.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const ADMIN_PASSWORD = "correct horse battery staple";
const DEVELOPER_TOKEN = "developer-token-0123456789abcdef";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-operations-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("file operations store persists atomic snapshots and append-only events", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await new FileOperationsStore({ directory }).init();
  await store.transact((state) => {
    state.systemConfig.operatorMode = "auto";
    return true;
  }, { kind: "audit", action: "config.seeded", actor: "test" });
  await store.appendEvent({ kind: "agent", type: "review.completed", actor: "agent-c" });
  await store.close();

  const reopened = await new FileOperationsStore({ directory }).init();
  assert.equal((await reopened.read((state) => state.systemConfig)).operatorMode, "auto");
  const events = await reopened.listEvents();
  assert.deepEqual(events.map((item) => item.kind), ["audit", "agent"]);
  assert.equal(events[0].snapshotVersion, 2);
  await reopened.close();
});

test("operations auth requires a password and stores only token hashes", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await new FileOperationsStore({ directory }).init();
  const auth = new OperationsAuthService({ store, password: ADMIN_PASSWORD, sessionSecret: SESSION_SECRET, ttlSeconds: 600 });
  assert.equal(await auth.login({ password: "wrong-password" }), null);
  const login = await auth.login({ password: ADMIN_PASSWORD, ip: "127.0.0.1" });
  assert.ok(login.token);
  assert.ok(await auth.authenticate(login.token));
  const snapshot = await fs.readFile(path.join(directory, "operations.json"), "utf8");
  assert.doesNotMatch(snapshot, new RegExp(login.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await auth.logout(login.token);
  assert.equal(await auth.authenticate(login.token), null);
  await store.close();
});

test("multi-user operations login preserves account identity and role", async (t) => {
  const directory = await temporaryDirectory(t);
  const accounts = [
    { username: "support01", displayName: "客服一组", role: "support", password: "support-password-123" },
    { username: "developer01", displayName: "值班开发者", role: "developer", password: "developer-password-456" }
  ];
  const config = loadConfig({
    NODE_ENV: "production", SUPPORT_PROVIDER: "mock", AUTH_MODE: "public", SESSION_BACKEND: "stateless",
    USER_HASH_SECRET: SESSION_SECRET, OPERATIONS_ENABLED: "true", OPERATIONS_DATA_DIR: directory,
    OPERATIONS_USERS_JSON: JSON.stringify(accounts), OPERATIONS_SESSION_SECRET: SESSION_SECRET,
    OPERATIONS_DEVELOPER_TOKEN: DEVELOPER_TOKEN, RATE_LIMIT_MAX: "1000"
  });
  const app = await buildApp(config);
  t.after(() => app.close());

  const obsoleteSecondFactor = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: "support01", password: accounts[0].password, totp: "000000" }
  });
  assert.equal(obsoleteSecondFactor.statusCode, 400);
  const supportLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "support01", password: accounts[0].password } });
  assert.equal(supportLogin.statusCode, 200);
  assert.deepEqual(supportLogin.json().user, { username: "support01", name: "客服一组", role: "support" });
  const supportHeaders = { authorization: `Bearer ${supportLogin.json().token}` };
  assert.equal((await app.inject({ method: "GET", url: "/api/ops/me", headers: supportHeaders })).json().user.role, "support");
  assert.equal((await app.inject({ method: "GET", url: "/api/ops/developer/status", headers: supportHeaders })).statusCode, 403);

  const developerLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "developer01", password: accounts[1].password } });
  assert.equal(developerLogin.statusCode, 200);
  assert.equal(developerLogin.json().user.role, "developer");
  const developerHeaders = { authorization: `Bearer ${developerLogin.json().token}` };
  assert.equal((await app.inject({ method: "GET", url: "/api/ops/developer/status", headers: developerHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/auth/totp/confirm", payload: {} })).statusCode, 404);
});

test("operations service models conversations, messages, handoffs, contacts, notifications, revisions and config", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await new FileOperationsStore({ directory }).init();
  const service = new OperationsService({ store });
  const exchange = await service.recordExchange({ tenantId: "public", visitorId: "visitor", sessionId: "session", message: "需要报价", result: { action: "answer", answer: "请提供数量", citations: [] } });
  const handoff = await service.createHandoff({ tenantId: "public", visitorId: "visitor", sessionId: "session", reason: "explicit_request", unresolvedQuestion: "电话 13812345678" });
  await service.addContact({ handoffId: handoff.id, contact: { name: "张三", company: "示例公司", method: "phone", value: "13812345678" } });
  await service.createContentRevision({ key: "welcome", title: "欢迎语", content: "您好" });
  await service.updateSystemConfig({ operatorMode: "draft" });
  const conversation = await service.getConversation(exchange.conversationId);
  assert.equal(conversation.messages.length, 3);
  assert.match((await service.listHandoffs())[0].summary, /138\*{4}5678/);
  assert.equal((await service.listNotifications())[0].status, "pending");
  assert.equal((await service.listContentRevisions())[0].key, "welcome");
  assert.equal((await service.getSystemConfig()).operatorMode, "draft");
  await store.close();
});

test("operations APIs authenticate admins, accept developer events, and create public handoffs", async (t) => {
  const directory = await temporaryDirectory(t);
  const config = loadConfig({
    NODE_ENV: "production", SUPPORT_PROVIDER: "mock", AUTH_MODE: "public", SESSION_BACKEND: "stateless", AI_SERVICE_ENABLED: "true",
    USER_HASH_SECRET: SESSION_SECRET, RATE_LIMIT_MAX: "1000", OPERATIONS_ENABLED: "true", OPERATIONS_DATA_DIR: directory,
    OPERATIONS_ADMIN_PASSWORD: ADMIN_PASSWORD, OPERATIONS_SESSION_SECRET: SESSION_SECRET,
    OPERATIONS_DEVELOPER_TOKEN: DEVELOPER_TOKEN
  });
  const app = await buildApp(config);
  t.after(() => app.close());
  const clientHeaders = { "x-client-id": "4bb89af4-8f24-4ef5-a31c-8d2be4a81a16" };

  const handoffResponse = await app.inject({ method: "POST", url: "/api/support/chat", headers: clientHeaders, payload: { message: "我要人工客服" } });
  assert.equal(handoffResponse.statusCode, 200);
  assert.equal(handoffResponse.json().action, "handoff");
  assert.match(handoffResponse.json().ticketId, /^OPS-/);
  assert.equal(handoffResponse.json().handoff.status, "waiting_human");
  const sessionId = handoffResponse.json().sessionId;

  const initialEvents = await app.inject({ method: "GET", url: `/api/support/tickets/${handoffResponse.json().ticketId}/events?after=0`, headers: clientHeaders });
  assert.equal(initialEvents.statusCode, 200);
  assert.equal(initialEvents.json().handoff.status, "waiting_human");

  const denied = await app.inject({ method: "GET", url: "/api/admin/overview" });
  assert.equal(denied.statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200);
  const adminHeaders = { authorization: `Bearer ${login.json().token}` };
  const overview = await app.inject({ method: "GET", url: "/api/admin/overview", headers: adminHeaders });
  assert.equal(overview.json().queuedHandoffs, 1);
  assert.equal(overview.json().conversations, 1);
  const handoffs = await app.inject({ method: "GET", url: "/api/admin/handoffs", headers: adminHeaders });
  const handoffId = handoffs.json()[0].id;
  const conversations = await app.inject({ method: "GET", url: "/api/admin/conversations", headers: adminHeaders });
  const conversationId = conversations.json()[0].id;
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/handoffs/${handoffId}`, headers: adminHeaders, payload: { status: "acknowledged" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/handoffs/${handoffId}`, headers: adminHeaders, payload: { status: "human_active", assignee: "运营管理员" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/conversations/${conversationId}/messages`, headers: adminHeaders, payload: { message: "您好，我已接管本次对话。" } })).statusCode, 201);
  const visitorFollowUp = await app.inject({ method: "POST", url: "/api/support/chat", headers: clientHeaders, payload: { sessionId, message: "谢谢，我补充数量为500套。" } });
  assert.equal(visitorFollowUp.json().handoff.status, "human_active");
  assert.ok(visitorFollowUp.json().answer.length > 0, "AI remains available while a human manager is active");
  const humanEvents = await app.inject({ method: "GET", url: `/api/support/tickets/${handoffId}/events?after=0`, headers: clientHeaders });
  assert.ok(humanEvents.json().events.some((item) => item.role === "human"));
  assert.ok(humanEvents.json().events.some((item) => item.role === "customer" && /500套/.test(item.text)));
  const opsMe = await app.inject({ method: "GET", url: "/api/ops/me", headers: adminHeaders });
  assert.equal(opsMe.statusCode, 200);
  assert.equal(opsMe.json().user.role, "system_owner");
  const opsOverview = await app.inject({ method: "GET", url: "/api/ops/overview", headers: adminHeaders });
  assert.equal(opsOverview.statusCode, 200);
  assert.equal(opsOverview.json().metrics.waitingHuman, 1);
  const opsSessions = await app.inject({ method: "GET", url: "/api/ops/sessions", headers: adminHeaders });
  assert.equal(opsSessions.json().items[0].id, conversationId);
  const opsSession = await app.inject({ method: "GET", url: `/api/ops/sessions/${conversationId}`, headers: adminHeaders });
  assert.ok(opsSession.json().messages.some((item) => item.role === "agent"));
  const developerStatus = await app.inject({ method: "GET", url: "/api/ops/developer/status", headers: adminHeaders });
  const developerStatusData = developerStatus.json();
  assert.equal(developerStatusData.systems.length, 4);
  assert.ok(developerStatusData.systems.every((item) => item.value));
  assert.deepEqual(Object.keys(developerStatusData.metrics).sort(), ["activeSessions", "conversations", "humanQueue", "pendingNotifications"]);
  assert.ok(developerStatusData.changes.every((item) => item.createdAt && item.type && item.name && item.status === "complete"));
  assert.doesNotMatch(JSON.stringify(developerStatusData.changes), /v1\./);
  const emergencyAction = await app.inject({ method: "POST", url: "/api/ops/developer/emergency/actions/pause_ai", headers: adminHeaders, payload: { reason: "自动化契约测试" } });
  assert.equal(emergencyAction.statusCode, 202);
  const emergencyStatus = await app.inject({ method: "GET", url: "/api/ops/developer/emergency", headers: adminHeaders });
  const emergencyRecord = emergencyStatus.json().history.find((item) => item.action === "pause_ai");
  assert.equal(emergencyRecord.reason, "自动化契约测试");
  assert.equal(emergencyRecord.status, "complete");
  assert.equal(emergencyStatus.json().metrics.errorRate, null);
  assert.equal(emergencyStatus.json().metrics.p95LatencyMs, null);
  const developerEnvironment = await app.inject({ method: "GET", url: "/api/ops/developer/environment", headers: adminHeaders });
  assert.ok(developerEnvironment.json().integrations.some((item) => item.name === "企业微信"));
  const configUpdate = await app.inject({ method: "PATCH", url: "/api/admin/system-config", headers: adminHeaders, payload: { operatorMode: "draft", aiEnabled: false } });
  assert.equal(configUpdate.statusCode, 200);
  const supportStatus = await app.inject({ method: "GET", url: "/api/support/status", headers: clientHeaders });
  assert.equal(supportStatus.json().operatorMode, "draft");
  assert.equal(supportStatus.json().aiEnabled, false);

  const agentEvent = await app.inject({ method: "POST", url: "/api/developer/events", headers: { authorization: `Bearer ${DEVELOPER_TOKEN}` }, payload: { type: "candidate.reviewed", agentId: "agent-c", payload: { score: 92 } } });
  assert.equal(agentEvent.statusCode, 202);
  const supportEvent = await app.inject({ method: "POST", url: "/api/support/events", headers: clientHeaders, payload: { type: "widget.opened", payload: { page: "/" } } });
  assert.equal(supportEvent.statusCode, 202);
  const events = await app.inject({ method: "GET", url: "/api/admin/events?limit=100", headers: adminHeaders });
  assert.ok(events.json().some((item) => item.kind === "agent"));
  assert.ok(events.json().some((item) => item.kind === "support"));
});

test("operations polling has an independent bucket while login and anonymous support remain limited", async (t) => {
  const directory = await temporaryDirectory(t);
  const config = loadConfig({
    NODE_ENV: "production", SUPPORT_PROVIDER: "mock", AUTH_MODE: "public", SESSION_BACKEND: "stateless", AI_SERVICE_ENABLED: "true",
    USER_HASH_SECRET: SESSION_SECRET, RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW: "1 minute", OPERATIONS_ENABLED: "true", OPERATIONS_DATA_DIR: directory,
    OPERATIONS_ADMIN_PASSWORD: ADMIN_PASSWORD, OPERATIONS_SESSION_SECRET: SESSION_SECRET,
    OPERATIONS_DEVELOPER_TOKEN: DEVELOPER_TOKEN
  });
  const app = await buildApp(config);
  t.after(() => app.close());

  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200);
  const adminHeaders = { authorization: `Bearer ${login.json().token}` };
  const clientHeaders = { "x-client-id": "4bb89af4-8f24-4ef5-a31c-8d2be4a81a16" };

  assert.equal((await app.inject({ method: "GET", url: "/api/support/status", headers: clientHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/support/status", headers: clientHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/support/status", headers: clientHeaders })).statusCode, 429);
  assert.equal((await app.inject({ method: "GET", url: "/api/support/status", headers: { "x-client-id": "d69b985f-c233-4cf4-ac7d-2fe2666db12c" } })).statusCode, 200);

  for (let index = 0; index < 12; index += 1) {
    const response = await app.inject({ method: "GET", url: "/api/admin/overview", headers: adminHeaders });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-ratelimit-limit"], "240");
  }

  for (let index = 0; index < 4; index += 1) {
    const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "admin", password: "invalid-password" } });
    assert.equal(response.statusCode, 401);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "admin", password: "invalid-password" } })).statusCode, 429);
});
