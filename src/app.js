import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { createSessionStore } from "./stores/session-store.js";
import { MockSupportProvider } from "./providers/mock-provider.js";
import { OpenAISupportProvider } from "./providers/openai-provider.js";
import { DeepSeekSupportProvider } from "./providers/deepseek-provider.js";
import { DemoHandoffAdapter } from "./adapters/handoff.js";
import { SupportService } from "./support/service.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionIdSchema = z.string().max(16_000).refine(
  (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) || /^v1(?:\.[A-Za-z0-9_-]+){3}$/.test(value),
  "会话标识无效。"
);
const chatSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  message: z.string().trim().min(1)
});
const handoffSchema = z.object({ message: z.string().trim().max(2000).optional() });
const feedbackSchema = z.object({ sessionId: sessionIdSchema, rating: z.enum(["up", "down"]), reason: z.string().trim().max(500).optional() });

function identityFor(request, config) {
  if (config.AUTH_MODE === "demo") {
    return {
      userId: String(request.headers["x-demo-user-id"] || config.DEMO_USER_ID),
      tenantId: String(request.headers["x-tenant-id"] || config.DEMO_TENANT_ID)
    };
  }
  if (config.AUTH_MODE === "public") {
    const clientId = String(request.headers["x-client-id"] || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
      const error = new Error("缺少有效的匿名访客标识。");
      error.statusCode = 401;
      throw error;
    }
    return { userId: `public:${clientId}`, tenantId: config.PUBLIC_TENANT_ID };
  }
  const userId = request.headers["x-user-id"];
  const tenantId = request.headers["x-tenant-id"];
  if (!userId || !tenantId) {
    const error = new Error("缺少受信任身份头。");
    error.statusCode = 401;
    throw error;
  }
  return { userId: String(userId), tenantId: String(tenantId) };
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const error = new Error("请求参数无效。");
  error.statusCode = 400;
  throw error;
}

async function staticFile(reply, filename, contentType) {
  const body = await fs.readFile(path.join(rootDir, "public", filename));
  return reply.type(contentType).header("Cache-Control", "no-store").send(body);
}

export async function buildApp(config) {
  const app = Fastify({
    bodyLimit: 32 * 1024,
    trustProxy: config.TRUST_PROXY ? 1 : false,
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      redact: ["req.headers.authorization", "req.headers.cookie", "req.body.message", "req.body.reason"]
    }
  });
  const sessionStore = await createSessionStore(config);
  const knowledgeDir = path.join(rootDir, "knowledge", process.env.VERCEL ? "curated" : "prepared");
  const playbookDir = path.join(rootDir, "service-playbook");
  const provider = config.SUPPORT_PROVIDER === "openai"
    ? new OpenAISupportProvider(config, { playbookDir })
    : config.SUPPORT_PROVIDER === "deepseek"
      ? new DeepSeekSupportProvider(config, { knowledgeDir, playbookDir })
      : new MockSupportProvider({ knowledgeDir });
  const support = new SupportService({ config, sessionStore, provider, handoff: new DemoHandoffAdapter() });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => `${request.ip}:${request.headers["x-client-id"] || request.headers["x-demo-user-id"] || request.headers["x-user-id"] || "anonymous"}`
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "Content-Type, X-Client-Id, X-Demo-User-Id, X-User-Id, X-Tenant-Id");
      reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'");
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  app.get("/", (_, reply) => staticFile(reply, "index.html", "text/html; charset=utf-8"));
  app.get("/styles.css", (_, reply) => staticFile(reply, "styles.css", "text/css; charset=utf-8"));
  app.get("/config.js", (_, reply) => staticFile(reply, "config.js", "text/javascript; charset=utf-8"));
  app.get("/app.js", (_, reply) => staticFile(reply, "app.js", "text/javascript; charset=utf-8"));

  app.get("/health/live", async () => ({ ok: true }));
  app.get("/health/ready", async () => ({ ok: true, provider: config.SUPPORT_PROVIDER, sessionBackend: config.SESSION_BACKEND }));
  app.get("/api/support/status", async () => ({
    provider: config.SUPPORT_PROVIDER,
    aiEnabled: config.AI_SERVICE_ENABLED,
    publicMode: config.AUTH_MODE === "public",
    sessionBackend: config.SESSION_BACKEND,
    model: config.SUPPORT_PROVIDER === "openai" ? config.OPENAI_MODEL : config.SUPPORT_PROVIDER === "deepseek" ? config.DEEPSEEK_MODEL : undefined
  }));

  app.post("/api/support/chat", async (request, reply) => {
    const body = parse(chatSchema, request.body);
    if (body.message.length > config.MAX_MESSAGE_CHARS) return reply.code(400).send({ error: `消息不能超过 ${config.MAX_MESSAGE_CHARS} 个字符。`, requestId: request.id });
    const result = await support.chat({ identity: identityFor(request, config), ...body });
    return { ...result, requestId: request.id };
  });

  app.delete("/api/support/sessions/:sessionId", async (request, reply) => {
    const sessionId = parse(sessionIdSchema, request.params.sessionId);
    const identity = identityFor(request, config);
    const deleted = await sessionStore.delete(identity.tenantId, identity.userId, sessionId);
    if (!deleted) return reply.code(404).send({ error: "会话不存在、已过期或不属于当前用户。", requestId: request.id });
    return reply.code(204).send();
  });

  app.post("/api/support/sessions/:sessionId/handoff", async (request) => {
    const sessionId = parse(sessionIdSchema, request.params.sessionId);
    const body = parse(handoffSchema, request.body || {});
    const result = await support.requestHandoff({ identity: identityFor(request, config), sessionId, message: body.message });
    return { ...result, requestId: request.id };
  });

  app.post("/api/support/feedback", async (request, reply) => {
    const body = parse(feedbackSchema, request.body);
    const identity = identityFor(request, config);
    const session = await sessionStore.get(identity.tenantId, identity.userId, body.sessionId);
    if (!session) return reply.code(404).send({ error: "会话不存在、已过期或不属于当前用户。", requestId: request.id });
    // Demo records only aggregate counters. A production adapter should persist masked, access-controlled feedback.
    session.feedback = { rating: body.rating, hasReason: Boolean(body.reason), updatedAt: new Date().toISOString() };
    await sessionStore.save(identity.tenantId, identity.userId, body.sessionId, session);
    return reply.code(202).send({ accepted: true, requestId: request.id });
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (statusCode >= 500) request.log.error({ err: error, requestId: request.id }, "request_failed");
    reply.code(statusCode).send({ error: statusCode >= 500 ? "服务繁忙，请稍后再试。" : error.message, requestId: request.id });
  });

  app.addHook("onClose", async () => sessionStore.close());
  return app;
}
