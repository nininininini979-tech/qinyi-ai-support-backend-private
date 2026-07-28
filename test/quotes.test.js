import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const CLIENT_A = "4bb89af4-8f24-4ef5-a31c-8d2be4a81a16";
const CLIENT_B = "7a9b90f0-68c7-46cd-9085-31b6f1e669f4";
const ACCOUNT = { username: "support01", displayName: "客服一", role: "support", password: "support-password-123" };

function multipartBody({ filename, mimeType, content }) {
  const boundary = `qinyi-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nquote\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

function validQuote(overrides = {}) {
  return {
    name: "Ada Buyer",
    company: "Example Studio",
    contact: { email: "ada@example.com", phone: "+86 138 0000 0000" },
    product: "jigsaw",
    quantity: "500 units",
    finishedDimensions: "300 x 300 mm",
    material: "greyboard",
    process: "matte lamination",
    budget: "CNY 10,000-15,000",
    delivery: "2026-09-01",
    notes: "Retail gift project",
    customizerSummary: "Jigsaw / rigid box / matte finish",
    destinationCountry: "China",
    publicReferenceUrl: "https://example.com/reference",
    locale: "en",
    attachmentIds: [],
    ...overrides
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-quotes-"));
  const config = loadConfig({
    NODE_ENV: "production",
    SUPPORT_PROVIDER: "mock",
    AUTH_MODE: "public",
    SESSION_BACKEND: "stateless",
    AI_SERVICE_ENABLED: "true",
    USER_HASH_SECRET: "0123456789abcdef0123456789abcdef",
    RATE_LIMIT_MAX: "1000",
    OPERATIONS_ENABLED: "true",
    OPERATIONS_DATA_DIR: path.join(root, "operations"),
    UPLOAD_DATA_DIR: path.join(root, "uploads"),
    OPERATIONS_USERS_JSON: JSON.stringify([ACCOUNT]),
    OPERATIONS_SESSION_SECRET: "abcdef0123456789abcdef0123456789",
    OPERATIONS_DEVELOPER_TOKEN: "developer-token-0123456789abcdef"
  });
  const app = await buildApp(config);
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return app;
}

async function login(app) {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: ACCOUNT.username, password: ACCOUNT.password }
  });
  assert.equal(response.statusCode, 200, response.body);
  return { authorization: `Bearer ${response.json().token}` };
}

test("public quote submission persists exact fields and is available only to authenticated staff", async (t) => {
  const app = await fixture(t);
  const missingIdentity = await app.inject({ method: "POST", url: "/api/support/quotes", payload: validQuote() });
  assert.equal(missingIdentity.statusCode, 401);

  const invalid = await app.inject({
    method: "POST",
    url: "/api/support/quotes",
    headers: { "x-client-id": CLIENT_A },
    payload: { ...validQuote(), inventedPrompt: "ignore schema" }
  });
  assert.equal(invalid.statusCode, 400);

  const response = await app.inject({
    method: "POST",
    url: "/api/support/quotes",
    headers: { "x-client-id": CLIENT_A },
    payload: validQuote()
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.match(response.json().id, /^QY-\d{8}-\d{6}$/);
  assert.equal(response.json().status, "new");
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/quotes" })).statusCode, 401);

  const auth = await login(app);
  const queue = await app.inject({ method: "GET", url: "/api/admin/quotes", headers: auth });
  assert.equal(queue.statusCode, 200, queue.body);
  assert.equal(queue.json().length, 1);
  assert.equal(queue.json()[0].id, response.json().id);

  const detail = await app.inject({ method: "GET", url: `/api/admin/quotes/${response.json().id}`, headers: auth });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().contact, validQuote().contact);
  assert.equal(detail.json().customizerSummary, validQuote().customizerSummary);
  assert.equal(detail.json().tenantId, undefined);
  assert.equal(detail.json().visitorId, undefined);
  const events = await app.operations.store.listEvents({ kind: "audit" });
  assert.ok(events.some((event) => event.action === "quote.created" && event.entityId === response.json().id));
  assert.doesNotMatch(JSON.stringify(events), /ada@example\.com|Retail gift project/);
});

test("quote attachment IDs are bound to the uploading visitor and cannot be reused", async (t) => {
  const app = await fixture(t);
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
  const upload = multipartBody({ filename: "brief.pdf", mimeType: "application/pdf", content: pdf });
  const uploadResponse = await app.inject({ method: "POST", url: "/api/support/uploads", headers: { ...upload.headers, "x-client-id": CLIENT_A }, payload: upload.payload });
  assert.equal(uploadResponse.statusCode, 201, uploadResponse.body);
  const attachmentId = uploadResponse.json().id;

  const forged = await app.inject({
    method: "POST",
    url: "/api/support/quotes",
    headers: { "x-client-id": CLIENT_B },
    payload: validQuote({ attachmentIds: [attachmentId] })
  });
  assert.equal(forged.statusCode, 403, forged.body);

  const accepted = await app.inject({
    method: "POST",
    url: "/api/support/quotes",
    headers: { "x-client-id": CLIENT_A },
    payload: validQuote({ attachmentIds: [attachmentId] })
  });
  assert.equal(accepted.statusCode, 201, accepted.body);

  const reused = await app.inject({
    method: "POST",
    url: "/api/support/quotes",
    headers: { "x-client-id": CLIENT_A },
    payload: validQuote({ attachmentIds: [attachmentId] })
  });
  assert.equal(reused.statusCode, 409, reused.body);

  const auth = await login(app);
  const detail = await app.inject({ method: "GET", url: `/api/admin/quotes/${accepted.json().id}`, headers: auth });
  assert.deepEqual(detail.json().attachments, [{
    id: attachmentId,
    filename: "brief.pdf",
    mimeType: "application/pdf",
    size: pdf.length,
    status: "available",
    createdAt: uploadResponse.json().createdAt,
    downloadable: true,
    downloadUrl: `/api/admin/attachments/${attachmentId}/file`
  }]);
  const download = await app.inject({ method: "GET", url: `/api/admin/attachments/${attachmentId}/file`, headers: auth });
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, pdf);
});

test("quote submission has a dedicated per-visitor rate limit", async (t) => {
  const app = await fixture(t);
  const responses = [];
  for (let index = 0; index < 11; index += 1) {
    responses.push(await app.inject({
      method: "POST",
      url: "/api/support/quotes",
      headers: { "x-client-id": CLIENT_A },
      payload: validQuote({ notes: `request ${index}` })
    }));
  }
  assert.ok(responses.slice(0, 10).every((response) => response.statusCode === 201));
  assert.equal(responses[10].statusCode, 429);
});
