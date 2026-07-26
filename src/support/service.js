import { classifyMessage, POLICY } from "./policy.js";
import { newSessionId } from "../stores/session-store.js";

export class SupportService {
  constructor({ config, sessionStore, provider, handoff, operatorControl }) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.provider = provider;
    this.handoff = handoff;
    this.operatorControl = operatorControl;
  }

  async chat({ identity, sessionId, message, options = {} }) {
    let session;
    if (sessionId) {
      session = await this.sessionStore.get(identity.tenantId, identity.userId, sessionId);
      if (!session) {
        const error = new Error("会话不存在、已过期或不属于当前用户。");
        error.statusCode = 404;
        throw error;
      }
    } else {
      sessionId = newSessionId();
      session = { history: [], unresolvedCount: 0, createdAt: new Date().toISOString() };
    }

    const policy = classifyMessage(message);
    if (this.config.AUTH_MODE === "public" && POLICY.orderStatus.test(message)) {
      sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
      return {
        sessionId,
        action: "manual_required",
        answer: "订单、发货和物流查询需要登录后的身份校验。公开站点不会查询或展示订单信息，请联系业务人员通过正式渠道确认。",
        citations: []
      };
    }
    const operatorRequiresHuman = this.operatorControl && this.operatorControl.mode !== "auto";
    if (!this.config.AI_SERVICE_ENABLED || operatorRequiresHuman || policy.action === "handoff") {
      if (policy.reason === "restricted_business" && /投诉|complaint/i.test(message) && typeof this.provider.recordGovernanceSignal === "function") {
        void this.provider.recordGovernanceSignal({ sessionId, signal: "major_complaint" })?.catch(() => {});
      }
      if (this.config.AUTH_MODE === "public") {
        session.manualRequired = true;
        sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
        return {
          sessionId,
          action: "manual_required",
          answer: "这项业务需要人工核验。公开站点不会创建真实工单，请通过公司的正式联系方式联系业务人员。",
          citations: []
        };
      }
      const reason = !this.config.AI_SERVICE_ENABLED ? "kill_switch" : operatorRequiresHuman ? `operator_mode_${this.operatorControl.mode}` : policy.reason;
      const ticket = await this.handoff.create({ ...identity, sessionId, reason, unresolvedQuestion: message });
      session.handoffTicketId = ticket.id;
      sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
      return {
        sessionId,
        action: "handoff",
        answer: operatorRequiresHuman
          ? "当前由人工审核和接管回复，我已为你建立人工服务请求。"
          : policy.reason === "restricted_business"
          ? "这项业务需要人工客服核验和处理，我已为你建立人工服务请求。"
          : "已为你建立人工服务请求，客服会按队列继续处理。",
        ticketId: ticket.id,
        citations: []
      };
    }

    const result = await this.provider.answer({ message, identity, session, sessionId, options });
    if (result.action === "handoff_required") {
      const historyLimit = this.config.SESSION_BACKEND === "stateless" ? 4 : 8;
      session.history = [...session.history, { user: message, assistant: result.answer }].slice(-historyLimit);
      session.manualRequired = true;
      if (this.config.AUTH_MODE === "public") {
        sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
        return { sessionId, action: "manual_required", answer: result.answer, citations: [] };
      }
      const ticket = await this.handoff.create({
        ...identity,
        sessionId,
        reason: "thought_layer_review_failed",
        unresolvedQuestion: message,
        handoffReport: result.handoffReport
      });
      session.handoffTicketId = ticket.id;
      sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
      return { sessionId, action: "handoff", answer: result.answer, ticketId: ticket.id, citations: [] };
    }
    session.unresolvedCount = result.grounded ? 0 : session.unresolvedCount + 1;
    const historyLimit = this.config.SESSION_BACKEND === "stateless" ? 4 : 8;
    session.history = [...session.history, { user: message, assistant: result.answer }].slice(-historyLimit);
    session.lastResponseId = result.responseId;

    if (session.unresolvedCount >= 2) {
      if (this.config.AUTH_MODE === "public") {
        session.manualRequired = true;
        sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
        return { sessionId, action: "manual_required", answer: "连续两次没有找到足够可靠的资料。公开站点不会创建真实工单，请通过公司的正式联系方式联系业务人员。", citations: [] };
      }
      const ticket = await this.handoff.create({ ...identity, sessionId, reason: "repeated_unresolved", unresolvedQuestion: message });
      session.handoffTicketId = ticket.id;
      sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
      return { sessionId, action: "handoff", answer: "连续两次未能从知识库中找到可靠答案，已为你转交人工客服。", ticketId: ticket.id, citations: [] };
    }

    sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
    return { sessionId, action: result.action, answer: result.answer, citations: result.citations || [] };
  }

  async requestHandoff({ identity, sessionId, message = "用户主动请求人工客服" }) {
    const session = await this.sessionStore.get(identity.tenantId, identity.userId, sessionId);
    if (!session) {
      const error = new Error("会话不存在、已过期或不属于当前用户。");
      error.statusCode = 404;
      throw error;
    }
    if (this.config.AUTH_MODE === "public") {
      session.manualRequired = true;
      sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
      return { sessionId, action: "manual_required", answer: "公开站点不会创建真实工单，请通过公司的正式联系方式联系业务人员。" };
    }
    const ticket = await this.handoff.create({ ...identity, sessionId, reason: "explicit_request", unresolvedQuestion: message });
    session.handoffTicketId = ticket.id;
    sessionId = (await this.sessionStore.save(identity.tenantId, identity.userId, sessionId, session)) || sessionId;
    return { sessionId, action: "handoff", answer: "已为你建立人工服务请求。", ticketId: ticket.id, citations: [] };
  }
}
