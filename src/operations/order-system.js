import crypto from "node:crypto";

export const CUSTOMER_ORDER_STAGES = Object.freeze([
  ["inquiry", "询盘状态", "Inquiry"],
  ["quoted", "报价", "Quotation"],
  ["price_confirmed", "确认价格", "Price confirmed"],
  ["files_received", "提供文件", "Files received"],
  ["layout_confirmed", "排版确认", "Layout confirmed"],
  ["sample_ordered", "下单打样", "Sample ordered"],
  ["sample_confirmed", "样品确认", "Sample confirmed"],
  ["bulk_ordered", "下大货单", "Bulk order placed"],
  ["deposit_arranged", "安排订金", "Deposit arranged"],
  ["bulk_production", "大货生产", "Bulk production"],
  ["balance_paid", "支付尾款", "Balance paid"],
  ["shipped", "订单发货", "Order shipped"]
].map(([id, labelZh, labelEn], index) => Object.freeze({ id, labelZh, labelEn, index })));

export const FACTORY_PRODUCTION_STAGES = Object.freeze([
  ["order_received", "接到客户订单", "Order received"],
  ["production_order_created", "开生产单", "Production order created"],
  ["materials_prepared", "备料", "Materials prepared"],
  ["prepress_layout", "排版", "Prepress layout"],
  ["materials_issued", "发料", "Materials issued"],
  ["printing", "印刷", "Printing"],
  ["surface_finishing", "表面工艺处理", "Surface finishing"],
  ["laminating", "裱合", "Laminating"],
  ["die_cutting", "啤切", "Die cutting"],
  ["stamping", "冲压", "Stamping"],
  ["box_assembly", "包盒", "Box assembly"],
  ["packing", "包装", "Packing"],
  ["dispatched", "出货", "Dispatched"]
].map(([id, labelZh, labelEn], index) => Object.freeze({ id, labelZh, labelEn, index })));

const CUSTOMER_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const DEFAULT_ORDER_SETTINGS = Object.freeze({
  customerVisibleProduction: true,
  customerStageSlaDays: {},
  productionStageSlaHours: {}
});

function clone(value) { return structuredClone(value); }
function fail(message, statusCode = 400, errorCode, safeToExpose = false) {
  throw Object.assign(new Error(message), { statusCode, ...(errorCode ? { errorCode } : {}), ...(safeToExpose ? { safeToExpose: true } : {}) });
}
function hmac(secret, value) { return crypto.createHmac("sha256", secret).update(String(value)).digest("hex"); }
function normalizePhone(value) {
  const compact = String(value || "").trim().replace(/[\s()-]/g, "");
  const normalized = /^1[3-9]\d{9}$/.test(compact) ? `+86${compact}` : compact;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) fail("请输入有效的手机号码。", 400, "INVALID_PHONE");
  return normalized;
}
function maskPhone(phone) { return `${phone.slice(0, 3)}****${phone.slice(-4)}`; }
function stageById(stages, value) { return stages.find((item) => item.id === value); }
function orderSettings(value = {}) {
  return {
    customerVisibleProduction: value.customerVisibleProduction !== false,
    customerStageSlaDays: clone(value.customerStageSlaDays || {}),
    productionStageSlaHours: clone(value.productionStageSlaHours || {})
  };
}
function customerOrder(order, customerVisibleProduction = true) {
  const safe = {
    id: order.id,
    quoteId: order.quoteId,
    customerPhoneMasked: order.customerPhoneMasked,
    title: order.title,
    stage: order.stage,
    stageIndex: order.stageIndex,
    productionStage: order.productionStage,
    productionStageIndex: order.productionStageIndex,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    timeline: (order.timeline || []).map(({ kind, stage, at }) => ({ kind, stage, at }))
  };
  if (!customerVisibleProduction) {
    safe.productionStage = null;
    safe.productionStageIndex = null;
    safe.timeline = safe.timeline.filter((item) => item.kind !== "production");
  }
  return safe;
}

export class OrderSystemService {
  constructor({ store, sessionSecret, smsProvider, clock = () => Date.now() } = {}) {
    if (!store) throw new Error("OrderSystemService requires a store");
    if (!sessionSecret || String(sessionSecret).length < 32) throw new Error("OrderSystemService requires a session secret");
    this.store = store;
    this.secret = String(sessionSecret);
    this.smsProvider = smsProvider || null;
    this.clock = clock;
  }

  timestamp() { return new Date(this.clock()).toISOString(); }

  async requestLoginCode(phoneInput) {
    const phone = normalizePhone(phoneInput);
    if (!this.smsProvider) fail("手机号验证码登录待接入短信服务。", 503, "SMS_NOT_CONFIGURED", true);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const challengeId = `SMS-${crypto.randomUUID()}`;
    const createdAt = this.timestamp();
    const expiresAt = new Date(this.clock() + CODE_TTL_MS).toISOString();
    const phoneHash = hmac(this.secret, `phone:${phone}`);
    const challengeSequence = await this.store.transact((state) => {
      state.customerAuthChallenges ||= {};
      for (const [key, item] of Object.entries(state.customerAuthChallenges)) {
        if (Date.parse(item.expiresAt) <= this.clock()) delete state.customerAuthChallenges[key];
      }
      state.sequence = Number(state.sequence || 0) + 1;
      state.customerAuthChallenges[challengeId] = {
        id: challengeId, phoneHash, phoneMasked: maskPhone(phone), codeHash: hmac(this.secret, `${challengeId}:${code}`),
        attempts: 0, deliveryStatus: "pending", sequence: state.sequence, createdAt, expiresAt
      };
      return state.sequence;
    });
    try {
      await this.smsProvider.sendCode({ phone, code, expiresAt, challengeId });
    } catch (error) {
      await this.store.transact((state) => { delete state.customerAuthChallenges?.[challengeId]; });
      await this.store.appendEvent({ kind: "audit", action: "customer.sms_failed", actor: phoneHash.slice(0, 16), entityId: challengeId });
      if (error?.errorCode === "SMS_DELIVERY_FAILED") throw error;
      fail("短信服务暂时不可用，请稍后重试。", 502, "SMS_DELIVERY_FAILED", true);
    }
    const activated = await this.store.transact((state) => {
      const challenge = state.customerAuthChallenges?.[challengeId];
      if (!challenge) return false;
      challenge.deliveryStatus = "sent";
      for (const [key, item] of Object.entries(state.customerAuthChallenges)) {
        if (key !== challengeId && item.phoneHash === phoneHash && Number(item.sequence || 0) < challengeSequence) {
          delete state.customerAuthChallenges[key];
        }
      }
      return true;
    });
    await this.store.appendEvent({
      kind: "audit", action: activated ? "customer.sms_sent" : "customer.sms_superseded",
      actor: phoneHash.slice(0, 16), entityId: challengeId
    });
    if (!activated) fail("验证码已被较新的请求替代，请使用最新验证码。", 409, "CODE_SUPERSEDED");
    return { challengeId, phoneMasked: maskPhone(phone), expiresAt, ...(this.smsProvider.exposeCode ? { developmentCode: code } : {}) };
  }

  async verifyLoginCode({ challengeId, code }) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hmac(this.secret, `customer-session:${token}`);
    const verifiedAt = this.timestamp();
    const expiresAt = new Date(this.clock() + CUSTOMER_SESSION_TTL_MS).toISOString();
    const result = await this.store.transact((state) => {
      state.customerAuthChallenges ||= {};
      state.customerSessions ||= {};
      for (const [key, item] of Object.entries(state.customerSessions)) {
        if (Date.parse(item.expiresAt) <= this.clock()) delete state.customerSessions[key];
      }
      const challenge = state.customerAuthChallenges[challengeId];
      if (!challenge || challenge.deliveryStatus !== "sent" || Date.parse(challenge.expiresAt) <= this.clock()) {
        if (challenge) delete state.customerAuthChallenges[challengeId];
        return { outcome: "expired" };
      }
      const suppliedHash = hmac(this.secret, `${challengeId}:${code}`);
      if (!crypto.timingSafeEqual(Buffer.from(challenge.codeHash), Buffer.from(suppliedHash))) {
        challenge.attempts += 1;
        const locked = challenge.attempts >= MAX_CODE_ATTEMPTS;
        if (locked) delete state.customerAuthChallenges[challengeId];
        return { outcome: locked ? "locked" : "invalid" };
      }
      delete state.customerAuthChallenges[challengeId];
      const record = { id: crypto.randomUUID(), phoneHash: challenge.phoneHash, phoneMasked: challenge.phoneMasked, createdAt: verifiedAt, expiresAt };
      state.customerSessions[tokenHash] = record;
      return { outcome: "verified", record };
    });
    await this.store.appendEvent({ kind: "audit", action: `customer.login_${result.outcome}`, actor: "customer", entityId: challengeId });
    if (result.outcome === "expired") fail("验证码已过期，请重新获取。", 401, "CODE_EXPIRED");
    if (result.outcome === "locked") fail("验证码错误次数过多，请重新获取。", 401, "CODE_ATTEMPTS_EXCEEDED");
    if (result.outcome === "invalid") fail("验证码不正确。", 401, "INVALID_CODE");
    return { token, expiresAt, customer: { phoneMasked: result.record.phoneMasked } };
  }

  async authenticate(token) {
    if (!token) return null;
    const tokenHash = hmac(this.secret, `customer-session:${token}`);
    return this.store.read((state) => {
      const session = state.customerSessions?.[tokenHash];
      return session && Date.parse(session.expiresAt) > this.clock() ? session : null;
    });
  }

  async revokeSession(token) {
    if (!token) return false;
    const tokenHash = hmac(this.secret, `customer-session:${token}`);
    const removed = await this.store.transact((state) => {
      const session = state.customerSessions?.[tokenHash];
      if (!session) return false;
      delete state.customerSessions[tokenHash];
      return true;
    });
    if (removed) await this.store.appendEvent({ kind: "audit", action: "customer.logout", actor: "customer" });
    return removed;
  }

  async createOrder({ quoteId = null, customerPhone, title, summary = "", externalReference = "" }, actor) {
    const phone = normalizePhone(customerPhone);
    const customerId = hmac(this.secret, `phone:${phone}`);
    const createdAt = this.timestamp();
    const first = CUSTOMER_ORDER_STAGES[0];
    const audit = { kind: "audit", action: "order.created", actor, quoteId };
    return this.store.transact((state) => {
      state.orders ||= {};
      const quote = quoteId ? state.quotes?.[quoteId] : null;
      if (quoteId && !quote) fail("关联询价不存在。", 404, "QUOTE_NOT_FOUND");
      if (quote) {
        const existingOrder = quote.orderId ? state.orders[quote.orderId] : Object.values(state.orders).find((item) => item.quoteId === quoteId);
        if (existingOrder) fail("该询价已经建立订单。", 409, "QUOTE_ALREADY_CONVERTED");
        if (!String(quote.contact?.phone || "").trim()) fail("该询价缺少手机号码，请先向客户补充。", 409, "QUOTE_PHONE_REQUIRED");
        let quotePhone;
        try { quotePhone = normalizePhone(quote.contact.phone); }
        catch (_error) { fail("该询价的手机号码无效，请先向客户核实。", 409, "QUOTE_PHONE_INVALID"); }
        if (quotePhone !== phone) fail("订单手机号必须与关联询价一致。", 409, "QUOTE_PHONE_MISMATCH");
      }
      state.sequence = Number(state.sequence || 0) + 1;
      const reference = `QO-${createdAt.slice(0, 10).replaceAll("-", "")}-${String(state.sequence).padStart(6, "0")}`;
      const order = {
        id: reference, quoteId, customerId, customerPhoneMasked: maskPhone(phone), title, summary, externalReference,
        stage: first.id, stageIndex: first.index, productionStage: null, productionStageIndex: null,
        status: "active", createdAt, updatedAt: createdAt,
        timeline: [{ kind: "customer", stage: first.id, at: createdAt, actor, note: "订单流程已建立" }]
      };
      state.orders[order.id] = order;
      if (quote) {
        quote.status = "converted";
        quote.orderId = order.id;
        quote.updatedAt = createdAt;
      }
      audit.entityId = order.id;
      return clone(order);
    }, audit);
  }

  async listOrders({ customerId, status } = {}) {
    return this.store.read((state) => Object.values(state.orders || {})
      .filter((item) => (!customerId || item.customerId === customerId) && (!status || item.status === status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(clone));
  }

  async getOrder(orderId, customerId) {
    return this.store.read((state) => {
      const order = state.orders?.[orderId];
      if (!order || (customerId && order.customerId !== customerId)) return null;
      return clone(order);
    });
  }

  async listCustomerOrders(customerId) {
    return this.store.read((state) => {
      const visible = state.orderSystemConfig?.customerVisibleProduction !== false;
      return Object.values(state.orders || {}).filter((item) => item.customerId === customerId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => customerOrder(item, visible));
    });
  }

  async getCustomerOrder(orderId, customerId) {
    return this.store.read((state) => {
      const order = state.orders?.[orderId];
      if (!order || order.customerId !== customerId) return null;
      return customerOrder(order, state.orderSystemConfig?.customerVisibleProduction !== false);
    });
  }

  async advanceCustomerStage({ orderId, targetStage, note = "", actor }) {
    return this.store.transact((state) => {
      const order = state.orders?.[orderId];
      if (!order) return null;
      const target = stageById(CUSTOMER_ORDER_STAGES, targetStage);
      if (!target || target.index !== order.stageIndex + 1) fail("订单必须按固定流程逐步推进。", 409, "INVALID_ORDER_TRANSITION");
      if (target.id === "balance_paid" && order.productionStage !== "dispatched") {
        fail("工厂生产流程尚未完成出货准备，不能进入支付尾款。", 409, "PRODUCTION_NOT_COMPLETE");
      }
      order.stage = target.id;
      order.stageIndex = target.index;
      if (target.id === "shipped") order.status = "completed";
      order.updatedAt = this.timestamp();
      order.timeline.push({ kind: "customer", stage: target.id, at: order.updatedAt, actor, note });
      if (target.id === "bulk_production" && order.productionStage == null) {
        order.productionStage = FACTORY_PRODUCTION_STAGES[0].id;
        order.productionStageIndex = 0;
        order.timeline.push({ kind: "production", stage: order.productionStage, at: order.updatedAt, actor, note: "生产流程已启动" });
      }
      return clone(order);
    }, { kind: "audit", action: "order.stage_advanced", actor, entityId: orderId, targetStage });
  }

  async advanceProductionStage({ orderId, targetStage, note = "", actor }) {
    return this.store.transact((state) => {
      const order = state.orders?.[orderId];
      if (!order) return null;
      if (order.stageIndex < stageById(CUSTOMER_ORDER_STAGES, "bulk_production").index) fail("订单尚未进入大货生产。", 409, "PRODUCTION_NOT_STARTED");
      const target = stageById(FACTORY_PRODUCTION_STAGES, targetStage);
      if (!target || target.index !== order.productionStageIndex + 1) fail("生产必须按固定工序逐步推进。", 409, "INVALID_PRODUCTION_TRANSITION");
      order.productionStage = target.id;
      order.productionStageIndex = target.index;
      order.updatedAt = this.timestamp();
      order.timeline.push({ kind: "production", stage: target.id, at: order.updatedAt, actor, note });
      return clone(order);
    }, { kind: "audit", action: "order.production_advanced", actor, entityId: orderId, targetStage });
  }

  async systemStatus() {
    const [orders, settings] = await Promise.all([
      this.listOrders(),
      this.store.read((state) => orderSettings(state.orderSystemConfig || DEFAULT_ORDER_SETTINGS))
    ]);
    return {
      status: "operational",
      orders: { total: orders.length, active: orders.filter((item) => item.status === "active").length },
      customerStages: CUSTOMER_ORDER_STAGES,
      productionStages: FACTORY_PRODUCTION_STAGES,
      sms: { configured: Boolean(this.smsProvider), provider: this.smsProvider?.name || "待补充" },
      settings,
      checkedAt: this.timestamp()
    };
  }

  async updateSettings(settings, actor) {
    return this.store.transact((state) => {
      state.orderSystemConfig = { ...clone(settings), updatedAt: this.timestamp(), updatedBy: actor };
      return clone(state.orderSystemConfig);
    }, { kind: "audit", action: "order.settings_updated", actor });
  }
}
