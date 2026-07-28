import { z } from "zod";
import { bearerToken } from "./auth.js";

const ADMIN_ROLES = new Set(["support", "administrator", "system_owner"]);
const DEVELOPER_ROLES = new Set(["developer", "system_owner"]);
const phoneSchema = z.string().trim().min(8).max(20);
const requestCodeSchema = z.object({ phone: phoneSchema }).strict();
const verifyCodeSchema = z.object({ challengeId: z.string().trim().min(20).max(100), code: z.string().regex(/^\d{6}$/) }).strict();
const createOrderSchema = z.object({
  quoteId: z.string().trim().max(80).nullable().optional(), customerPhone: phoneSchema,
  title: z.string().trim().min(1).max(200), summary: z.string().trim().max(4000).default(""),
  externalReference: z.string().trim().max(120).default("")
}).strict();
const advanceSchema = z.object({ targetStage: z.string().trim().min(1).max(80), note: z.string().trim().max(2000).default("") }).strict();
const settingsSchema = z.object({
  customerVisibleProduction: z.boolean(),
  customerStageSlaDays: z.record(z.number().min(0).max(365)).default({}),
  productionStageSlaHours: z.record(z.number().min(0).max(8760)).default({})
}).strict();

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw Object.assign(new Error("请求参数无效。"), { statusCode: 400 });
}
function fail(message, statusCode) { throw Object.assign(new Error(message), { statusCode }); }

export async function registerOrderRoutes(app, { orderSystem, auth }) {
  async function requireRole(request, roles) {
    const session = await auth.authenticate(bearerToken(request));
    if (!session) fail("后台会话无效或已过期。", 401);
    if (!roles.has(session.role)) fail("当前账号没有执行此操作的权限。", 403);
    request.orderAdminSession = session;
  }
  async function requireCustomer(request) {
    const session = await orderSystem.authenticate(bearerToken(request));
    if (!session) fail("客户登录已过期，请重新登录。", 401);
    request.customerSession = session;
  }

  app.post("/api/customer/auth/sms/request", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (request, reply) =>
    reply.code(202).send(await orderSystem.requestLoginCode(parse(requestCodeSchema, request.body).phone))
  );
  app.post("/api/customer/auth/sms/verify", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (request) =>
    orderSystem.verifyLoginCode(parse(verifyCodeSchema, request.body))
  );
  app.get("/api/customer/orders", { preHandler: requireCustomer }, async (request) => ({
    customer: { phoneMasked: request.customerSession.phoneMasked },
    items: await orderSystem.listCustomerOrders(request.customerSession.phoneHash)
  }));
  app.get("/api/customer/orders/:orderId", { preHandler: requireCustomer }, async (request, reply) =>
    (await orderSystem.getCustomerOrder(String(request.params.orderId), request.customerSession.phoneHash)) || reply.code(404).send({ error: "订单不存在。" })
  );
  app.delete("/api/customer/auth/session", { preHandler: requireCustomer }, async (request, reply) => {
    await orderSystem.revokeSession(bearerToken(request));
    return reply.code(204).send();
  });

  app.get("/api/admin/orders", { preHandler: (request) => requireRole(request, ADMIN_ROLES) }, async () => ({ items: await orderSystem.listOrders() }));
  app.get("/api/admin/orders/:orderId", { preHandler: (request) => requireRole(request, ADMIN_ROLES) }, async (request, reply) =>
    (await orderSystem.getOrder(String(request.params.orderId))) || reply.code(404).send({ error: "订单不存在。" })
  );
  app.post("/api/admin/orders", { preHandler: (request) => requireRole(request, ADMIN_ROLES) }, async (request, reply) => {
    const session = request.orderAdminSession;
    return reply.code(201).send(await orderSystem.createOrder(parse(createOrderSchema, request.body), session.username));
  });
  app.post("/api/admin/orders/:orderId/advance", { preHandler: (request) => requireRole(request, ADMIN_ROLES) }, async (request, reply) => {
    const result = await orderSystem.advanceCustomerStage({ orderId: String(request.params.orderId), ...parse(advanceSchema, request.body), actor: request.orderAdminSession.username });
    return result || reply.code(404).send({ error: "订单不存在。" });
  });
  app.post("/api/admin/orders/:orderId/production/advance", { preHandler: (request) => requireRole(request, ADMIN_ROLES) }, async (request, reply) => {
    const result = await orderSystem.advanceProductionStage({ orderId: String(request.params.orderId), ...parse(advanceSchema, request.body), actor: request.orderAdminSession.username });
    return result || reply.code(404).send({ error: "订单不存在。" });
  });

  app.get("/api/developer/order-system", { preHandler: (request) => requireRole(request, DEVELOPER_ROLES) }, () => orderSystem.systemStatus());
  app.put("/api/developer/order-system/settings", { preHandler: (request) => requireRole(request, DEVELOPER_ROLES) }, (request) =>
    orderSystem.updateSettings(parse(settingsSchema, request.body), request.orderAdminSession.username)
  );
}
