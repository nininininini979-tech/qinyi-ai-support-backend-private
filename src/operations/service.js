import crypto from "node:crypto";
import { maskPii } from "../security.js";

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
    return this.store.read((state) => listByTime(state.conversations).filter((item) => !status || item.status === status).slice(0, Math.min(limit, 500)).map((item) => ({ ...item, messageCount: item.messageIds.length })));
  }

  async getConversation(conversationId) {
    return this.store.read((state) => {
      const conversation = state.conversations[conversationId];
      if (!conversation) return null;
      return { ...conversation, messages: conversation.messageIds.map((messageId) => state.messages[messageId]).filter(Boolean), handoffs: Object.values(state.handoffs).filter((item) => item.conversationId === conversation.id) };
    });
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

  async addHumanMessage({ conversationId, content, actor = "admin" }) {
    return this.store.transact((state) => {
      const conversation = state.conversations[conversationId];
      if (!conversation) return null;
      const handoff = conversation.handoffId ? state.handoffs[conversation.handoffId] : null;
      if (!handoff || !["human_active", "waiting_customer"].includes(handoff.status)) {
        throw Object.assign(new Error("请先认领该会话再发送人工回复。"), { statusCode: 409 });
      }
      if (!handoff.assignee || handoff.assignee !== actor) {
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
          action: message.action, citations: message.citations, actor: message.actor
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
          action: message.action, citations: message.citations, actor: message.actor
        }));
      return {
        events,
        nextCursor: events.length ? String(events[events.length - 1].sequence) : String(cursor),
        handoff: { ticketId: handoff.id, status: handoff.status, updatedAt: handoff.updatedAt }
      };
    });
  }

  async listNotifications({ status, limit = 100 } = {}) {
    return this.store.read((state) => listByTime(state.notifications).filter((item) => !status || item.status === status).slice(0, Math.min(limit, 500)));
  }

  async updateNotification(notificationId, status, actor = "admin") {
    return this.store.transact((state) => {
      const notification = state.notifications[notificationId];
      if (!notification) return null;
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

  async updateSystemConfig(changes, actor = "admin") {
    return this.store.transact((state) => {
      state.systemConfig = { ...state.systemConfig, ...changes, updatedAt: now() };
      return state.systemConfig;
    }, { kind: "audit", action: "system_config.updated", actor, changes: Object.keys(changes) });
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
}
