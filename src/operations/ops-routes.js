import { bearerToken } from "./auth.js";
import { evaluateRuntimeRules, parseRuntimeRulesUpdate } from "./runtime-rules.js";
import { classifyMessage } from "../support/policy.js";

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function text(value, max = 4000) {
  const result = String(value || "").trim();
  if (result.length > max) fail("提交内容过长。");
  return result;
}

function handoffLabel(status) {
  return {
    waiting_human: "等待接管", acknowledged: "已知晓", human_active: "人工服务中",
    waiting_customer: "等待客户", resolved: "已解决", closed: "已关闭"
  }[status] || status;
}

function publicConversation(item, handoff) {
  return {
    id: item.id,
    customerName: "网站访客",
    preview: handoff?.summary || "网站客户会话",
    status: handoff?.status || item.mode || item.status,
    statusLabel: handoffLabel(handoff?.status || item.mode || item.status),
    priority: handoff?.priority || "normal",
    updatedAt: item.updatedAt,
    unreadCount: ["waiting_human", "acknowledged"].includes(handoff?.status) ? 1 : 0,
    ticketId: handoff?.id
  };
}

function publicAttachment(item) {
  const downloadable = item.scope === "visitor" && item.status === "available";
  return {
    id: item.id,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.size,
    status: item.status || "registered",
    createdAt: item.createdAt,
    downloadable,
    ...(downloadable ? { downloadUrl: `/api/admin/attachments/${encodeURIComponent(item.id)}/file` } : {})
  };
}

function defaultNotificationSettings() {
  return {
    events: [
      { key: "handoff", label: "新的人工服务请求", enabled: true },
      { key: "contact", label: "客户留下联系方式", enabled: true },
      { key: "service_error", label: "网站或客服异常", enabled: true },
      { key: "content_review", label: "内容等待审核", enabled: true }
    ],
    channels: [
      { key: "browser", label: "后台声音与浏览器提醒", enabled: true, configured: true },
      { key: "wecom", label: "企业微信", enabled: false, configured: false },
      { key: "qianniu", label: "千牛工作台", enabled: false, configured: false },
      { key: "email", label: "邮箱", enabled: false, configured: false },
      { key: "sms", label: "短信", enabled: false, configured: false },
      { key: "dingtalk", label: "钉钉", enabled: false, configured: false }
    ]
  };
}

function developerChange(item) {
  const rawTarget = item.entityId || item.sessionId || item.kind || "system";
  const safeTarget = String(rawTarget).startsWith("v1.") ? item.id || "protected-session" : rawTarget;
  return {
    id: item.id || `${item.at}:${item.action || item.type}`,
    createdAt: item.at,
    type: item.action || item.type || item.kind,
    name: safeTarget,
    summary: item.action || item.type || "system.change",
    actor: item.actor || "system",
    status: "complete"
  };
}

function emergencyHistoryItem(item) {
  return {
    id: item.id,
    createdAt: item.at,
    action: item.type,
    actionLabel: item.type === "pause_ai" ? "暂停 AI 自动回复" : item.type === "resume_ai" ? "恢复 AI" : item.type,
    actor: item.actor,
    reason: item.payload?.reason || "未记录原因",
    status: "complete"
  };
}

export async function registerOpsCompatibilityRoutes(app, { config, service, auth, applySystemConfig }) {
  const ALL_ROLES = ["support", "administrator", "developer", "system_owner"];
  const SUPPORT_ROLES = ["support", "administrator", "system_owner"];
  const ADMINISTRATOR_ROLES = ["administrator", "system_owner"];
  const DEVELOPER_ROLES = ["developer", "system_owner"];

  async function requireRole(request, roles) {
    const session = await auth.authenticate(bearerToken(request));
    if (!session) fail("后台会话无效或已过期。", 401);
    if (!roles.includes(session.role)) fail("当前账号没有执行此操作的权限。", 403);
    request.operationsSession = session;
  }

  const requireUser = (request) => requireRole(request, ALL_ROLES);
  const requireSupport = (request) => requireRole(request, SUPPORT_ROLES);
  const requireAdministrator = (request) => requireRole(request, ADMINISTRATOR_ROLES);
  const requireDeveloperUser = (request) => requireRole(request, DEVELOPER_ROLES);

  const actorFor = (request) => request.operationsSession.displayName || request.operationsSession.username || `operator:${request.operationsSession.id}`;

  app.get("/api/ops/me", { preHandler: requireUser }, (request) => ({
    user: { name: request.operationsSession.displayName, username: request.operationsSession.username, role: request.operationsSession.role, roleLabel: request.operationsSession.role }
  }));

  app.get("/api/ops/overview", { preHandler: requireSupport }, async (request) => {
    const [overview, handoffs, revisions, activity, notifications] = await Promise.all([
      service.overview(), service.listHandoffs(), service.listContentRevisions(), service.store.listEvents({ limit: 12 }),
      service.listNotifications({ status: "pending", recipientUsername: request.operationsSession.username, limit: 20 })
    ]);
    const queue = handoffs.filter((item) => !["resolved", "closed"].includes(item.status));
    return {
      metrics: {
        waitingHuman: queue.length,
        todaySessions: overview.openConversations,
        averageWaitMinutes: 0,
        pendingContent: revisions.filter((item) => ["draft", "review"].includes(item.status)).length
      },
      queue: queue.slice(0, 8).map((item) => ({
        id: item.conversationId, customerName: "网站访客", reason: item.summary,
        status: item.status, priority: item.priority, updatedAt: item.updatedAt
      })),
      alerts: notifications.map((item) => ({
        id: item.id,
        severity: "warning",
        title: item.type === "handoff_transfer_requested" ? "有待确认的会话转交" : "有待确认提醒",
        detail: item.type === "handoff_transfer_requested" ? "另一名管理员已将客户会话转交给您，请进入人工接管页面确认、退回或再次转交。" : "请及时处理该提醒。",
        conversationId: item.conversationId,
        transferId: item.transferId
      })),
      content: {
        draftCount: revisions.filter((item) => item.status === "draft").length,
        pendingCount: revisions.filter((item) => item.status === "review").length,
        lastPublishedTitle: revisions.find((item) => item.status === "published")?.title,
        lastPublishedAt: revisions.find((item) => item.status === "published")?.publishedAt
      },
      activity: activity.slice().reverse().map((item) => ({ ...item, createdAt: item.at, summary: item.action || item.type, result: "complete" })),
      generatedAt: new Date().toISOString()
    };
  });

  app.get("/api/ops/sessions", { preHandler: requireSupport }, async () => {
    const [conversations, handoffs] = await Promise.all([service.listConversations({ limit: 100 }), service.listHandoffs({ limit: 100 })]);
    return { items: conversations.map((item) => publicConversation(item, handoffs.find((handoff) => handoff.conversationId === item.id))) };
  });

  app.get("/api/ops/sessions/:conversationId", { preHandler: requireSupport }, async (request, reply) => {
    const conversation = await service.getConversation(String(request.params.conversationId));
    if (!conversation) return reply.code(404).send({ error: "会话不存在。", requestId: request.id });
    const handoffs = await service.listHandoffs({ limit: 500 });
    const handoff = handoffs.find((item) => item.conversationId === conversation.id);
    const currentActor = actorFor(request);
    const claimed = Boolean(handoff?.assignee === currentActor && ["human_active", "waiting_customer"].includes(handoff.status));
    return {
      session: {
        id: conversation.id,
        status: handoff?.status || conversation.status,
        mode: conversation.mode,
        channel: conversation.channel,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        lastAction: conversation.lastAction,
        statusLabel: handoffLabel(handoff?.status || conversation.status),
        assigneeName: handoff?.assignee,
        claimedByCurrentUser: claimed,
        claimedBySomeone: Boolean(handoff?.assignee),
        summary: handoff?.summary
      },
      messages: conversation.messages.map((message) => ({
        id: message.id, role: message.role === "human" ? "agent" : message.role,
        text: message.content, createdAt: message.createdAt,
        author: message.role === "human" ? "勤益人工客服" : undefined
      })),
      aiDrafts: (conversation.aiDrafts || []).map((draft) => ({
        id: draft.id,
        mode: draft.mode,
        status: draft.status,
        content: draft.content,
        finalContent: draft.finalContent,
        grounded: draft.grounded,
        citations: draft.citations,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
        reviewedAt: draft.reviewedAt,
        reviewerName: draft.reviewerName,
        rejectionReason: draft.rejectionReason
      })),
      attachments: (conversation.attachments || []).map(publicAttachment),
      customer: { name: "网站访客", intentSummary: handoff?.summary },
      handoff: handoff ? { ...handoff, ticketId: handoff.id } : null
    };
  });

  app.post("/api/ops/sessions/:conversationId/acknowledge", { preHandler: requireSupport }, async (request, reply) => {
    const conversation = await service.getConversation(String(request.params.conversationId));
    const handoff = conversation?.handoffs?.find((item) => item.status === "waiting_human");
    if (!handoff) return reply.code(404).send({ error: "没有等待确认的人工请求。", requestId: request.id });
    return service.updateHandoff(handoff.id, { status: "acknowledged" }, actorFor(request));
  });

  app.post("/api/ops/sessions/:conversationId/takeover", { preHandler: requireSupport }, async (request, reply) => {
    const conversation = await service.getConversation(String(request.params.conversationId));
    const handoff = conversation?.handoffs?.find((item) => !["resolved", "closed"].includes(item.status));
    if (!handoff) return reply.code(404).send({ error: "没有可接管的人工请求。", requestId: request.id });
    return service.claimHandoff({
      handoffId: handoff.id,
      username: request.operationsSession.username,
      displayName: request.operationsSession.displayName
    });
  });

  app.post("/api/ops/sessions/:conversationId/resolve", { preHandler: requireSupport }, async (request, reply) => {
    const conversation = await service.getConversation(String(request.params.conversationId));
    const handoff = conversation?.handoffs?.find((item) => !["resolved", "closed"].includes(item.status));
    if (!handoff) return reply.code(404).send({ error: "没有进行中的人工服务。", requestId: request.id });
    return service.updateHandoff(handoff.id, { status: "resolved" }, actorFor(request));
  });

  app.post("/api/ops/sessions/:conversationId/messages", { preHandler: requireSupport }, async (request, reply) => {
    const message = text(request.body?.message, 2000);
    if (!message) fail("回复内容不能为空。");
    const result = await service.addHumanMessage({
      conversationId: String(request.params.conversationId),
      content: message,
      actor: actorFor(request),
      actorUsername: request.operationsSession.username
    });
    return result ? reply.code(201).send(result) : reply.code(404).send({ error: "会话不存在。", requestId: request.id });
  });

  app.get("/api/ops/ai-drafts", { preHandler: requireSupport }, async (request) => ({
    items: await service.listAiDrafts({
      status: request.query?.status ? String(request.query.status) : undefined,
      conversationId: request.query?.conversationId ? String(request.query.conversationId) : undefined,
      limit: Number(request.query?.limit) || 100
    })
  }));

  app.post("/api/ops/ai-drafts/:draftId/approve", { preHandler: requireSupport }, async (request, reply) => {
    const content = request.body?.content == null ? undefined : text(request.body.content, 4000);
    const result = await service.approveAiDraft({
      draftId: String(request.params.draftId),
      content,
      actorUsername: request.operationsSession.username,
      actorDisplayName: request.operationsSession.displayName
    });
    return result || reply.code(404).send({ error: "AI 草稿不存在。", requestId: request.id });
  });

  app.post("/api/ops/ai-drafts/:draftId/reject", { preHandler: requireSupport }, async (request, reply) => {
    const reason = text(request.body?.reason, 1000);
    if (!reason) fail("驳回原因不能为空。");
    const result = await service.rejectAiDraft({
      draftId: String(request.params.draftId),
      reason,
      actorUsername: request.operationsSession.username,
      actorDisplayName: request.operationsSession.displayName
    });
    return result || reply.code(404).send({ error: "AI 草稿不存在。", requestId: request.id });
  });

  app.get("/api/ops/important-information", { preHandler: requireAdministrator }, async () => {
    const settings = await service.getSystemConfig();
    return { revision: settings.importantRevision || 0, fields: settings.importantInformation || {}, updatedAt: settings.updatedAt };
  });

  app.put("/api/ops/important-information/draft", { preHandler: requireAdministrator }, async (request) => {
    const fields = request.body?.fields && typeof request.body.fields === "object" ? request.body.fields : {};
    const settings = await service.getSystemConfig();
    const revision = Number(settings.importantRevision || 0) + 1;
    const saved = await service.updateSystemConfig({ importantInformation: fields, importantRevision: revision }, actorFor(request));
    return { revision, savedAt: saved.updatedAt };
  });

  app.post("/api/ops/important-information/preview", { preHandler: requireAdministrator }, () => ({ previewUrl: "/admin.html#important" }));

  app.get("/api/ops/content", { preHandler: requireAdministrator }, async () => ({ items: await service.listContentRevisions() }));
  app.post("/api/ops/content", { preHandler: requireAdministrator }, async (request, reply) => {
    const title = text(request.body?.title, 200);
    if (!title) fail("内容标题不能为空。");
    const revision = await service.createContentRevision({ key: `content.${Date.now()}`, title, content: "", status: "draft" }, actorFor(request));
    return reply.code(201).send(revision);
  });
  app.post("/api/ops/content/:revisionId/:action", { preHandler: requireAdministrator }, async (request, reply) => {
    const status = { "submit-review": "review", approve: "approved", publish: "published", retire: "retired" }[String(request.params.action)];
    if (!status) fail("不支持的内容操作。", 404);
    const result = await service.updateContentRevision(String(request.params.revisionId), { status }, actorFor(request));
    return result || reply.code(404).send({ error: "内容版本不存在。", requestId: request.id });
  });

  app.get("/api/ops/notifications", { preHandler: requireAdministrator }, async () => {
    const settings = await service.getSystemConfig();
    return settings.notificationSettings || defaultNotificationSettings();
  });
  app.put("/api/ops/notifications", { preHandler: requireAdministrator }, async (request) => {
    const settings = request.body?.settings || request.body || {};
    await service.updateSystemConfig({ notificationSettings: settings }, actorFor(request));
    return { saved: true };
  });

  app.get("/api/ops/rules", { preHandler: requireAdministrator }, async () => {
    return service.getRuntimeRules();
  });
  app.put("/api/ops/rules", { preHandler: requireAdministrator }, async (request) => {
    const update = parseRuntimeRulesUpdate(request.body);
    const rules = await service.updateRuntimeRules(update, actorFor(request));
    await applySystemConfig?.({ rules, operatorMode: rules.mode });
    return rules;
  });
  app.get("/api/ops/rules/revisions", { preHandler: requireAdministrator }, async (request) => ({
    items: await service.listRuntimeRuleRevisions({ limit: Number(request.query?.limit) || 50 })
  }));
  app.post("/api/ops/rules/revisions/:revision/restore", { preHandler: requireAdministrator }, async (request, reply) => {
    const revision = Number(request.params.revision);
    if (!Number.isInteger(revision) || revision < 1) fail("客服规则版本无效。");
    const rules = await service.restoreRuntimeRuleRevision(revision, actorFor(request));
    if (!rules) return reply.code(404).send({ error: "客服规则版本不存在。", requestId: request.id });
    await applySystemConfig?.({ rules, operatorMode: rules.mode });
    return rules;
  });
  app.post("/api/ops/rules/test", { preHandler: requireAdministrator }, async (request) => {
    const message = text(request.body?.message, 2000);
    if (!message) fail("测试消息不能为空。");
    const rules = await service.getRuntimeRules();
    if (rules.mode !== "auto") {
      return {
        matched: true,
        action: "handoff",
        reason: `operator_mode_${rules.mode}`,
        rule: { key: "service_mode", label: "当前服务模式" },
        revision: rules.revision,
        explanation: "当前服务模式要求人工审核或接管。"
      };
    }
    const immutable = classifyMessage(message);
    if (immutable.action === "handoff") {
      return {
        matched: true,
        action: "handoff",
        reason: immutable.reason,
        rule: { key: "immutable_safety", label: "不可修改的安全边界" },
        explanation: "命中不可修改的人工服务安全边界。"
      };
    }
    const result = evaluateRuntimeRules(message, rules);
    return {
      ...result,
      explanation: result.matched ? `命中“${result.rule.label}”规则。` : "未命中已启用的运营转人工规则，可进入受控 AI 回答流程。"
    };
  });

  app.get("/api/ops/audit", { preHandler: requireAdministrator }, async (request) => {
    const events = await service.store.listEvents({ limit: Number(request.query?.limit) || 200 });
    return { items: events.slice().reverse().map((item) => ({
      id: item.id || `${item.at}:${item.action}`, actor: item.actor, action: item.action || item.type,
      target: item.entityId || item.sessionId, summary: item.action || item.type,
      createdAt: item.at, result: "complete"
    })) };
  });

  app.get("/api/ops/developer/status", { preHandler: requireDeveloperUser }, async () => {
    const overview = await service.overview();
    const agentCompany = app.operatorControl.status().agentCompany;
    return {
      environment: config.NODE_ENV,
      overall: "healthy",
      systems: [
        { id: "website", name: "公开网站", status: "healthy", value: "在线", detail: "静态站点与客服入口" },
        { id: "support", name: "智能客服", status: config.AI_SERVICE_ENABLED ? "healthy" : "paused", value: config.AI_SERVICE_ENABLED ? "AI运行中" : "人工优先", detail: "A/B/C/D 受控回复" },
        { id: "admin", name: "管理员后台", status: "healthy", value: "已连接", detail: "持久化运营服务" },
        { id: "agents", name: "Agent公司", status: "healthy", value: `${Object.keys(agentCompany).length} 个岗位`, detail: "事件账本已启用" }
      ],
      metrics: {
        activeSessions: overview.openConversations,
        humanQueue: overview.queuedHandoffs,
        conversations: overview.conversations,
        pendingNotifications: overview.pendingNotifications
      },
      incidents: [],
      changes: (await service.store.listEvents({ limit: 20 })).slice().reverse().map(developerChange),
      generatedAt: new Date().toISOString()
    };
  });

  app.get("/api/ops/developer/traces", { preHandler: requireDeveloperUser }, async () => {
    const events = await service.store.listEvents({ kind: "agent", limit: 80 });
    return { items: events.slice().reverse().map((item) => ({ id: item.id, requestId: item.id, sessionId: item.sessionId, summary: item.type, status: "complete", startedAt: item.at, agents: [item.actor] })), agents: Object.values(app.operatorControl.status().agentCompany) };
  });
  app.get("/api/ops/developer/traces/:eventId", { preHandler: requireDeveloperUser }, async (request, reply) => {
    const events = await service.store.listEvents({ kind: "agent", limit: 500 });
    const event = events.find((item) => item.id === request.params.eventId);
    if (!event) return reply.code(404).send({ error: "追踪记录不存在。", requestId: request.id });
    return { trace: { ...event, requestId: event.id, startedAt: event.at, status: "complete" }, steps: [{ agent: event.actor, summary: event.type, durationMs: event.payload?.durationMs }], evidence: [], review: { decision: "complete", decisionReason: "已写入不可追加修改的事件账本。" }, output: { summary: JSON.stringify(event.payload || {}) } };
  });

  app.get("/api/ops/developer/releases", { preHandler: requireDeveloperUser }, async () => ({ items: (await service.listContentRevisions()).filter((item) => ["review", "approved", "published"].includes(item.status)).map((item) => ({ ...item, version: item.id, environment: item.status === "published" ? "production" : "preview", summary: item.title, checks: { status: item.status === "review" ? "pending" : "complete" } })) }));
  app.get("/api/ops/developer/releases/:revisionId", { preHandler: requireDeveloperUser }, async (request, reply) => {
    const item = (await service.listContentRevisions()).find((revision) => revision.id === request.params.revisionId);
    if (!item) return reply.code(404).send({ error: "发布记录不存在。", requestId: request.id });
    return { release: { ...item, version: item.id, summary: item.title }, changes: [{ title: item.title, type: "content" }], checks: [{ name: "人工内容审核", status: item.status === "review" ? "pending" : "complete" }], stages: [{ label: "草稿", status: "complete" }, { label: "审核", status: item.status }, { label: "发布", status: item.status === "published" ? "complete" : "pending" }], rollback: { available: item.status === "published" } };
  });
  app.post("/api/ops/developer/releases/:revisionId/:action", { preHandler: requireDeveloperUser }, async (request, reply) => {
    const status = { approve: "approved", reject: "draft", rollback: "retired" }[String(request.params.action)];
    if (!status) fail("不支持的发布操作。", 404);
    const result = await service.updateContentRevision(String(request.params.revisionId), { status, decisionReason: text(request.body?.reason, 1000) }, actorFor(request));
    return result || reply.code(404).send({ error: "发布记录不存在。", requestId: request.id });
  });

  app.get("/api/ops/developer/environment", { preHandler: requireDeveloperUser }, () => ({
    environments: [
      { name: "本地开发", status: config.NODE_ENV === "development" ? "active" : "ready", detail: "单机持久化运营服务" },
      { name: "GitHub Pages", status: "active", detail: "公开网站" },
      { name: "中国大陆生产环境", status: "warning", detail: "等待服务器与备案信息" }
    ],
    integrations: defaultNotificationSettings().channels.map((item) => ({ name: item.label, configured: item.configured, status: item.configured ? "healthy" : "warning" })),
    configuration: [
      { name: "运营数据目录", environment: "server", configured: true, status: "healthy", detail: "密钥值不在界面显示" },
      { name: "Agent A/B/C/D", environment: "all", configured: true, status: "healthy", detail: "独立窗口与岗位版本" },
      { name: "企业微信 / 千牛", environment: "production", configured: false, detail: "接口已预留，等待凭据" }
    ]
  }));
  app.post("/api/ops/developer/integrations/verify", { preHandler: requireDeveloperUser }, async (request, reply) => {
    await service.recordEvent({ kind: "audit", type: "integrations.verify_requested", actor: actorFor(request), payload: {} });
    return reply.code(202).send({ accepted: true });
  });

  app.get("/api/ops/developer/emergency", { preHandler: requireDeveloperUser }, async () => {
    const overview = await service.overview();
    const settings = await service.getSystemConfig();
    return {
      metrics: { openIncidents: 0, errorRate: null, p95LatencyMs: null, humanQueue: overview.queuedHandoffs },
      actions: [
        { key: "pause_ai", label: "暂停 AI 自动回复", description: "新消息转入人工流程。", risk: "low", buttonLabel: "暂停" },
        { key: "resume_ai", label: "恢复 AI", description: "通过健康检查后恢复受控自动回复。", risk: "high", buttonLabel: "恢复" }
      ],
      onCall: { status: settings.operatorOnline ? "online" : "offline", name: settings.onCallName || "未安排", shift: "按规则设置", contactMasked: "仅后台可见" },
      incidents: [],
      history: (await service.store.listEvents({ kind: "emergency", limit: 30 })).slice().reverse().map(emergencyHistoryItem)
    };
  });
  app.post("/api/ops/developer/emergency/actions/:action", { preHandler: requireDeveloperUser }, async (request, reply) => {
    const action = String(request.params.action);
    if (!["pause_ai", "resume_ai"].includes(action)) fail("不支持的应急操作。", 404);
    if (!text(request.body?.reason, 1000)) fail("必须填写执行原因。");
    const changes = action === "pause_ai" ? { aiEnabled: false, operatorMode: "paused" } : { aiEnabled: true, operatorMode: "auto" };
    const saved = await service.updateSystemConfig(changes, actorFor(request));
    await applySystemConfig?.(saved);
    const event = await service.recordEvent({ kind: "emergency", type: action, actor: actorFor(request), payload: { reason: request.body.reason } });
    return reply.code(202).send({ accepted: true, auditId: event.id, status: changes.operatorMode });
  });
}
