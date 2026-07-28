import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const DEVELOPER_TOKEN = "developer-token-0123456789abcdef";
const CLIENT_HEADERS = { "x-client-id": "4bb89af4-8f24-4ef5-a31c-8d2be4a81a16" };
const ACCOUNTS = [
  { username: "support", displayName: "客服一", role: "support", password: "support-password-123" },
  { username: "administrator", displayName: "运营一", role: "administrator", password: "administrator-password-123" },
  { username: "developer", displayName: "开发一", role: "developer", password: "developer-password-123" },
  { username: "owner", displayName: "负责人", role: "system_owner", password: "owner-password-123" }
];

async function createTestApp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-operations-rbac-"));
  const config = loadConfig({
    NODE_ENV: "production",
    SUPPORT_PROVIDER: "mock",
    AUTH_MODE: "public",
    SESSION_BACKEND: "stateless",
    AI_SERVICE_ENABLED: "true",
    USER_HASH_SECRET: SESSION_SECRET,
    RATE_LIMIT_MAX: "1000",
    OPERATIONS_ENABLED: "true",
    OPERATIONS_DATA_DIR: directory,
    OPERATIONS_USERS_JSON: JSON.stringify(ACCOUNTS),
    OPERATIONS_SESSION_SECRET: SESSION_SECRET,
    OPERATIONS_DEVELOPER_TOKEN: DEVELOPER_TOKEN
  });
  const app = await buildApp(config);
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return app;
}

async function login(app, account) {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: account.username, password: account.password }
  });
  assert.equal(response.statusCode, 200, `login failed for ${account.role}`);
  return { authorization: `Bearer ${response.json().token}` };
}

async function expectStatus(app, headers, method, url, statusCode, payload) {
  const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  assert.equal(response.statusCode, statusCode, `${method} ${url} returned ${response.statusCode}: ${response.body}`);
  return response;
}

test("operations RBAC exposes only each role's read surface", async (t) => {
  const app = await createTestApp(t);
  const tokens = Object.fromEntries(await Promise.all(ACCOUNTS.map(async (account) => [account.role, await login(app, account)])));

  await expectStatus(app, {}, "GET", "/api/ops/me", 401);

  for (const role of Object.keys(tokens)) {
    await expectStatus(app, tokens[role], "GET", "/api/ops/me", 200);
  }

  for (const role of ["support", "administrator", "system_owner"]) {
    await expectStatus(app, tokens[role], "GET", "/api/admin/overview", 200);
    await expectStatus(app, tokens[role], "GET", "/api/admin/conversations", 200);
    await expectStatus(app, tokens[role], "GET", "/api/admin/handoffs", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/overview", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/sessions", 200);
  }

  for (const role of ["administrator", "system_owner"]) {
    await expectStatus(app, tokens[role], "GET", "/api/admin/notifications", 200);
    await expectStatus(app, tokens[role], "GET", "/api/admin/content-revisions", 200);
    await expectStatus(app, tokens[role], "GET", "/api/admin/system-config", 200);
    await expectStatus(app, tokens[role], "GET", "/api/admin/events", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/important-information", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/content", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/notifications", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/rules", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/audit", 200);
  }

  for (const role of ["developer", "system_owner"]) {
    await expectStatus(app, tokens[role], "GET", "/api/ops/developer/status", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/developer/traces", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/developer/releases", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/developer/environment", 200);
    await expectStatus(app, tokens[role], "GET", "/api/ops/developer/emergency", 200);
  }

  for (const url of ["/api/admin/notifications", "/api/admin/content-revisions", "/api/admin/system-config", "/api/admin/events", "/api/ops/important-information", "/api/ops/content", "/api/ops/notifications", "/api/ops/rules", "/api/ops/audit", "/api/ops/developer/status"]) {
    await expectStatus(app, tokens.support, "GET", url, 403);
  }

  for (const url of ["/api/admin/overview", "/api/admin/conversations", "/api/admin/handoffs", "/api/admin/content-revisions", "/api/ops/overview", "/api/ops/sessions", "/api/ops/content"]) {
    await expectStatus(app, tokens.developer, "GET", url, 403);
  }

  await expectStatus(app, tokens.administrator, "GET", "/api/ops/developer/status", 403);
  await expectStatus(app, tokens.developer, "GET", "/api/admin/conversations/not-a-real-id", 403);
  await expectStatus(app, tokens.support, "GET", "/api/admin/conversations/not-a-real-id", 404);
});

test("operations RBAC permits scoped writes and blocks cross-role writes", async (t) => {
  const app = await createTestApp(t);
  const tokens = Object.fromEntries(await Promise.all(ACCOUNTS.map(async (account) => [account.role, await login(app, account)])));

  const handoffResponse = await expectStatus(app, CLIENT_HEADERS, "POST", "/api/support/chat", 200, { message: "我要人工客服" });
  const ticketId = handoffResponse.json().ticketId;
  const handoffs = await expectStatus(app, tokens.support, "GET", "/api/admin/handoffs", 200);
  const conversationId = handoffs.json().find((item) => item.id === ticketId).conversationId;

  await expectStatus(app, tokens.support, "POST", `/api/ops/sessions/${conversationId}/acknowledge`, 200, {});
  await expectStatus(app, tokens.support, "POST", `/api/ops/sessions/${conversationId}/takeover`, 200, {});
  await expectStatus(app, tokens.support, "POST", `/api/ops/sessions/${conversationId}/messages`, 201, { message: "您好，我来继续处理。" });
  await expectStatus(app, tokens.support, "POST", `/api/ops/sessions/${conversationId}/resolve`, 200, {});
  await expectStatus(app, tokens.support, "PATCH", `/api/admin/handoffs/${ticketId}`, 200, { status: "closed" });
  await expectStatus(app, tokens.support, "POST", "/api/admin/handoffs/missing/contacts", 404, { method: "email", value: "buyer@example.com" });

  for (const [method, url, payload] of [
    ["POST", "/api/admin/content-revisions", { key: "denied", title: "拒绝", content: "", status: "draft" }],
    ["PATCH", "/api/admin/system-config", { operatorMode: "paused" }],
    ["PUT", "/api/ops/important-information/draft", { fields: { leadTime: "待确认" } }],
    ["POST", "/api/ops/content", { title: "拒绝" }],
    ["PUT", "/api/ops/notifications", { settings: [] }],
    ["PUT", "/api/ops/rules", { mode: "paused" }],
    ["POST", "/api/ops/developer/emergency/actions/pause_ai", { reason: "越权测试" }]
  ]) {
    await expectStatus(app, tokens.support, method, url, 403, payload);
  }

  const adminRevision = await expectStatus(app, tokens.administrator, "POST", "/api/ops/content", 201, { title: "管理员内容" });
  const revisionId = adminRevision.json().id;
  await expectStatus(app, tokens.administrator, "POST", `/api/ops/content/${revisionId}/submit-review`, 200, {});
  await expectStatus(app, tokens.administrator, "PUT", "/api/ops/important-information/draft", 200, { fields: { leadTime: "以业务确认为准" } });
  await expectStatus(app, tokens.administrator, "PUT", "/api/ops/notifications", 200, { settings: [{ key: "handoff", group: "event", enabled: true }] });
  await expectStatus(app, tokens.administrator, "PUT", "/api/ops/rules", 200, { mode: "auto", note: "管理员规则" });
  await expectStatus(app, tokens.administrator, "POST", "/api/admin/content-revisions", 201, { key: "admin.low-level", title: "低层内容", content: "内容", status: "draft" });
  await expectStatus(app, tokens.administrator, "PATCH", "/api/admin/system-config", 200, { handoffMessage: "正在转接人工" });
  await expectStatus(app, tokens.administrator, "POST", "/api/ops/developer/emergency/actions/pause_ai", 403, { reason: "越权测试" });

  await expectStatus(app, tokens.developer, "POST", `/api/ops/developer/releases/${revisionId}/approve`, 200, { reason: "检查通过" });
  await expectStatus(app, tokens.developer, "POST", "/api/ops/developer/integrations/verify", 202, {});
  await expectStatus(app, tokens.developer, "POST", "/api/ops/developer/emergency/actions/pause_ai", 202, { reason: "应急止损" });
  await expectStatus(app, tokens.developer, "PUT", "/api/ops/rules", 403, { mode: "auto" });
  await expectStatus(app, tokens.developer, "PATCH", "/api/admin/system-config", 403, { operatorMode: "auto" });

  await expectStatus(app, tokens.system_owner, "PATCH", "/api/admin/system-config", 200, { operatorMode: "auto" });
  await expectStatus(app, tokens.system_owner, "POST", "/api/ops/content", 201, { title: "负责人内容" });
  await expectStatus(app, tokens.system_owner, "POST", "/api/ops/developer/emergency/actions/resume_ai", 202, { reason: "健康检查通过", confirmed: true });
});
