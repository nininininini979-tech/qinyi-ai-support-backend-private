import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import multipartPlugin from "@fastify/multipart";
import sharp from "sharp";
import { FileOperationsStore } from "../src/operations/store.js";
import { OperationsService } from "../src/operations/service.js";
import { registerOpsCompatibilityRoutes } from "../src/operations/ops-routes.js";
import {
  SecureUploadService,
  UPLOAD_PROFILES,
  registerSecureUploadRoutes
} from "../src/operations/secure-uploads.js";

const ACCOUNTS = [
  { username: "admin01", displayName: "管理员1", role: "administrator" },
  { username: "developer01", displayName: "开发者1", role: "developer" },
  { username: "support01", displayName: "客服1", role: "support" }
];

function multipartBody({ fields = {}, filename, mimeType, content }) {
  const boundary = `qinyi-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  ));
  chunks.push(Buffer.from(content));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-secure-uploads-"));
  const store = await new FileOperationsStore({ directory: path.join(root, "operations") }).init();
  const operations = new OperationsService({ store });
  const uploader = await new SecureUploadService({ directory: path.join(root, "uploads"), store }).init();
  const sessions = new Map();
  const auth = {
    async authenticate(token) {
      return ACCOUNTS.find((account) => account.username === token) || null;
    }
  };
  const app = Fastify();
  await app.register(multipartPlugin, { limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 8, parts: 9 } });
  await registerSecureUploadRoutes(app, {
    uploader,
    auth,
    identityFor: () => ({ tenantId: "public-web", userId: "public:visitor-1" }),
    sessionStore: {
      async get(tenantId, visitorId, sessionId) {
        return sessions.get(`${tenantId}:${visitorId}:${sessionId}`) || null;
      }
    }
  });
  await registerOpsCompatibilityRoutes(app, {
    config: { NODE_ENV: "test", AI_SERVICE_ENABLED: true },
    service: operations,
    auth
  });
  app.setErrorHandler((error, request, reply) => reply.code(error.statusCode || 500).send({ error: error.message, code: error.code, requestId: request.id }));
  t.after(async () => {
    await app.close();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { app, root, store, operations, sessions };
}

function adminHeaders(username = "admin01") {
  return { authorization: `Bearer ${username}` };
}

test("upload profiles enforce the requested 25MB, 50MB and 100MB boundaries", () => {
  assert.equal(UPLOAD_PROFILES.visitor.maxBytes, 25 * 1024 * 1024);
  assert.equal(UPLOAD_PROFILES.cmsImage.maxBytes, 50 * 1024 * 1024);
  assert.equal(UPLOAD_PROFILES.cmsModel.maxBytes, 100 * 1024 * 1024);
});

test("visitor quote upload trusts file magic, isolates the file and audits acceptance", async (t) => {
  const { app, root, store } = await fixture(t);
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
  const request = multipartBody({
    fields: { purpose: "quote" },
    filename: "../../采购需求.pdf",
    mimeType: "application/octet-stream",
    content: pdf
  });
  const response = await app.inject({ method: "POST", url: "/api/support/uploads", ...request });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();
  assert.equal(body.mimeType, "application/pdf");
  assert.equal(body.filename, "采购需求.pdf");
  assert.equal(body.purpose, "quote");
  assert.equal(body.storageKey, undefined);

  const snapshot = await store.read();
  const record = snapshot.uploads[body.id];
  assert.match(record.storageKey, /^visitor\/[0-9a-f]{24}\/[0-9a-f]{24}\//);
  assert.doesNotMatch(record.storageKey, /public-web|visitor-1|采购/);
  assert.equal((await fs.stat(path.join(root, "uploads", record.storageKey))).mode & 0o777, 0o600);
  const audit = await store.listEvents({ kind: "audit" });
  assert.ok(audit.some((event) => event.action === "upload.visitor_quote_accepted" && event.entityId === body.id));
});

test("visitor support upload must belong to a real session and follows its conversation", async (t) => {
  const { app, operations, sessions } = await fixture(t);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  sessions.set(`public-web:public:visitor-1:${sessionId}`, { id: sessionId });
  const exchange = await operations.recordExchange({
    tenantId: "public-web",
    visitorId: "public:visitor-1",
    sessionId,
    message: "请检查附件",
    result: { action: "answer", answer: "请上传文件。", citations: [] }
  });
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const request = multipartBody({
    fields: { purpose: "support", sessionId },
    filename: "proof.png",
    mimeType: "image/png",
    content: png
  });
  const response = await app.inject({ method: "POST", url: "/api/support/uploads", ...request });
  assert.equal(response.statusCode, 201, response.body);
  const conversation = await operations.getConversation(exchange.conversationId);
  assert.equal(conversation.attachments.length, 1);
  assert.equal(conversation.attachments[0].id, response.json().id);
  const detail = await app.inject({
    method: "GET",
    url: `/api/ops/sessions/${exchange.conversationId}`,
    headers: adminHeaders()
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().attachments, [{
    id: response.json().id,
    filename: "proof.png",
    mimeType: "image/png",
    size: response.json().size,
    status: "available",
    createdAt: response.json().createdAt,
    downloadable: true,
    downloadUrl: `/api/admin/attachments/${response.json().id}/file`
  }]);
  assert.doesNotMatch(JSON.stringify(detail.json().attachments), /storageKey|sha256|visitor-1|owner/);
  assert.doesNotMatch(JSON.stringify(detail.json().session), /storageKey|sha256|visitor-1|owner|externalSessionIds|messageIds|attachmentIds/);
  const download = await app.inject({
    method: "GET",
    url: `/api/admin/attachments/${response.json().id}/file`,
    headers: adminHeaders("support01")
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "image/png");
  assert.match(download.headers["content-disposition"], /^attachment; filename\*=UTF-8''proof\.png$/);
  assert.ok(download.rawPayload.length > 0);
  assert.equal((await app.inject({
    method: "GET",
    url: `/api/admin/attachments/${response.json().id}/file`
  })).statusCode, 401);

  const missingSession = multipartBody({
    fields: { purpose: "support", sessionId: "22222222-2222-4222-8222-222222222222" },
    filename: "proof.png",
    mimeType: "image/png",
    content: png
  });
  assert.equal((await app.inject({ method: "POST", url: "/api/support/uploads", ...missingSession })).statusCode, 404);
});

test("CMS image upload strips metadata, creates a thumbnail and remains manager-only", async (t) => {
  const { app, root, store } = await fixture(t);
  const image = await sharp({ create: { width: 10, height: 8, channels: 3, background: "#227755" } })
    .jpeg()
    .withExif({ IFD0: { Artist: "private-person" } })
    .toBuffer();
  const request = multipartBody({ filename: "hero.jpg", mimeType: "image/jpeg", content: image });
  let response = await app.inject({
    method: "POST",
    url: "/api/ops/content/assets/images",
    headers: { ...request.headers, ...adminHeaders() },
    payload: request.payload
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();
  assert.equal(body.validation.metadataStripped, true);
  assert.ok(body.thumbnailUrl);
  const record = (await store.read()).contentAssets[body.id];
  const outputMetadata = await sharp(path.join(root, "uploads", record.storageKey)).metadata();
  assert.equal(outputMetadata.exif, undefined);
  assert.equal(outputMetadata.width, 10);
  assert.equal(outputMetadata.height, 8);

  response = await app.inject({ method: "GET", url: body.thumbnailUrl, headers: adminHeaders() });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/webp");
  assert.ok(response.rawPayload.length > 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/ops/content/assets", headers: adminHeaders("support01") })).statusCode, 403);
});

test("CMS model upload uses the Khronos validator and rejects external glTF resources", async (t) => {
  const { app, store } = await fixture(t);
  const valid = Buffer.from(JSON.stringify({ asset: { version: "2.0" } }));
  const validRequest = multipartBody({ filename: "empty.gltf", mimeType: "model/gltf+json", content: valid });
  let response = await app.inject({
    method: "POST",
    url: "/api/ops/content/assets/models",
    headers: { ...validRequest.headers, ...adminHeaders("developer01") },
    payload: validRequest.payload
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().mimeType, "model/gltf+json");
  assert.equal(response.json().validation.errors, 0);
  assert.match(response.json().validation.validator, /Khronos/);

  const external = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "model.bin", byteLength: 4 }] }));
  const invalidRequest = multipartBody({ filename: "external.gltf", mimeType: "model/gltf+json", content: external });
  response = await app.inject({
    method: "POST",
    url: "/api/ops/content/assets/models",
    headers: { ...invalidRequest.headers, ...adminHeaders() },
    payload: invalidRequest.payload
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "EXTERNAL_GLTF_RESOURCE");
  const audit = await store.listEvents({ kind: "audit" });
  assert.ok(audit.some((event) => event.action === "upload.cms_model_rejected" && event.reasonCode === "EXTERNAL_GLTF_RESOURCE"));
});

test("disguised executable content is rejected before permanent storage", async (t) => {
  const { app, root, store } = await fixture(t);
  const request = multipartBody({
    fields: { purpose: "quote" },
    filename: "fake.png",
    mimeType: "image/png",
    content: Buffer.from("#!/bin/sh\necho unsafe\n")
  });
  const response = await app.inject({ method: "POST", url: "/api/support/uploads", ...request });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "ATTACHMENT_TYPE_MISMATCH");
  assert.deepEqual((await store.read()).uploads || {}, {});
  const visitorDirectory = path.join(root, "uploads", "visitor");
  await assert.rejects(fs.stat(visitorDirectory), { code: "ENOENT" });
});
