import { z } from "zod";
import { bearerToken } from "./auth.js";
import { ANONYMOUS_EVENT_TYPES } from "./service.js";

const ADMIN_ROLES = new Set(["support", "administrator", "system_owner"]);
const DEVELOPER_ROLES = new Set(["developer", "system_owner"]);

const transferSchema = z.object({
  targetUsername: z.string().trim().min(2).max(40),
  internalNote: z.string().trim().max(4000).default("")
}).strict();
const transferDecisionSchema = z.object({ internalNote: z.string().trim().max(4000).default("") }).strict();
const noteSchema = z.object({ content: z.string().trim().min(1).max(4000) }).strict();
const dutySchema = z.object({ active: z.boolean() }).strict();
const scheduleSchema = z.object({
  timezone: z.string().trim().min(1).max(80),
  windows: z.array(z.object({
    id: z.string().trim().min(1).max(80).optional(),
    label: z.string().trim().min(1).max(80).optional(),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  }).strict()).min(1).max(12)
}).strict();
const attachmentSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  mimeType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
  size: z.number().int().min(1).max(25 * 1024 * 1024),
  storageKey: z.string().trim().min(1).max(500)
}).strict();
const analyticsSchema = z.object({
  type: z.enum(ANONYMOUS_EVENT_TYPES),
  dimensions: z.object({
    path: z.string().max(500).optional(),
    locale: z.string().max(16).optional(),
    surface: z.enum(["home", "navigation", "product", "customizer", "quote", "chat", "content", "other"]).optional(),
    deviceClass: z.enum(["desktop", "tablet", "mobile", "unknown"]).optional(),
    source: z.enum(["direct", "search", "social", "referral", "campaign", "internal", "unknown"]).optional(),
    targetId: z.string().max(80).optional()
  }).strict().default({})
}).strict();

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw Object.assign(new Error("请求参数无效。"), { statusCode: 400 });
}

function fail(message, statusCode) {
  throw Object.assign(new Error(message), { statusCode });
}

export async function registerWorkflowRoutes(app, { service, auth, aiConfigured = true }) {
  async function requireRole(request, roles) {
    const session = await auth.authenticate(bearerToken(request));
    if (!session) fail("后台会话无效或已过期。", 401);
    if (!roles.has(session.role)) fail("当前账号没有执行此操作的权限。", 403);
    request.workflowSession = session;
  }

  const requireAdmin = (request) => requireRole(request, ADMIN_ROLES);
  const requireDeveloper = (request) => requireRole(request, DEVELOPER_ROLES);
  const adminAccounts = async () => {
    const accounts = typeof auth.listAccounts === "function"
      ? await auth.listAccounts()
      : (auth.accounts || auth.configuredAccounts || []);
    return accounts.filter((account) => ADMIN_ROLES.has(account.role));
  };
  const accountFor = async (username) => {
    const account = (await adminAccounts()).find((item) => item.username === username);
    if (!account) fail("指定的管理员账号不存在。", 400);
    return account;
  };
  const publicAdmin = (account) => ({ username: account.username, name: account.displayName || account.username });

  app.get("/api/support/availability", () => service.publicAvailability({ aiConfigured }));
  app.post("/api/support/analytics/events", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = parse(analyticsSchema, request.body);
    const result = await service.recordAnonymousEvent(body);
    return reply.code(202).send(result);
  });

  app.get("/api/admin/operators", { preHandler: requireAdmin }, async () => ({ items: (await adminAccounts()).map(publicAdmin) }));
  app.post("/api/admin/handoffs/:handoffId/claim", { preHandler: requireAdmin }, async (request, reply) => {
    const session = request.workflowSession;
    const result = await service.claimHandoff({
      handoffId: String(request.params.handoffId), username: session.username, displayName: session.displayName
    });
    return result || reply.code(404).send({ error: "人工服务请求不存在。", requestId: request.id });
  });
  app.get("/api/admin/handoffs/:handoffId/transfers", { preHandler: requireAdmin }, (request) =>
    service.listHandoffTransfers(String(request.params.handoffId))
  );
  app.post("/api/admin/handoffs/:handoffId/transfers", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parse(transferSchema, request.body);
    const session = request.workflowSession;
    if (body.targetUsername === session.username) fail("不能将会话转交给自己。", 409);
    const target = await accountFor(body.targetUsername);
    const result = await service.requestHandoffTransfer({
      handoffId: String(request.params.handoffId),
      fromUsername: session.username, fromDisplayName: session.displayName,
      toUsername: target.username, toDisplayName: target.displayName,
      internalNote: body.internalNote
    });
    return result ? reply.code(201).send(result) : reply.code(404).send({ error: "人工服务请求不存在。", requestId: request.id });
  });
  app.post("/api/admin/handoff-transfers/:transferId/accept", { preHandler: requireAdmin }, async (request, reply) => {
    parse(transferDecisionSchema, request.body || {});
    const session = request.workflowSession;
    const result = await service.acceptHandoffTransfer({
      transferId: String(request.params.transferId), actorUsername: session.username, actorDisplayName: session.displayName
    });
    return result || reply.code(404).send({ error: "转交请求不存在。", requestId: request.id });
  });
  app.post("/api/admin/handoff-transfers/:transferId/return", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parse(transferDecisionSchema, request.body || {});
    const result = await service.returnHandoffTransfer({
      transferId: String(request.params.transferId), actorUsername: request.workflowSession.username, internalNote: body.internalNote
    });
    return result || reply.code(404).send({ error: "转交请求不存在。", requestId: request.id });
  });
  app.post("/api/admin/handoff-transfers/:transferId/forward", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parse(transferSchema, request.body);
    const session = request.workflowSession;
    if (body.targetUsername === session.username) fail("不能将会话转交给自己。", 409);
    const target = await accountFor(body.targetUsername);
    const result = await service.forwardHandoffTransfer({
      transferId: String(request.params.transferId),
      actorUsername: session.username, actorDisplayName: session.displayName,
      toUsername: target.username, toDisplayName: target.displayName,
      internalNote: body.internalNote
    });
    return result ? reply.code(201).send(result) : reply.code(404).send({ error: "转交请求不存在。", requestId: request.id });
  });

  app.get("/api/admin/handoffs/:handoffId/internal-notes", { preHandler: requireAdmin }, (request) =>
    service.listInternalNotes(String(request.params.handoffId))
  );
  app.post("/api/admin/handoffs/:handoffId/internal-notes", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parse(noteSchema, request.body);
    const session = request.workflowSession;
    const result = await service.addInternalNote({
      handoffId: String(request.params.handoffId), content: body.content,
      actorUsername: session.username, actorDisplayName: session.displayName
    });
    return result ? reply.code(201).send(result) : reply.code(404).send({ error: "人工服务请求不存在。", requestId: request.id });
  });
  app.post("/api/admin/conversations/:conversationId/attachment-metadata", { preHandler: requireAdmin }, async (request, reply) => {
    const body = parse(attachmentSchema, request.body);
    const result = await service.addConversationAttachment({
      conversationId: String(request.params.conversationId), ...body, actorUsername: request.workflowSession.username
    });
    return result ? reply.code(201).send(result) : reply.code(404).send({ error: "对话不存在。", requestId: request.id });
  });

  app.get("/api/admin/operator-schedule", { preHandler: requireAdmin }, (request) =>
    service.getOperatorSchedule({ username: request.workflowSession.username })
  );
  app.put("/api/admin/operator-duty", { preHandler: requireAdmin }, (request) => {
    const body = parse(dutySchema, request.body);
    return service.setExtraDuty({ username: request.workflowSession.username, active: body.active });
  });
  app.get("/api/admin/analytics", { preHandler: requireAdmin }, () => service.anonymousAnalyticsSummary());

  app.get("/api/developer/operator-schedule", { preHandler: requireDeveloper }, () => service.getOperatorSchedule());
  app.put("/api/developer/operator-schedule", { preHandler: requireDeveloper }, (request) => {
    const body = parse(scheduleSchema, request.body);
    return service.updateOperatorSchedule(body, request.workflowSession.username);
  });
  app.get("/api/developer/operator-duty", { preHandler: requireDeveloper }, async () => ({ items: await service.listExtraDuty() }));
  app.get("/api/developer/analytics", { preHandler: requireDeveloper }, () => service.anonymousAnalyticsTechnical());
}
