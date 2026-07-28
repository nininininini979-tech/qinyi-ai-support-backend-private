import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileOperationsStore } from "../src/operations/store.js";
import { CUSTOMER_ORDER_STAGES, FACTORY_PRODUCTION_STAGES, OrderSystemService } from "../src/operations/order-system.js";
import { createSmsProvider, HttpSmsProvider } from "../src/operations/sms-provider.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const SESSION_SECRET = "order-system-test-secret-0123456789abcdef";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-order-system-"));
  const store = await new FileOperationsStore({ directory }).init();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const provider = { name: "test", exposeCode: true, async sendCode() {} };
  return { directory, store, service: new OrderSystemService({ store, sessionSecret: SESSION_SECRET, smsProvider: provider }) };
}

test("customer SMS login is disabled until a provider is configured", async (t) => {
  const { store } = await fixture(t);
  const service = new OrderSystemService({ store, sessionSecret: SESSION_SECRET });
  await assert.rejects(service.requestLoginCode("13800138000"), (error) => error.statusCode === 503 && error.errorCode === "SMS_NOT_CONFIGURED");
});

test("production SMS adapter sends a bounded gateway request without exposing the code", async () => {
  let request;
  const provider = new HttpSmsProvider({
    endpoint: "https://sms.internal.example/send",
    token: "gateway-token-not-a-real-secret",
    templateId: "order-login",
    signName: "勤益",
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true };
    }
  });
  await provider.sendCode({ phone: "+8613800138000", code: "123456", expiresAt: "2026-07-28T12:00:00.000Z", challengeId: "SMS-test" });
  assert.equal(provider.exposeCode, false);
  assert.equal(request.url, "https://sms.internal.example/send");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer gateway-token-not-a-real-secret");
  assert.deepEqual(JSON.parse(request.options.body), {
    recipient: "+8613800138000", code: "123456", expiresAt: "2026-07-28T12:00:00.000Z",
    challengeId: "SMS-test", purpose: "customer_order_login", templateId: "order-login", signName: "勤益"
  });
  assert.equal(createSmsProvider({ ORDER_SMS_PROVIDER: "disabled" }), null);
  assert.throws(() => createSmsProvider({ NODE_ENV: "production", ORDER_SMS_PROVIDER: "mock" }), /forbidden/);
  assert.throws(() => loadConfig({ NODE_ENV: "test", SUPPORT_PROVIDER: "mock", ORDER_SMS_PROVIDER: "http" }), /ORDER_SMS_HTTP_URL/);
  assert.throws(() => loadConfig({ NODE_ENV: "test", SUPPORT_PROVIDER: "mock", ORDER_SMS_PROVIDER: "http", ORDER_SMS_HTTP_URL: "https:\/\/sms.example.com", ORDER_SMS_HTTP_TOKEN: "short" }), /ORDER_SMS_HTTP_TOKEN/);
});

test("failed SMS delivery removes the unusable challenge and returns a stable boundary", async (t) => {
  const { store } = await fixture(t);
  const service = new OrderSystemService({
    store,
    sessionSecret: SESSION_SECRET,
    smsProvider: { name: "failing", exposeCode: false, async sendCode() { throw new Error("upstream details"); } }
  });
  await assert.rejects(service.requestLoginCode("13800138000"), (error) =>
    error.statusCode === 502 && error.errorCode === "SMS_DELIVERY_FAILED" && error.safeToExpose === true
  );
  assert.deepEqual(await store.read((state) => state.customerAuthChallenges), {});
  const events = await store.listEvents({ kind: "audit" });
  assert.ok(events.some((event) => event.action === "customer.sms_failed"));
});

test("a failed resend does not invalidate the last successfully delivered code", async (t) => {
  const { store } = await fixture(t);
  let shouldFail = false;
  const provider = { name: "toggle", exposeCode: true, async sendCode() { if (shouldFail) throw new Error("offline"); } };
  const service = new OrderSystemService({ store, sessionSecret: SESSION_SECRET, smsProvider: provider });
  const first = await service.requestLoginCode("13800138000");
  shouldFail = true;
  await assert.rejects(service.requestLoginCode("13800138000"), (error) => error.errorCode === "SMS_DELIVERY_FAILED");
  const verified = await service.verifyLoginCode({ challengeId: first.challengeId, code: first.developmentCode });
  assert.ok(await service.authenticate(verified.token));
});

test("concurrent SMS requests do not let an older delivery delete the newer challenge", async (t) => {
  const { store } = await fixture(t);
  const deliveries = [];
  const provider = {
    name: "controlled", exposeCode: true,
    async sendCode(input) { await new Promise((resolve) => deliveries.push({ input, resolve })); }
  };
  const service = new OrderSystemService({ store, sessionSecret: SESSION_SECRET, smsProvider: provider });
  const firstPromise = service.requestLoginCode("13800138000");
  while (deliveries.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const secondPromise = service.requestLoginCode("13800138000");
  while (deliveries.length < 2) await new Promise((resolve) => setImmediate(resolve));
  deliveries[0].resolve();
  const first = await firstPromise;
  deliveries[1].resolve();
  const second = await secondPromise;
  const challenges = await store.read((state) => state.customerAuthChallenges);
  assert.equal(challenges[first.challengeId], undefined);
  assert.equal(challenges[second.challengeId].deliveryStatus, "sent");
  assert.ok((await service.verifyLoginCode({ challengeId: second.challengeId, code: second.developmentCode })).token);
});

test("a late older SMS request reports that a newer delivered code superseded it", async (t) => {
  const { store } = await fixture(t);
  const deliveries = [];
  const provider = {
    name: "controlled", exposeCode: true,
    async sendCode(input) { await new Promise((resolve) => deliveries.push({ input, resolve })); }
  };
  const service = new OrderSystemService({ store, sessionSecret: SESSION_SECRET, smsProvider: provider });
  const firstPromise = service.requestLoginCode("13800138000");
  while (deliveries.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const secondPromise = service.requestLoginCode("13800138000");
  while (deliveries.length < 2) await new Promise((resolve) => setImmediate(resolve));
  deliveries[1].resolve();
  const second = await secondPromise;
  deliveries[0].resolve();
  await assert.rejects(firstPromise, (error) => error.errorCode === "CODE_SUPERSEDED" && error.statusCode === 409);
  assert.ok((await service.verifyLoginCode({ challengeId: second.challengeId, code: second.developmentCode })).token);
  const events = await store.listEvents({ kind: "audit" });
  assert.ok(events.some((event) => event.action === "customer.sms_superseded"));
});

test("invalid SMS attempts persist and lock the challenge on the fifth failure", async (t) => {
  const { store, service } = await fixture(t);
  const login = await service.requestLoginCode("13800138000");
  for (let attempt = 1; attempt < 5; attempt += 1) {
    await assert.rejects(service.verifyLoginCode({ challengeId: login.challengeId, code: "999999" }), (error) => error.errorCode === "INVALID_CODE");
    assert.equal(await store.read((state) => state.customerAuthChallenges[login.challengeId].attempts), attempt);
  }
  await assert.rejects(service.verifyLoginCode({ challengeId: login.challengeId, code: "999999" }), (error) => error.errorCode === "CODE_ATTEMPTS_EXCEEDED");
  assert.equal(await store.read((state) => state.customerAuthChallenges[login.challengeId]), undefined);
  await assert.rejects(service.verifyLoginCode({ challengeId: login.challengeId, code: login.developmentCode }), (error) => error.errorCode === "CODE_EXPIRED");
});

test("a quote converts to exactly one order with the same customer phone", async (t) => {
  const { store, service } = await fixture(t);
  await store.transact((state) => {
    state.quotes["QY-20260728-000001"] = {
      id: "QY-20260728-000001", status: "new", name: "采购客户", product: "礼品盒",
      contact: { phone: "+86 138 0013 8000", email: "buyer@example.com" },
      createdAt: "2026-07-28T08:00:00.000Z", updatedAt: "2026-07-28T08:00:00.000Z"
    };
  });
  await assert.rejects(
    service.createOrder({ quoteId: "QY-20260728-000001", customerPhone: "13900139000", title: "错误客户" }, "admin01"),
    (error) => error.errorCode === "QUOTE_PHONE_MISMATCH"
  );
  const order = await service.createOrder({ quoteId: "QY-20260728-000001", customerPhone: "13800138000", title: "礼品盒订单" }, "admin01");
  assert.equal(order.quoteId, "QY-20260728-000001");
  const quote = await store.read((state) => state.quotes["QY-20260728-000001"]);
  assert.equal(quote.status, "converted");
  assert.equal(quote.orderId, order.id);
  await assert.rejects(
    service.createOrder({ quoteId: "QY-20260728-000001", customerPhone: "13800138000", title: "重复订单" }, "admin01"),
    (error) => error.errorCode === "QUOTE_ALREADY_CONVERTED"
  );
  assert.equal((await service.listOrders()).length, 1);
});

test("customer and factory order stages are fixed, sequential and customer-isolated", async (t) => {
  const { directory, service } = await fixture(t);
  const login = await service.requestLoginCode("13800138000");
  const verified = await service.verifyLoginCode({ challengeId: login.challengeId, code: login.developmentCode });
  const customer = await service.authenticate(verified.token);
  assert.ok(customer);

  const order = await service.createOrder({ customerPhone: "13800138000", title: "定制拼图", summary: "500套" }, "admin01");
  const secondOrder = await service.createOrder({ customerPhone: "13800138000", title: "定制卡牌" }, "admin01");
  assert.equal(order.stage, "inquiry");
  assert.notEqual(secondOrder.id, order.id);
  assert.match(order.id, /^QO-\d{8}-\d{6}$/);
  assert.equal((await service.listOrders({ customerId: customer.phoneHash })).length, 2);
  assert.equal((await service.listOrders({ customerId: "another-customer" })).length, 0);
  await assert.rejects(
    service.advanceCustomerStage({ orderId: order.id, targetStage: "files_received", actor: "admin01" }),
    (error) => error.errorCode === "INVALID_ORDER_TRANSITION"
  );

  let current = order;
  for (const stage of CUSTOMER_ORDER_STAGES.slice(1, 10)) {
    current = await service.advanceCustomerStage({ orderId: order.id, targetStage: stage.id, actor: "admin01" });
  }
  assert.equal(current.stage, "bulk_production");
  assert.equal(current.productionStage, "order_received");
  await assert.rejects(
    service.advanceCustomerStage({ orderId: order.id, targetStage: "balance_paid", actor: "admin01" }),
    (error) => error.errorCode === "PRODUCTION_NOT_COMPLETE"
  );
  for (const stage of FACTORY_PRODUCTION_STAGES.slice(1)) {
    current = await service.advanceProductionStage({ orderId: order.id, targetStage: stage.id, actor: "admin01" });
  }
  assert.equal(current.productionStage, "dispatched");
  for (const stage of CUSTOMER_ORDER_STAGES.slice(10)) {
    current = await service.advanceCustomerStage({ orderId: order.id, targetStage: stage.id, actor: "admin01" });
  }
  assert.equal(current.stage, "shipped");
  assert.equal(current.status, "completed");
  assert.equal(current.timeline.length, CUSTOMER_ORDER_STAGES.length + FACTORY_PRODUCTION_STAGES.length);

  const customerView = (await service.getCustomerOrder(order.id, customer.phoneHash));
  assert.equal(customerView.customerId, undefined);
  assert.equal(customerView.summary, undefined);
  assert.equal(customerView.externalReference, undefined);
  assert.ok(customerView.timeline.every((item) => item.actor === undefined && item.note === undefined));

  const snapshot = await fs.readFile(path.join(directory, "operations.json"), "utf8");
  assert.doesNotMatch(snapshot, /13800138000/);
  assert.doesNotMatch(snapshot, new RegExp(login.developmentCode));
});

test("order APIs separate customer, administrator and developer views", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-order-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: "test", SUPPORT_PROVIDER: "mock", OPERATIONS_ENABLED: "true", OPERATIONS_DATA_DIR: directory,
    OPERATIONS_ADMIN_PASSWORD: "administrator-password-123", OPERATIONS_SESSION_SECRET: SESSION_SECRET,
    OPERATIONS_DEVELOPER_TOKEN: "developer-token-0123456789abcdef", ORDER_SMS_PROVIDER: "mock", RATE_LIMIT_MAX: "1000"
  });
  const app = await buildApp(config);
  t.after(() => app.close());

  const adminLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "admin", password: "administrator-password-123" } });
  const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };
  const requested = await app.inject({ method: "POST", url: "/api/customer/auth/sms/request", payload: { phone: "13800138000" } });
  assert.equal(requested.statusCode, 202);
  const verified = await app.inject({ method: "POST", url: "/api/customer/auth/sms/verify", payload: { challengeId: requested.json().challengeId, code: requested.json().developmentCode } });
  const customerHeaders = { authorization: `Bearer ${verified.json().token}` };

  const created = await app.inject({ method: "POST", url: "/api/admin/orders", headers: adminHeaders, payload: { customerPhone: "13800138000", title: "礼品盒" } });
  assert.equal(created.statusCode, 201);
  const customerOrders = (await app.inject({ method: "GET", url: "/api/customer/orders", headers: customerHeaders })).json();
  assert.equal(customerOrders.items.length, 1);
  assert.equal(customerOrders.customer.phoneMasked, "+86****8000");
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/orders", headers: adminHeaders })).json().items.length, 1);
  assert.equal((await app.inject({ method: "GET", url: "/api/developer/order-system", headers: adminHeaders })).statusCode, 200);

  const firstSettings = await app.inject({
    method: "PUT", url: "/api/developer/order-system/settings", headers: adminHeaders,
    payload: { customerVisibleProduction: false, customerStageSlaDays: { quoted: 2 }, productionStageSlaHours: { printing: 12 } }
  });
  assert.equal(firstSettings.statusCode, 200, firstSettings.body);
  const status = await app.inject({ method: "GET", url: "/api/developer/order-system", headers: adminHeaders });
  assert.deepEqual(status.json().settings, { customerVisibleProduction: false, customerStageSlaDays: { quoted: 2 }, productionStageSlaHours: { printing: 12 } });
  const secondSettings = await app.inject({ method: "PUT", url: "/api/developer/order-system/settings", headers: adminHeaders, payload: status.json().settings });
  assert.equal(secondSettings.statusCode, 200, secondSettings.body);

  const logout = await app.inject({ method: "DELETE", url: "/api/customer/auth/session", headers: customerHeaders });
  assert.equal(logout.statusCode, 204, logout.body);
  assert.equal((await app.inject({ method: "GET", url: "/api/customer/orders", headers: customerHeaders })).statusCode, 401);
});
