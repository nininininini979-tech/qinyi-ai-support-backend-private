import crypto from "node:crypto";
import { maskPii } from "../security.js";
import {
  createRuntimeRulesRevision,
  normalizeRuntimeRules,
  parseRuntimeRulesUpdate,
  storedRuntimeRules
} from "./runtime-rules.js";

function id(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function listByTime(values) {
  return Object.values(values).sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
}

function compactPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const serialized = JSON.stringify(payload);
  if (serialized.length > 8_000) throw Object.assign(new Error("事件数据过大。"), { statusCode: 400 });
  return JSON.parse(serialized);
}

function nextSequence(state) {
  state.sequence = Number(state.sequence || 0) + 1;
  return state.sequence;
}

function quoteReference(createdAt, sequence) {
  return `QY-${createdAt.slice(0, 10).replaceAll("-", "")}-${String(sequence).padStart(6, "0")}`;
}

function publicQuoteAttachment(record) {
  return {
    id: record.id,
    filename: record.filename,
    mimeType: record.mimeType,
    size: record.size,
    status: record.status,
    createdAt: record.createdAt,
    downloadable: record.status === "available",
    downloadUrl: `/api/admin/attachments/${record.id}/file`
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_ANALYTICS_RETENTION_MS = 90 * DAY_MS;

export const DEFAULT_OPERATOR_SCHEDULE = Object.freeze({
  timezone: "Asia/Shanghai",
  windows: Object.freeze([
    Object.freeze({ id: "morning", label: "上午", days: Object.freeze([1, 2, 3, 4, 5, 6, 7]), start: "08:00", end: "12:00" }),
    Object.freeze({ id: "afternoon", label: "下午", days: Object.freeze([1, 2, 3, 4, 5, 6, 7]), start: "13:30", end: "17:30" }),
    Object.freeze({ id: "evening", label: "晚间", days: Object.freeze([1, 2, 3, 4, 5, 6, 7]), start: "18:00", end: "21:00" })
  ])
});

export const ANONYMOUS_EVENT_TYPES = Object.freeze([
  "page_view", "navigation_click", "cta_click", "product_view", "home_feature_click",
  "customizer_opened", "customizer_step_completed", "customizer_completed",
  "quote_opened", "quote_started", "quote_submitted", "chat_opened",
  "handoff_requested", "contact_submitted"
]);

const ANONYMOUS_EVENT_SET = new Set(ANONYMOUS_EVENT_TYPES);
const WEEKDAYS = Object.freeze({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 });

function ensureWorkflowState(state) {
  state.handoffTransfers ||= {};
  state.internalNotes ||= {};
  state.attachments ||= {};
  state.aiDrafts ||= {};
  state.extraDuty ||= {};
  state.operatorSchedule ||= structuredClone(DEFAULT_OPERATOR_SCHEDULE);
  state.anonymousAnalytics ||= { raw: [], aggregates: {}, lastReceivedAt: null };
  state.anonymousAnalytics.raw ||= [];
  state.anonymousAnalytics.aggregates ||= {};
  return state;
}

function minutes(value) {
  const [hour, minute] = String(value).split(":").map(Number);
  return hour * 60 + minute;
}

function zonedClock(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { day: WEEKDAYS[values.weekday], minute: Number(values.hour) * 60 + Number(values.minute) };
}

function aggregateDay(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function safePath(value) {
  const result = String(value || "/").split(/[?#]/, 1)[0].slice(0, 160);
  return result.startsWith("/") && !result.startsWith("//") ? result : "/";
}

function safeDimensions(input = {}) {
  const dimensions = {
    path: safePath(input.path),
    locale: /^[a-z]{2}(?:-[A-Z]{2})?$/.test(String(input.locale || "")) ? String(input.locale) : "unknown",
    surface: ["home", "navigation", "product", "customizer", "quote", "chat", "content", "other"].includes(input.surface) ? input.surface : "other",
    deviceClass: ["desktop", "tablet", "mobile", "unknown"].includes(input.deviceClass) ? input.deviceClass : "unknown",
    source: ["direct", "search", "social", "referral", "campaign", "internal", "unknown"].includes(input.source) ? input.source : "unknown"
  };
  if (/^[a-zA-Z0-9._:-]{1,80}$/.test(String(input.targetId || ""))) dimensions.targetId = String(input.targetId);
  return dimensions;
}

function thirteenMonthsAgo(timestamp) {
  const value = new Date(timestamp);
  value.setUTCMonth(value.getUTCMonth() - 13);
  return value.getTime();
}

const HANDOFF_TRANSITIONS = Object.freeze({
  waiting_human: new Set(["acknowledged", "human_active", "closed"]),
  acknowledged: new Set(["human_active", "closed"]),
  human_active: new Set(["waiting_customer", "resolved", "closed"]),
  waiting_customer: new Set(["human_active", "resolved", "closed"]),
  resolved: new Set(["closed"]),
  closed: new Set()
});

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function closeTransferNotifications(state, transferId, status, updatedAt) {
  for (const notification of Object.values(state.notifications)) {
    if (notification.transferId !== transferId || notification.status !== "pending") continue;
    notification.status = status;
    notification.updatedAt = updatedAt;
  }
}

function conversationMatchesSession(conversation, tenantId, visitorId, sessionId) {
  return conversation.tenantId === tenantId &&
    conversation.visitorId === visitorId &&
    conversation.status !== "closed" &&
    (!sessionId || conversation.externalSessionIds.includes(sessionId));
}

function handoffMatchesSession(state, handoff, tenantId, visitorId, sessionId) {
  if (handoff.tenantId !== tenantId || handoff.visitorId !== visitorId) return false;
  if (["resolved", "closed"].includes(handoff.status)) return false;
  if (!sessionId) return true;
  const conversation = state.conversations[handoff.conversationId];
  return handoff.sessionId === sessionId || conversation?.externalSessionIds.includes(sessionId);
}

function ensureConversation(state, { tenantId, visitorId, sessionId, channel = "web", createdAt = now() }) {
  let conversation = listByTime(state.conversations).find((item) =>
    conversationMatchesSession(item, tenantId, visitorId, sessionId)
  );
  if (!conversation) {
    conversation = {
      id: id("CONV"), tenantId, visitorId, status: "open", mode: "ai", channel,
      createdAt, updatedAt: createdAt, messageIds: [], externalSessionIds: []
    };
    state.conversations[conversation.id] = conversation;
  }
  if (sessionId && !conversation.externalSessionIds.includes(sessionId)) conversation.externalSessionIds.push(sessionId);
  return conversation;
}

function appendMessage(state, conversation, input) {
  const message = {
    id: id("MSG"),
    sequence: nextSequence(state),
    conversationId: conversation.id,
    role: input.role,
    content: String(input.content || ""),
    createdAt: input.createdAt || now(),
    ...(input.action ? { action: input.action } : {}),
    ...(input.citations ? { citations: input.citations } : {}),
    ...(input.actor ? { actor: input.actor } : {})
  };
  state.messages[message.id] = message;
  conversation.messageIds.push(message.id);
  conversation.updatedAt = message.createdAt;
  return message;
}

export class OperationsService {
  constructor({ store }) {
    this.store = store;
  }

  async createQuote({ tenantId, visitorId, input }) {
    const createdAt = now();
    const actor = `visitor:${crypto.createHash("sha256").update(`${tenantId}:${visitorId}`).digest("hex").slice(0, 24)}`;
    const audit = { kind: "audit", action: "quote.created", actor };
    return this.store.transact((state) => {
      state.quotes ||= {};
      state.uploads ||= {};
      state.attachments ||= {};
      const attachmentIds = [...new Set(input.attachmentIds || [])];
      const attachments = attachmentIds.map((attachmentId) => {
        const upload = state.uploads[attachmentId];
        if (!upload || upload.scope !== "visitor" || upload.purpose !== "quote" || upload.status !== "available") {
          throw Object.assign(new Error("询价附件不存在或不可用。"), { statusCode: 400 });
        }
        if (upload.owner?.tenantId !== tenantId || upload.owner?.visitorId !== visitorId) {
          throw Object.assign(new Error("询价附件不属于当前访客。"), { statusCode: 403 });
        }
        if (upload.quoteId) throw conflict("询价附件已经用于其他询价。");
        return upload;
      });
      const sequence = nextSequence(state);
      const quote = {
        id: quoteReference(createdAt, sequence),
        tenantId,
        visitorId,
        status: "new",
        ...input,
        attachmentIds,
        createdAt,
        updatedAt: createdAt
      };
      state.quotes[quote.id] = quote;
      audit.entityId = quote.id;
      audit.attachmentCount = attachmentIds.length;
      for (const attachment of attachments) {
        attachment.quoteId = quote.id;
        state.attachments[attachment.id] = attachment;
      }
      return { id: quote.id, status: quote.status, createdAt: quote.createdAt };
    }, audit);
  }

  async listQuotes({ status, limit = 100 } = {}) {
    return this.store.read((state) => listByTime(state.quotes || {})
      .filter((item) => !status || item.status === status)
      .slice(0, Math.min(limit, 500))
      .map((item) => ({
        id: item.id,
        status: item.status,
        name: item.name,
        company: item.company,
        product: item.product,
        quantity: item.quantity,
        delivery: item.delivery,
        attachmentCount: item.attachmentIds?.length || 0,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })));
  }

  async getQuote(quoteId) {
    return this.store.read((state) => {
      const quote = state.quotes?.[quoteId];
      if (!quote) return null;
      const { tenantId: _tenantId, visitorId: _visitorId, attachmentIds = [], ...detail } = quote;
      return {
        ...detail,
        attachments: attachmentIds.map((attachmentId) => state.attachments?.[attachmentId]).filter(Boolean).map(publicQuoteAttachment)
      };
    });
  }

  async recordExchange({ tenantId, visitorId, sessionId, message, result, options = {} }) {
    const createdAt = now();
    return this.store.transact((state) => {
      const resultHandoff = result.ticketId ? state.handoffs[result.ticketId] : null;
      const ownedHandoff = resultHandoff?.tenantId === tenantId && resultHandoff?.visitorId === visitorId ? resultHandoff : null;
      const conversation = ownedHandoff
        ? state.conversations[ownedHandoff.conversationId]
        : ensureConversation(state, { tenantId, visitorId, sessionId, channel: options.channel || "web", createdAt });
      if (!conversation) throw Object.assign(new Error("人工服务会话不存在。"), { statusCode: 409 });
      if (sessionId && !conversation.externalSessionIds.includes(sessionId)) conversation.externalSessionIds.push(sessionId);
      if (ownedHandoff && sessionId) ownedHandoff.sessionId = sessionId;
      appendMessage(state, conversation, { role: "customer", content: message, createdAt });
      if (String(result.answer || "").trim()) {
        appendMessage(state, conversation, {
          role: "assistant", content: result.answer, action: result.action,
          citations: result.citations || [], createdAt
        });
      }
      conversation.lastAction = result.action;
      const handoff = ownedHandoff || (conversation.handoffId ? state.handoffs[conversation.handoffId] : null);
      if (handoff?.status === "waiting_customer") {
        handoff.status = "human_active";
        handoff.updatedAt = createdAt;
        conversation.mode = "human_active";
      }
      if (handoff?.systemNoticePending) {
        appendMessage(state, conversation, { role: "system", content: "已创建人工服务请求，正在通知勤益客服。", createdAt });
        delete handoff.systemNoticePending;
      }
      return { conversationId: conversation.id, handoff: handoff || undefined };
    }, { kind: "audit", action: "conversation.exchange_recorded", actor: "support", sessionId });
  }

  async closeConversation({ tenantId, visitorId, sessionId }) {
    return this.store.transact((state) => {
      const conversation = listByTime(state.conversations).find((item) =>
        conversationMatchesSession(item, tenantId, visitorId, sessionId)
      );
      if (!conversation) return false;
      conversation.status = "closed";
      conversation.updatedAt = now();
      const handoff = conversation.handoffId ? state.handoffs[conversation.handoffId] : null;
      if (handoff && !["resolved", "closed"].includes(handoff.status)) {
        handoff.status = "closed";
        handoff.updatedAt = conversation.updatedAt;
      }
      return true;
    }, { kind: "audit", action: "conversation.closed", actor: "support", sessionId });
  }

  async createHandoff({ tenantId, visitorId, sessionId, reason, unresolvedQuestion, handoffReport, contact }) {
    const createdAt = now();
    return this.store.transact((state) => {
      const existing = Object.values(state.handoffs).find((item) =>
        handoffMatchesSession(state, item, tenantId, visitorId, sessionId)
      );
      if (existing) return existing;
      const conversation = ensureConversation(state, { tenantId, visitorId, sessionId, createdAt });
      const handoff = {
        id: id("OPS"), tenantId, visitorId, sessionId, conversationId: conversation.id,
        status: "waiting_human", priority: reason === "restricted_business" ? "high" : "normal", reason,
        summary: maskPii(String(unresolvedQuestion || "").slice(0, 500)), report: handoffReport || undefined, createdAt, updatedAt: createdAt
      };
      if (contact && Object.values(contact).some(Boolean)) {
        const entry = { id: id("CONTACT"), handoffId: handoff.id, name: contact.name || "", company: contact.company || "", method: contact.method || "", value: contact.value || "", createdAt };
        state.contacts[entry.id] = entry;
        handoff.contactId = entry.id;
      }
      const notification = { id: id("NOTICE"), handoffId: handoff.id, type: "handoff_created", status: "pending", createdAt, updatedAt: createdAt };
      state.handoffs[handoff.id] = handoff;
      state.notifications[notification.id] = notification;
      conversation.mode = "waiting_human";
      conversation.handoffId = handoff.id;
      if (conversation.messageIds.length) {
        appendMessage(state, conversation, { role: "system", content: "已创建人工服务请求，正在通知勤益客服。", createdAt });
      } else {
        handoff.systemNoticePending = true;
      }
      return handoff;
    }, { kind: "audit", action: "handoff.created", actor: "support", sessionId });
  }

  async addContact({ handoffId, contact, actor = "admin" }) {
    return this.store.transact((state) => {
      const handoff = state.handoffs[handoffId];
      if (!handoff) return null;
      const entry = { id: id("CONTACT"), handoffId, ...contact, createdAt: now() };
      state.contacts[entry.id] = entry;
      handoff.contactId = entry.id;
      handoff.updatedAt = now();
      return entry;
    }, { kind: "audit", action: "handoff.contact_added", actor, entityId: handoffId });
  }

  async listConversations({ status, limit = 100 } = {}) {
    return this.store.read((state) => {
      ensureWorkflowState(state);
      return listByTime(state.conversations).filter((item) => !status || item.status === status).slice(0, Math.min(limit, 500)).map((item) => ({
        ...item,
        messageCount: item.messageIds.length,
        pendingDraftCount: Object.values(state.aiDrafts).filter((draft) => draft.conversationId === item.id && draft.status === "pending").length
      }));
    });
  }

  async getConversation(conversationId) {
    return this.store.read((state) => {
      const conversation = state.conversations[conversationId];
      if (!conversation) return null;
      ensureWorkflowState(state);
      return {
        ...conversation,
        messages: conversation.messageIds.map((messageId) => state.messages[messageId]).filter(Boolean),
        handoffs: Object.values(state.handoffs).filter((item) => item.conversationId === conversation.id),
        attachments: Object.values(state.attachments).filter((item) => item.conversationId === conversation.id),
        aiDrafts: listByTime(state.aiDrafts).filter((item) => item.conversationId === conversation.id)
      };
    });
  }

  async createAiDraft({ tenantId, visitorId, sessionId, handoffId, mode, content, citations = [], grounded, responseId }) {
    const createdAt = now();
    const audit = { kind: "audit", action: "ai_draft.created", actor: "agent-company", sessionId };
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const handoff = state.handoffs[handoffId];
      if (!handoff || handoff.tenantId !== tenantId || handoff.visitorId !== visitorId) {
        throw conflict("AI 草稿对应的人工服务请求不存在。");
      }
      const conversation = state.conversations[handoff.conversationId];
      if (!conversation) throw conflict("AI 草稿对应的会话不存在。");
      const normalizedContent = String(content || "").trim().slice(0, 10_000);
      if (!normalizedContent) throw conflict("AI 没有生成可审核的草稿内容。");
      const draft = {
        id: id("AI-DRAFT"),
        conversationId: conversation.id,
        handoffId: handoff.id,
        sessionId,
        mode: ["draft", "observe"].includes(mode) ? mode : "draft",
        status: "pending",
        content: normalizedContent,
        citations: Array.isArray(citations) ? citations.slice(0, 12) : [],
        grounded: Boolean(grounded),
        ...(responseId ? { responseId: String(responseId).slice(0, 240) } : {}),
        createdAt,
        updatedAt: createdAt,
        createdBy: "agent-company"
      };
      state.aiDrafts[draft.id] = draft;
      conversation.mode = "draft_review";
      conversation.updatedAt = createdAt;
      audit.entityId = draft.id;
      audit.conversationId = conversation.id;
      return draft;
    }, audit);
  }

  async listAiDrafts({ status, conversationId, limit = 100 } = {}) {
    return this.store.read((state) => {
      ensureWorkflowState(state);
      return listByTime(state.aiDrafts)
        .filter((item) => (!status || item.status === status) && (!conversationId || item.conversationId === conversationId))
        .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
    });
  }

  async approveAiDraft({ draftId, content, actorUsername, actorDisplayName }) {
    const reviewedAt = now();
    const audit = { kind: "audit", action: "ai_draft.approved", actor: actorDisplayName || actorUsername, entityId: draftId };
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const draft = state.aiDrafts[draftId];
      if (!draft) return null;
      if (draft.status !== "pending") throw conflict("该 AI 草稿已经处理，不能重复发送。");
      const conversation = state.conversations[draft.conversationId];
      const handoff = state.handoffs[draft.handoffId];
      if (!conversation || !handoff || ["resolved", "closed"].includes(handoff.status)) {
        throw conflict("该会话已经结束，草稿不能再发送。");
      }
      if (handoff.assigneeUsername && handoff.assigneeUsername !== actorUsername) {
        throw conflict("该会话已由其他管理员接管，请先完成转交再审核草稿。");
      }
      const finalContent = String(content ?? draft.content).trim().slice(0, 4000);
      if (!finalContent) throw Object.assign(new Error("发送内容不能为空。"), { statusCode: 400 });
      handoff.assignee = actorDisplayName || actorUsername;
      handoff.assigneeUsername = actorUsername;
      handoff.status = "waiting_customer";
      handoff.updatedAt = reviewedAt;
      conversation.mode = "waiting_customer";
      const message = appendMessage(state, conversation, {
        role: "human",
        content: finalContent,
        action: "ai_draft_approved",
        citations: draft.citations,
        actor: actorDisplayName || actorUsername,
        createdAt: reviewedAt
      });
      Object.assign(draft, {
        status: "approved",
        finalContent,
        reviewedBy: actorUsername,
        reviewerName: actorDisplayName || actorUsername,
        reviewedAt,
        updatedAt: reviewedAt,
        messageId: message.id
      });
      audit.conversationId = conversation.id;
      audit.messageId = message.id;
      audit.edited = finalContent !== draft.content;
      return { draft, handoff, message };
    }, audit);
  }

  async rejectAiDraft({ draftId, reason, actorUsername, actorDisplayName }) {
    const reviewedAt = now();
    const audit = { kind: "audit", action: "ai_draft.rejected", actor: actorDisplayName || actorUsername, entityId: draftId };
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const draft = state.aiDrafts[draftId];
      if (!draft) return null;
      if (draft.status !== "pending") throw conflict("该 AI 草稿已经处理，不能重复驳回。");
      Object.assign(draft, {
        status: "rejected",
        rejectionReason: String(reason || "").trim().slice(0, 1000),
        reviewedBy: actorUsername,
        reviewerName: actorDisplayName || actorUsername,
        reviewedAt,
        updatedAt: reviewedAt
      });
      audit.conversationId = draft.conversationId;
      return draft;
    }, audit);
  }

  async listHandoffs({ status, limit = 100 } = {}) {
    return this.store.read((state) => listByTime(state.handoffs).filter((item) => !status || item.status === status).slice(0, Math.min(limit, 500)).map((item) => ({ ...item, contact: item.contactId ? state.contacts[item.contactId] : undefined })));
  }

  async updateHandoff(handoffId, changes, actor = "admin") {
    return this.store.transact((state) => {
      const handoff = state.handoffs[handoffId];
      if (!handoff) return null;
      const nextStatus = changes.status;
      const statusChanged = Boolean(nextStatus && nextStatus !== handoff.status);
      if (statusChanged && !HANDOFF_TRANSITIONS[handoff.status]?.has(nextStatus)) {
        throw conflict(`人工服务状态不能从 ${handoff.status} 变更为 ${nextStatus}。`);
      }
      if (nextStatus === "human_active") {
        const nextAssignee = changes.assignee || handoff.assignee;
        if (!nextAssignee) throw conflict("认领人工会话时必须记录客服身份。");
        if (handoff.assignee && handoff.assignee !== nextAssignee) {
          throw conflict("该会话已由其他客服认领。");
        }
      }
      if (["resolved", "closed"].includes(nextStatus) && handoff.assignee && handoff.assignee !== actor) {
        throw conflict("只有当前接管客服可以结束该人工会话。");
      }
      Object.assign(handoff, changes, { updatedAt: now() });
      const conversation = state.conversations[handoff.conversationId];
      if (conversation && statusChanged) {
        const copy = {
          acknowledged: "勤益客服已收到提醒，正在进入对话。",
          human_active: "勤益人工客服已接管本次对话。",
          waiting_customer: "人工客服正在等待客户回复。",
          resolved: "本轮人工服务已结束，智能客服可以继续提供一般咨询。",
          closed: "本次会话已关闭。"
        }[changes.status];
        conversation.mode = ["resolved", "closed"].includes(changes.status) ? "ai" : changes.status;
        if (changes.status === "closed") conversation.status = "closed";
        if (copy) appendMessage(state, conversation, { role: "system", content: copy, actor });
      }
      return handoff;
    }, { kind: "audit", action: "handoff.updated", actor, entityId: handoffId, changes: Object.keys(changes) });
  }

  async activeHandoff({ tenantId, visitorId, sessionId }) {
    return this.store.read((state) => Object.values(state.handoffs).find((item) =>
      handoffMatchesSession(state, item, tenantId, visitorId, sessionId)
    ) || null);
  }

  async addVisitorMessage({ tenantId, visitorId, sessionId, content }) {
    return this.store.transact((state) => {
      const handoff = Object.values(state.handoffs).find((item) =>
        handoffMatchesSession(state, item, tenantId, visitorId, sessionId)
      );
      if (!handoff) return null;
      const conversation = state.conversations[handoff.conversationId];
      if (!conversation) return null;
      const message = appendMessage(state, conversation, { role: "customer", content });
      handoff.updatedAt = message.createdAt;
      if (handoff.status === "waiting_customer") {
        handoff.status = "human_active";
        conversation.mode = "human_active";
      }
      return { handoff, message };
    }, { kind: "audit", action: "conversation.visitor_message", actor: visitorId, sessionId });
  }

  async addHumanMessage({ conversationId, content, actor = "admin", actorUsername = actor }) {
    return this.store.transact((state) => {
      const conversation = state.conversations[conversationId];
      if (!conversation) return null;
      const handoff = conversation.handoffId ? state.handoffs[conversation.handoffId] : null;
      if (!handoff || !["human_active", "waiting_customer"].includes(handoff.status)) {
        throw Object.assign(new Error("请先认领该会话再发送人工回复。"), { statusCode: 409 });
      }
      const isAssignee = handoff.assigneeUsername
        ? handoff.assigneeUsername === actorUsername
        : handoff.assignee === actor;
      if (!handoff.assignee || !isAssignee) {
        throw conflict("只有当前接管客服可以发送人工回复。");
      }
      const message = appendMessage(state, conversation, { role: "human", content, actor });
      handoff.status = "waiting_customer";
      handoff.updatedAt = message.createdAt;
      return { handoff, message };
    }, { kind: "audit", action: "conversation.human_message", actor, entityId: conversationId });
  }

  async sessionEvents({ tenantId, visitorId, sessionId, after = 0 }) {
    return this.store.read((state) => {
      const conversation = Object.values(state.conversations).find((item) =>
        item.tenantId === tenantId && item.visitorId === visitorId && item.externalSessionIds.includes(sessionId)
      );
      if (!conversation) return null;
      const handoff = conversation.handoffId ? state.handoffs[conversation.handoffId] : null;
      const cursor = Number(after) || 0;
      const events = conversation.messageIds
        .map((messageId) => state.messages[messageId])
        .filter((message) => message && Number(message.sequence || 0) > cursor)
        .map((message) => ({
          id: String(message.sequence), messageId: message.id, sequence: message.sequence, type: `${message.role}_message`,
          role: message.role, text: message.content, createdAt: message.createdAt,
          action: message.action, citations: message.citations,
          actor: message.role === "human" ? undefined : message.actor
        }));
      const nextCursor = events.length ? String(events[events.length - 1].sequence) : String(cursor);
      return {
        events,
        nextCursor,
        handoff: handoff ? { ticketId: handoff.id, status: handoff.status, updatedAt: handoff.updatedAt } : null
      };
    });
  }

  async ticketEvents({ tenantId, visitorId, ticketId, after = 0 }) {
    return this.store.read((state) => {
      const handoff = state.handoffs[ticketId];
      if (!handoff || handoff.tenantId !== tenantId || handoff.visitorId !== visitorId) return null;
      const conversation = state.conversations[handoff.conversationId];
      if (!conversation) return null;
      const cursor = Number(after) || 0;
      const events = conversation.messageIds
        .map((messageId) => state.messages[messageId])
        .filter((message) => message && Number(message.sequence || 0) > cursor)
        .map((message) => ({
          id: String(message.sequence), messageId: message.id, sequence: message.sequence, type: `${message.role}_message`,
          role: message.role, text: message.content, createdAt: message.createdAt,
          action: message.action, citations: message.citations,
          actor: message.role === "human" ? undefined : message.actor
        }));
      return {
        events,
        nextCursor: events.length ? String(events[events.length - 1].sequence) : String(cursor),
        handoff: { ticketId: handoff.id, status: handoff.status, updatedAt: handoff.updatedAt }
      };
    });
  }

  async listNotifications({ status, recipientUsername, limit = 100 } = {}) {
    return this.store.read((state) => listByTime(state.notifications)
      .filter((item) => (!status || item.status === status) && (!recipientUsername || !item.recipientUsername || item.recipientUsername === recipientUsername))
      .slice(0, Math.min(limit, 500)));
  }

  async updateNotification(notificationId, status, actor = "admin", recipientUsername) {
    return this.store.transact((state) => {
      const notification = state.notifications[notificationId];
      if (!notification) return null;
      if (recipientUsername && notification.recipientUsername && notification.recipientUsername !== recipientUsername) {
        throw conflict("只能处理发送给当前管理员的通知。");
      }
      notification.status = status;
      notification.updatedAt = now();
      return notification;
    }, { kind: "audit", action: "notification.updated", actor, entityId: notificationId });
  }

  async createContentRevision(input, actor = "admin") {
    const createdAt = now();
    return this.store.transact((state) => {
      const revision = { id: id("REV"), key: input.key, title: input.title, content: input.content, status: input.status || "draft", createdAt, updatedAt: createdAt };
      state.contentRevisions[revision.id] = revision;
      return revision;
    }, { kind: "audit", action: "content_revision.created", actor });
  }

  async listContentRevisions() {
    return this.store.read((state) => listByTime(state.contentRevisions));
  }

  async updateContentRevision(revisionId, changes, actor = "admin") {
    return this.store.transact((state) => {
      const revision = state.contentRevisions[revisionId];
      if (!revision) return null;
      Object.assign(revision, changes, { updatedAt: now() });
      if (changes.status === "published") revision.publishedAt = now();
      return revision;
    }, { kind: "audit", action: "content_revision.updated", actor, entityId: revisionId, changes: Object.keys(changes) });
  }

  async getSystemConfig() {
    return this.store.read((state) => state.systemConfig);
  }

  async getRuntimeRules() {
    return this.store.read((state) => normalizeRuntimeRules(state.systemConfig.rules, {
      mode: state.systemConfig.operatorMode
    }));
  }

  async updateRuntimeRules(input, actor = "admin") {
    const update = parseRuntimeRulesUpdate(input);
    const audit = { kind: "audit", action: "runtime_rules.updated", actor, changes: [] };
    return this.store.transact((state) => {
      state.runtimeRuleRevisions ||= {};
      const current = normalizeRuntimeRules(state.systemConfig.rules, {
        mode: state.systemConfig.operatorMode
      });
      if (update.expectedRevision !== undefined && update.expectedRevision !== current.revision) {
        throw conflict(`客服规则已更新，当前版本为 ${current.revision}，请刷新后重试。`);
      }
      state.runtimeRuleRevisions[String(current.revision)] ||= storedRuntimeRules(current);
      const next = createRuntimeRulesRevision(current, update, actor);
      const stored = storedRuntimeRules(next);
      state.systemConfig = {
        ...state.systemConfig,
        rules: stored,
        operatorMode: stored.mode,
        updatedAt: next.updatedAt
      };
      state.runtimeRuleRevisions[String(next.revision)] = stored;
      audit.entityId = `runtime-rules:${next.revision}`;
      audit.changes = ["mode", "handoff", "note"].filter((key) => update[key] !== undefined);
      audit.ruleRevision = next.revision;
      return next;
    }, audit);
  }

  async listRuntimeRuleRevisions({ limit = 50 } = {}) {
    return this.store.read((state) => Object.values(state.runtimeRuleRevisions || {})
      .sort((left, right) => Number(right.revision) - Number(left.revision))
      .slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)))
      .map((item) => normalizeRuntimeRules(item)));
  }

  async restoreRuntimeRuleRevision(revision, actor = "admin") {
    const sourceRevision = Number(revision);
    const audit = { kind: "audit", action: "runtime_rules.restored", actor, sourceRevision };
    return this.store.transact((state) => {
      state.runtimeRuleRevisions ||= {};
      const source = state.runtimeRuleRevisions[String(sourceRevision)];
      if (!source) return null;
      const current = normalizeRuntimeRules(state.systemConfig.rules, {
        mode: state.systemConfig.operatorMode
      });
      state.runtimeRuleRevisions[String(current.revision)] ||= storedRuntimeRules(current);
      const restored = createRuntimeRulesRevision(current, {
        mode: source.mode,
        handoff: source.handoff,
        note: source.note,
        expectedRevision: current.revision
      }, actor);
      const stored = storedRuntimeRules(restored);
      state.systemConfig = {
        ...state.systemConfig,
        rules: stored,
        operatorMode: stored.mode,
        updatedAt: restored.updatedAt
      };
      state.runtimeRuleRevisions[String(restored.revision)] = stored;
      audit.entityId = `runtime-rules:${restored.revision}`;
      audit.ruleRevision = restored.revision;
      return { ...restored, restoredFromRevision: sourceRevision };
    }, audit);
  }

  async updateSystemConfig(changes, actor = "admin") {
    return this.store.transact((state) => {
      state.systemConfig = { ...state.systemConfig, ...changes, updatedAt: now() };
      return state.systemConfig;
    }, { kind: "audit", action: "system_config.updated", actor, changes: Object.keys(changes) });
  }

  async claimHandoff({ handoffId, username, displayName }) {
    const claimedAt = now();
    return this.store.transact((state) => {
      const handoff = state.handoffs[handoffId];
      if (!handoff) return null;
      if (["resolved", "closed"].includes(handoff.status)) throw conflict("该人工会话已经结束。");
      const actorNames = new Set([username, displayName].filter(Boolean));
      if (handoff.assignee && !actorNames.has(handoff.assignee) && handoff.assigneeUsername !== username) {
        throw conflict("该会话已由其他管理员接管。");
      }
      handoff.assignee = displayName || username;
      handoff.assigneeUsername = username;
      handoff.status = "human_active";
      handoff.updatedAt = claimedAt;
      const conversation = state.conversations[handoff.conversationId];
      if (conversation) {
        conversation.mode = "human_active";
        appendMessage(state, conversation, { role: "system", content: "勤益人工客服已接管本次对话。", createdAt: claimedAt });
      }
      return handoff;
    }, { kind: "audit", action: "handoff.claimed", actor: username, entityId: handoffId });
  }

  async requestHandoffTransfer({ handoffId, fromUsername, fromDisplayName, toUsername, toDisplayName, internalNote = "" }) {
    const createdAt = now();
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const handoff = state.handoffs[handoffId];
      if (!handoff) return null;
      if (!["human_active", "waiting_customer"].includes(handoff.status)) throw conflict("只有服务中的会话可以转交。");
      if (fromUsername === toUsername) throw conflict("不能将会话转交给自己。");
      const currentNames = new Set([fromUsername, fromDisplayName].filter(Boolean));
      if (handoff.assigneeUsername ? handoff.assigneeUsername !== fromUsername : !currentNames.has(handoff.assignee)) {
        throw conflict("只有当前接管管理员可以发起转交。");
      }
      const pending = handoff.pendingTransferId && state.handoffTransfers[handoff.pendingTransferId];
      if (pending?.status === "pending") throw conflict("该会话已有待确认的转交请求。");
      const transfer = {
        id: id("TRANSFER"), handoffId, conversationId: handoff.conversationId,
        fromUsername, fromDisplayName: fromDisplayName || fromUsername,
        toUsername, toDisplayName: toDisplayName || toUsername,
        status: "pending", internalNote: String(internalNote || "").slice(0, 4000),
        createdAt, updatedAt: createdAt
      };
      state.handoffTransfers[transfer.id] = transfer;
      handoff.pendingTransferId = transfer.id;
      handoff.updatedAt = createdAt;
      const notification = {
        id: id("NOTICE"), handoffId, transferId: transfer.id, type: "handoff_transfer_requested",
        conversationId: handoff.conversationId,
        recipientUsername: toUsername, status: "pending", createdAt, updatedAt: createdAt
      };
      state.notifications[notification.id] = notification;
      return transfer;
    }, { kind: "audit", action: "handoff.transfer_requested", actor: fromUsername, entityId: handoffId, targetUsername: toUsername });
  }

  async acceptHandoffTransfer({ transferId, actorUsername, actorDisplayName }) {
    const acceptedAt = now();
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const transfer = state.handoffTransfers[transferId];
      if (!transfer) return null;
      if (transfer.status !== "pending") throw conflict("该转交请求已经处理。");
      if (transfer.toUsername !== actorUsername) throw conflict("只有被指定的管理员可以确认接管。");
      const handoff = state.handoffs[transfer.handoffId];
      if (!handoff || handoff.pendingTransferId !== transfer.id) throw conflict("该转交请求已失效。");
      transfer.status = "accepted";
      transfer.acceptedAt = acceptedAt;
      transfer.updatedAt = acceptedAt;
      handoff.assignee = actorDisplayName || transfer.toDisplayName || actorUsername;
      handoff.assigneeUsername = actorUsername;
      handoff.updatedAt = acceptedAt;
      delete handoff.pendingTransferId;
      const conversation = state.conversations[handoff.conversationId];
      if (conversation) appendMessage(state, conversation, { role: "system", content: "本次人工服务已移交，服务将继续进行。", createdAt: acceptedAt });
      closeTransferNotifications(state, transfer.id, "dismissed", acceptedAt);
      return { transfer, handoff };
    }, { kind: "audit", action: "handoff.transfer_accepted", actor: actorUsername, entityId: transferId });
  }

  async returnHandoffTransfer({ transferId, actorUsername, internalNote = "" }) {
    const returnedAt = now();
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const transfer = state.handoffTransfers[transferId];
      if (!transfer) return null;
      if (transfer.status !== "pending") throw conflict("该转交请求已经处理。");
      if (transfer.toUsername !== actorUsername) throw conflict("只有被指定的管理员可以退回转交。");
      transfer.status = "returned";
      transfer.returnNote = String(internalNote || "").slice(0, 4000);
      transfer.returnedAt = returnedAt;
      transfer.updatedAt = returnedAt;
      const handoff = state.handoffs[transfer.handoffId];
      if (handoff?.pendingTransferId === transfer.id) {
        delete handoff.pendingTransferId;
        handoff.updatedAt = returnedAt;
      }
      closeTransferNotifications(state, transfer.id, "dismissed", returnedAt);
      return transfer;
    }, { kind: "audit", action: "handoff.transfer_returned", actor: actorUsername, entityId: transferId });
  }

  async forwardHandoffTransfer({ transferId, actorUsername, actorDisplayName, toUsername, toDisplayName, internalNote = "" }) {
    const forwardedAt = now();
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const previous = state.handoffTransfers[transferId];
      if (!previous) return null;
      if (previous.status !== "pending") throw conflict("该转交请求已经处理。");
      if (previous.toUsername !== actorUsername) throw conflict("只有被指定的管理员可以再次转交。");
      if (actorUsername === toUsername || previous.fromUsername === toUsername) throw conflict("请选择其他管理员接管。");
      const handoff = state.handoffs[previous.handoffId];
      if (!handoff || handoff.pendingTransferId !== previous.id) throw conflict("该转交请求已失效。");
      previous.status = "forwarded";
      previous.forwardedAt = forwardedAt;
      previous.updatedAt = forwardedAt;
      closeTransferNotifications(state, previous.id, "dismissed", forwardedAt);
      const transfer = {
        id: id("TRANSFER"), handoffId: previous.handoffId, conversationId: previous.conversationId,
        previousTransferId: previous.id, originalAssigneeUsername: previous.originalAssigneeUsername || previous.fromUsername,
        fromUsername: actorUsername, fromDisplayName: actorDisplayName || actorUsername,
        toUsername, toDisplayName: toDisplayName || toUsername,
        status: "pending", internalNote: String(internalNote || "").slice(0, 4000),
        createdAt: forwardedAt, updatedAt: forwardedAt
      };
      state.handoffTransfers[transfer.id] = transfer;
      handoff.pendingTransferId = transfer.id;
      handoff.updatedAt = forwardedAt;
      const notificationId = id("NOTICE");
      state.notifications[notificationId] = {
        id: notificationId, handoffId: handoff.id, transferId: transfer.id, type: "handoff_transfer_requested",
        conversationId: handoff.conversationId,
        recipientUsername: toUsername, status: "pending", createdAt: forwardedAt, updatedAt: forwardedAt
      };
      return transfer;
    }, { kind: "audit", action: "handoff.transfer_forwarded", actor: actorUsername, entityId: transferId, targetUsername: toUsername });
  }

  async listHandoffTransfers(handoffId) {
    return this.store.read((state) => {
      ensureWorkflowState(state);
      return listByTime(state.handoffTransfers).filter((item) => item.handoffId === handoffId);
    });
  }

  async addInternalNote({ handoffId, content, actorUsername, actorDisplayName }) {
    const createdAt = now();
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      if (!state.handoffs[handoffId]) return null;
      const note = {
        id: id("NOTE"), handoffId, content: String(content || "").slice(0, 4000),
        actorUsername, actorDisplayName: actorDisplayName || actorUsername, createdAt, updatedAt: createdAt
      };
      state.internalNotes[note.id] = note;
      return note;
    }, { kind: "audit", action: "handoff.internal_note_added", actor: actorUsername, entityId: handoffId });
  }

  async listInternalNotes(handoffId) {
    return this.store.read((state) => {
      ensureWorkflowState(state);
      return listByTime(state.internalNotes).filter((item) => item.handoffId === handoffId);
    });
  }

  async addConversationAttachment({ conversationId, filename, mimeType, size, storageKey, actorUsername }) {
    const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
    if (!allowedTypes.has(mimeType) || !Number.isInteger(size) || size < 1 || size > 25 * 1024 * 1024) {
      throw Object.assign(new Error("附件仅支持不超过 25MB 的 PDF、JPG、PNG 或 WebP 文件。"), { statusCode: 400 });
    }
    const createdAt = now();
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const conversation = state.conversations[conversationId];
      if (!conversation) return null;
      const attachment = {
        id: id("ATTACHMENT"), conversationId, filename: String(filename || "file").slice(0, 240),
        mimeType, size, storageKey: String(storageKey || "").slice(0, 500), actorUsername,
        createdAt, updatedAt: createdAt
      };
      state.attachments[attachment.id] = attachment;
      conversation.attachmentIds ||= [];
      conversation.attachmentIds.push(attachment.id);
      conversation.updatedAt = createdAt;
      return attachment;
    }, { kind: "audit", action: "conversation.attachment_registered", actor: actorUsername, entityId: conversationId });
  }

  async getOperatorSchedule({ username } = {}) {
    return this.store.read((state) => {
      ensureWorkflowState(state);
      return {
        schedule: state.operatorSchedule,
        ...(username ? { extraDuty: state.extraDuty[username] || { username, active: false } } : {})
      };
    });
  }

  async updateOperatorSchedule({ timezone, windows }, actorUsername) {
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw Object.assign(new Error("时区无效。"), { statusCode: 400 }); }
    const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!Array.isArray(windows) || !windows.length || windows.length > 12 || windows.some((window) =>
      !validTime.test(window.start) || !validTime.test(window.end) || minutes(window.start) >= minutes(window.end) ||
      !Array.isArray(window.days) || !window.days.length || window.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    )) throw Object.assign(new Error("人工服务时段无效。"), { statusCode: 400 });
    const updatedAt = now();
    const schedule = {
      timezone,
      windows: windows.map((window, index) => ({
        id: String(window.id || `window-${index + 1}`).slice(0, 80),
        label: String(window.label || `时段 ${index + 1}`).slice(0, 80),
        days: [...new Set(window.days)].sort(), start: window.start, end: window.end
      })),
      updatedAt,
      updatedBy: actorUsername
    };
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      state.operatorSchedule = schedule;
      return schedule;
    }, { kind: "audit", action: "operator_schedule.updated", actor: actorUsername, changes: ["timezone", "windows"] });
  }

  async setExtraDuty({ username, active }) {
    const updatedAt = now();
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const current = state.extraDuty[username] || { username, active: false };
      const duty = {
        ...current, username, active: Boolean(active), updatedAt,
        ...(active ? { startedAt: updatedAt } : { endedAt: updatedAt })
      };
      state.extraDuty[username] = duty;
      return duty;
    }, { kind: "audit", action: active ? "extra_duty.started" : "extra_duty.ended", actor: username });
  }

  async listExtraDuty() {
    return this.store.read((state) => {
      ensureWorkflowState(state);
      return Object.values(state.extraDuty).sort((left, right) => left.username.localeCompare(right.username));
    });
  }

  async publicAvailability({ at = new Date(), aiConfigured = true } = {}) {
    return this.store.read((state) => {
      ensureWorkflowState(state);
      const schedule = state.operatorSchedule;
      const clock = zonedClock(at, schedule.timezone);
      const scheduled = schedule.windows.some((window) => window.days.includes(clock.day) && clock.minute >= minutes(window.start) && clock.minute < minutes(window.end));
      const extraDuty = Object.values(state.extraDuty).some((item) => item.active);
      return {
        checkedAt: at.toISOString(), timezone: schedule.timezone,
        ai: {
          online: aiConfigured && state.systemConfig.aiEnabled !== false,
          repliesContinueDuringHumanService: true
        },
        human: { online: scheduled || extraDuty, source: extraDuty ? "extra_duty" : scheduled ? "schedule" : "offline" }
      };
    });
  }

  async recordAnonymousEvent({ type, dimensions = {} }) {
    if (!ANONYMOUS_EVENT_SET.has(type)) throw Object.assign(new Error("不支持的匿名统计事件。"), { statusCode: 400 });
    const receivedAt = new Date();
    return this.store.transact((state) => {
      ensureWorkflowState(state);
      const analytics = state.anonymousAnalytics;
      const rawCutoff = receivedAt.getTime() - RAW_ANALYTICS_RETENTION_MS;
      const aggregateCutoff = aggregateDay(new Date(thirteenMonthsAgo(receivedAt.getTime())), state.operatorSchedule.timezone);
      analytics.raw = analytics.raw.filter((item) => Date.parse(item.receivedAt) >= rawCutoff);
      for (const [key, row] of Object.entries(analytics.aggregates)) if (row.day < aggregateCutoff) delete analytics.aggregates[key];
      const safe = safeDimensions(dimensions);
      const event = { id: id("ANON"), type, dimensions: safe, receivedAt: receivedAt.toISOString() };
      analytics.raw.push(event);
      const day = aggregateDay(receivedAt, state.operatorSchedule.timezone);
      const key = [day, type, safe.locale, safe.surface, safe.path, safe.targetId || ""].join("|");
      const aggregate = analytics.aggregates[key] || { day, type, ...safe, count: 0 };
      aggregate.count += 1;
      aggregate.updatedAt = event.receivedAt;
      analytics.aggregates[key] = aggregate;
      analytics.lastReceivedAt = event.receivedAt;
      return { accepted: true, eventId: event.id, receivedAt: event.receivedAt };
    });
  }

  async anonymousAnalyticsSummary() {
    return this.store.read((state) => {
      ensureWorkflowState(state);
      const rows = Object.values(state.anonymousAnalytics.aggregates);
      const byType = {};
      const byDay = {};
      for (const row of rows) {
        byType[row.type] = Number(byType[row.type] || 0) + row.count;
        byDay[row.day] = Number(byDay[row.day] || 0) + row.count;
      }
      const clickTypes = ["navigation_click", "cta_click", "home_feature_click"];
      return {
        totals: {
          pageViews: byType.page_view || 0,
          clicks: clickTypes.reduce((total, type) => total + Number(byType[type] || 0), 0),
          customizerStarts: byType.customizer_opened || 0,
          customizerCompletions: byType.customizer_completed || 0,
          quoteStarts: byType.quote_started || 0,
          quoteSubmissions: byType.quote_submitted || 0,
          handoffRequests: byType.handoff_requested || 0
        },
        byType,
        series: Object.entries(byDay).sort(([left], [right]) => left.localeCompare(right)).map(([day, count]) => ({ day, count })),
        generatedAt: now()
      };
    });
  }

  async anonymousAnalyticsTechnical() {
    return this.store.read((state) => {
      ensureWorkflowState(state);
      const analytics = state.anonymousAnalytics;
      const counts = Object.values(analytics.aggregates).reduce((result, row) => {
        result[row.type] = Number(result[row.type] || 0) + row.count;
        return result;
      }, {});
      return {
        traffic: {
          pageViews: counts.page_view || 0,
          clicks: Number(counts.navigation_click || 0) + Number(counts.cta_click || 0) + Number(counts.home_feature_click || 0),
          totalMeaningfulEvents: Object.values(counts).reduce((total, count) => total + count, 0)
        },
        rawEventCount: analytics.raw.length,
        aggregateRowCount: Object.keys(analytics.aggregates).length,
        oldestRawEventAt: analytics.raw[0]?.receivedAt || null,
        lastReceivedAt: analytics.lastReceivedAt,
        rawRetentionDays: 90,
        aggregateRetentionMonths: 13,
        storesIpAddresses: false,
        storesConversationOrFormBodies: false,
        allowedEventTypes: ANONYMOUS_EVENT_TYPES
      };
    });
  }

  async recordEvent({ kind, type, actor, payload, sessionId }) {
    return this.store.appendEvent({ id: id("EVT"), kind, type, actor, sessionId, payload: compactPayload(payload) });
  }

  async overview() {
    return this.store.read((state) => ({
      conversations: Object.keys(state.conversations).length,
      openConversations: Object.values(state.conversations).filter((item) => item.status === "open").length,
      queuedHandoffs: Object.values(state.handoffs).filter((item) => ["waiting_human", "acknowledged"].includes(item.status)).length,
      pendingNotifications: Object.values(state.notifications).filter((item) => item.status === "pending").length,
      newQuotes: Object.values(state.quotes || {}).filter((item) => item.status === "new").length,
      contentRevisions: Object.keys(state.contentRevisions).length
    }));
  }
}

export class OperationsHandoffAdapter {
  constructor(service) {
    this.service = service;
    this.publicAvailable = true;
  }

  async create({ tenantId, userId, sessionId, reason, unresolvedQuestion, handoffReport, contact }) {
    return this.service.createHandoff({ tenantId, visitorId: userId, sessionId, reason, unresolvedQuestion, handoffReport, contact });
  }

  async queueDraft({ tenantId, userId, sessionId, ticketId, mode, content, citations, grounded, responseId }) {
    return this.service.createAiDraft({
      tenantId,
      visitorId: userId,
      sessionId,
      handoffId: ticketId,
      mode,
      content,
      citations,
      grounded,
      responseId
    });
  }
}
