import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const DEVELOPER_TOKEN = "developer-token-0123456789abcdef";
const ADMIN_PASSWORD = "administrator-password-123";
const CLIENT_HEADERS = { "x-client-id": "4bb89af4-8f24-4ef5-a31c-8d2be4a81a16" };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-ai-drafts-"));
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
    OPERATIONS_USERS_JSON: JSON.stringify([{
      username: "admin01",
      displayName: "管理员一",
      role: "administrator",
      password: ADMIN_PASSWORD
    }]),
    OPERATIONS_SESSION_SECRET: SESSION_SECRET,
    OPERATIONS_DEVELOPER_TOKEN: DEVELOPER_TOKEN
  });
  const app = await buildApp(config);
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "admin01", password: ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200);
  return { app, directory, admin: { authorization: `Bearer ${login.json().token}` } };
}

test("draft mode keeps generated text private until an administrator approves it", async (t) => {
  const { app, directory, admin } = await fixture(t);
  const mode = await app.inject({
    method: "PUT",
    url: "/api/ops/rules",
    headers: admin,
    payload: { mode: "draft", expectedRevision: 1 }
  });
  assert.equal(mode.statusCode, 200, mode.body);

  const response = await app.inject({
    method: "POST",
    url: "/api/support/chat",
    headers: CLIENT_HEADERS,
    payload: { message: "请介绍定制拼图可选的材质" }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().action, "draft_pending");
  assert.match(response.json().ticketId, /^OPS-/);
  assert.equal(response.json().draftId, undefined);

  const sessions = await app.inject({ method: "GET", url: "/api/ops/sessions", headers: admin });
  const conversationId = sessions.json().items[0].id;
  const detail = await app.inject({ method: "GET", url: `/api/ops/sessions/${conversationId}`, headers: admin });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().aiDrafts.length, 1);
  const draft = detail.json().aiDrafts[0];
  assert.equal(draft.status, "pending");
  assert.ok(draft.content.length > 0);
  assert.doesNotMatch(response.body, new RegExp(draft.content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const beforeApproval = await app.inject({
    method: "GET",
    url: `/api/support/tickets/${response.json().ticketId}/events?after=0`,
    headers: CLIENT_HEADERS
  });
  assert.ok(!beforeApproval.json().events.some((item) => item.text === draft.content));

  const approvedText = `${draft.content}\n\n以上内容已由勤益管理员核实。`;
  const approved = await app.inject({
    method: "POST",
    url: `/api/ops/ai-drafts/${draft.id}/approve`,
    headers: admin,
    payload: { content: approvedText }
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().draft.status, "approved");
  assert.equal(approved.json().handoff.status, "waiting_customer");

  const events = await app.inject({
    method: "GET",
    url: `/api/support/tickets/${response.json().ticketId}/events?after=0`,
    headers: CLIENT_HEADERS
  });
  assert.ok(events.json().events.some((item) => item.role === "human" && item.text === approvedText));
  const duplicate = await app.inject({ method: "POST", url: `/api/ops/ai-drafts/${draft.id}/approve`, headers: admin, payload: {} });
  assert.equal(duplicate.statusCode, 409);

  const ledger = await fs.readFile(path.join(directory, "events.ndjson"), "utf8");
  assert.match(ledger, /"action":"ai_draft.created"/);
  assert.match(ledger, /"action":"ai_draft.approved"/);
});

test("observe drafts may be rejected and never become visitor messages", async (t) => {
  const { app, admin } = await fixture(t);
  await app.inject({ method: "PUT", url: "/api/ops/rules", headers: admin, payload: { mode: "observe", expectedRevision: 1 } });
  const response = await app.inject({ method: "POST", url: "/api/support/chat", headers: CLIENT_HEADERS, payload: { message: "有哪些包装方案" } });
  assert.equal(response.json().action, "draft_pending");
  const drafts = await app.inject({ method: "GET", url: "/api/ops/ai-drafts?status=pending", headers: admin });
  assert.equal(drafts.json().items[0].mode, "observe");
  const rejected = await app.inject({
    method: "POST",
    url: `/api/ops/ai-drafts/${drafts.json().items[0].id}/reject`,
    headers: admin,
    payload: { reason: "需要补充真实包装资料" }
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal(rejected.json().status, "rejected");
  const events = await app.inject({ method: "GET", url: `/api/support/tickets/${response.json().ticketId}/events?after=0`, headers: CLIENT_HEADERS });
  assert.ok(!events.json().events.some((item) => item.text === drafts.json().items[0].content));
});
