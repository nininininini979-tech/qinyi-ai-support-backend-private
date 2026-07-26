import crypto from "node:crypto";
import { z } from "zod";
import { bearerToken } from "./auth.js";
import { registerOpsCompatibilityRoutes } from "./ops-routes.js";

const eventSchema = z.object({ type: z.string().trim().min(1).max(80), sessionId: z.string().max(16_000).optional(), payload: z.record(z.unknown()).default({}) }).strict();
const developerEventSchema = eventSchema.extend({ agentId: z.string().trim().min(1).max(80), runId: z.string().trim().max(120).optional() }).strict();
const loginSchema = z.object({ username: z.string().trim().min(2).max(40).default("admin"), password: z.string().min(1).max(1024), totp: z.string().regex(/^\d{6}$/) }).strict();
const handoffUpdateSchema = z.object({
  status: z.enum(["waiting_human", "acknowledged", "human_active", "waiting_customer", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assignee: z.string().trim().max(120).optional(),
  note: z.string().trim().max(2000).optional()
}).strict().refine((value) => Object.keys(value).length > 0);
const messageSchema = z.object({ message: z.string().trim().min(1).max(2000) }).strict();
const contactSchema = z.object({ name: z.string().trim().max(120).default(""), company: z.string().trim().max(160).default(""), method: z.enum(["phone", "email", "wechat", "other"]), value: z.string().trim().min(1).max(240) }).strict();
const notificationSchema = z.object({ status: z.enum(["pending", "sent", "failed", "dismissed"]) }).strict();
const contentRevisionSchema = z.object({ key: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(200), content: z.string().max(100_000), status: z.enum(["draft", "review", "approved", "published", "retired"]).default("draft") }).strict();
const systemConfigSchema = z.object({ aiEnabled: z.boolean().optional(), operatorMode: z.enum(["observe", "draft", "auto", "paused"]).optional(), handoffMessage: z.string().trim().max(500).optional() }).strict().refine((value) => Object.keys(value).length > 0);

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw Object.assign(new Error("请求参数无效。"), { statusCode: 400 });
}

function secureEqual(expected, actual) {
  const left = crypto.createHash("sha256").update(String(expected)).digest();
  const right = crypto.createHash("sha256").update(String(actual)).digest();
  return crypto.timingSafeEqual(left, right);
}

function numericQuery(value, fallback = 100) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback;
}

export async function registerOperationsRoutes(app, { config, service, auth, identityFor, applySystemConfig }) {
  const SUPPORT_ROLES = ["support", "administrator", "system_owner"];
  const ADMINISTRATOR_ROLES = ["administrator", "system_owner"];

  async function requireRole(request, roles) {
    const session = await auth.authenticate(bearerToken(request));
    if (!session) throw Object.assign(new Error("管理员会话无效或已过期。"), { statusCode: 401 });
    if (!roles.includes(session.role)) throw Object.assign(new Error("当前账号没有执行此操作的权限。"), { statusCode: 403 });
    request.adminSession = session;
  }

  const requireAuthenticated = (request) => requireRole(request, ["support", "administrator", "developer", "system_owner"]);
  const requireSupport = (request) => requireRole(request, SUPPORT_ROLES);
  const requireAdministrator = (request) => requireRole(request, ADMINISTRATOR_ROLES);

  async function requireDeveloper(request) {
    if (!secureEqual(config.OPERATIONS_DEVELOPER_TOKEN, bearerToken(request))) throw Object.assign(new Error("开发者凭据无效。"), { statusCode: 401 });
  }

  app.post("/api/admin/auth/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = parse(loginSchema, request.body);
    const result = await auth.login({ ...body, ip: request.ip });
    if (!result) return reply.code(401).send({ error: "管理员凭据无效。", requestId: request.id });
    return { ...result, requestId: request.id };
  });

  app.delete("/api/admin/auth/session", { preHandler: requireAuthenticated }, async (request, reply) => {
    await auth.logout(bearerToken(request));
    return reply.code(204).send();
  });

  app.get("/api/admin/overview", { preHandler: requireSupport }, () => service.overview());
  app.get("/api/admin/conversations", { preHandler: requireSupport }, (request) => service.listConversations({ status: request.query?.status, limit: numericQuery(request.query?.limit) }));
  app.get("/api/admin/conversations/:conversationId", { preHandler: requireSupport }, async (request, reply) => {
    const result = await service.getConversation(String(request.params.conversationId));
    return result || reply.code(404).send({ error: "对话不存在。", requestId: request.id });
  });
  app.get("/api/admin/handoffs", { preHandler: requireSupport }, (request) => service.listHandoffs({ status: request.query?.status, limit: numericQuery(request.query?.limit) }));
  app.patch("/api/admin/handoffs/:handoffId", { preHandler: requireSupport }, async (request, reply) => {
    const changes = parse(handoffUpdateSchema, request.body);
    const actor = request.adminSession.displayName || request.adminSession.username;
    if (changes.status === "human_active") changes.assignee = actor;
    else if (changes.assignee !== undefined && !ADMINISTRATOR_ROLES.includes(request.adminSession.role)) {
      return reply.code(403).send({ error: "当前账号不能转交人工会话。", requestId: request.id });
    }
    const result = await service.updateHandoff(String(request.params.handoffId), changes, actor);
    return result || reply.code(404).send({ error: "转人工记录不存在。", requestId: request.id });
  });
  app.post("/api/admin/conversations/:conversationId/messages", { preHandler: requireSupport }, async (request, reply) => {
    const body = parse(messageSchema, request.body);
    const result = await service.addHumanMessage({
      conversationId: String(request.params.conversationId),
      content: body.message,
      actor: request.adminSession.displayName || request.adminSession.username
    });
    return result ? reply.code(201).send(result) : reply.code(404).send({ error: "对话不存在。", requestId: request.id });
  });
  app.post("/api/admin/handoffs/:handoffId/contacts", { preHandler: requireSupport }, async (request, reply) => {
    const result = await service.addContact({ handoffId: String(request.params.handoffId), contact: parse(contactSchema, request.body), actor: request.adminSession.displayName || request.adminSession.username });
    return result ? reply.code(201).send(result) : reply.code(404).send({ error: "转人工记录不存在。", requestId: request.id });
  });
  app.get("/api/admin/notifications", { preHandler: requireAdministrator }, (request) => service.listNotifications({ status: request.query?.status, limit: numericQuery(request.query?.limit) }));
  app.patch("/api/admin/notifications/:notificationId", { preHandler: requireAdministrator }, async (request, reply) => {
    const body = parse(notificationSchema, request.body);
    const result = await service.updateNotification(String(request.params.notificationId), body.status, request.adminSession.displayName || request.adminSession.username);
    return result || reply.code(404).send({ error: "通知不存在。", requestId: request.id });
  });
  app.get("/api/admin/content-revisions", { preHandler: requireAdministrator }, () => service.listContentRevisions());
  app.post("/api/admin/content-revisions", { preHandler: requireAdministrator }, async (request, reply) => reply.code(201).send(await service.createContentRevision(parse(contentRevisionSchema, request.body), request.adminSession.displayName || request.adminSession.username)));
  app.get("/api/admin/system-config", { preHandler: requireAdministrator }, () => service.getSystemConfig());
  app.patch("/api/admin/system-config", { preHandler: requireAdministrator }, async (request) => {
    const result = await service.updateSystemConfig(parse(systemConfigSchema, request.body), request.adminSession.displayName || request.adminSession.username);
    await applySystemConfig?.(result);
    return result;
  });
  app.get("/api/admin/events", { preHandler: requireAdministrator }, (request) => service.store.listEvents({ after: request.query?.after, kind: request.query?.kind, limit: numericQuery(request.query?.limit) }));

  app.post("/api/developer/events", { preHandler: requireDeveloper }, async (request, reply) => {
    const body = parse(developerEventSchema, request.body);
    const event = await service.recordEvent({ kind: "agent", type: body.type, actor: body.agentId, sessionId: body.sessionId, payload: { ...body.payload, runId: body.runId } });
    return reply.code(202).send({ accepted: true, eventId: event.id, requestId: request.id });
  });

  app.post("/api/support/events", async (request, reply) => {
    const identity = identityFor(request, config);
    const body = parse(eventSchema, request.body);
    const event = await service.recordEvent({ kind: "support", type: body.type, actor: identity.userId, sessionId: body.sessionId, payload: body.payload });
    return reply.code(202).send({ accepted: true, eventId: event.id, requestId: request.id });
  });

  app.get("/api/support/sessions/:sessionId/events", async (request, reply) => {
    const identity = identityFor(request, config);
    const result = await service.sessionEvents({
      tenantId: identity.tenantId,
      visitorId: identity.userId,
      sessionId: String(request.params.sessionId),
      after: request.query?.after
    });
    return result || reply.code(404).send({ error: "会话不存在或不属于当前访客。", requestId: request.id });
  });

  app.get("/api/support/tickets/:ticketId/events", async (request, reply) => {
    const identity = identityFor(request, config);
    const result = await service.ticketEvents({
      tenantId: identity.tenantId,
      visitorId: identity.userId,
      ticketId: String(request.params.ticketId),
      after: request.query?.after
    });
    return result || reply.code(404).send({ error: "人工服务请求不存在或不属于当前访客。", requestId: request.id });
  });

  await registerOpsCompatibilityRoutes(app, { config, service, auth, applySystemConfig });
}
