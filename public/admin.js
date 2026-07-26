(function () {
  "use strict";

  /*
   * Admin API contract (all responses JSON, same-origin authenticated session):
   * GET  /api/ops/me -> {user:{name,role}}
   * GET  /api/ops/overview -> {metrics,queue,alerts,content,activity,generatedAt}
   * GET  /api/ops/sessions -> {items:[{id,customerName,preview,status,priority,updatedAt,unreadCount}]}
   * GET  /api/ops/sessions/:id -> {session,messages,customer,handoff}
   * POST /api/ops/sessions/:id/acknowledge|takeover|messages|resolve
   * GET  /api/ops/important-information -> {revision,fields,updatedAt}
   * PUT  /api/ops/important-information/draft -> {revision,savedAt}
   * POST /api/ops/important-information/preview -> {previewUrl}
   * GET  /api/ops/content -> {items:[{id,title,page,status,locale,updatedAt,author,previewUrl}]}
   * POST /api/ops/content and /api/ops/content/:id/submit-review
   * GET|PUT /api/ops/notifications -> {events,channels}
   * GET|PUT /api/ops/rules -> {mode,handoff,note,revision}
   * POST /api/ops/rules/test -> {matched,action,explanation}
   * GET  /api/ops/audit -> {items:[{id,actor,action,target,summary,createdAt,result}]}
   */

  const Ops = window.QinyiOps;
  const SESSION_POLL_INTERVAL_MS = 6_000;
  const ALERT_POLL_INTERVAL_MS = 15_000;
  const loaded = new Set();
  let currentView = "dashboard";
  let shell;
  let sessions = [];
  let activeSessionId = null;
  let sessionPoll = null;
  let alertPoll = null;
  let alertsEnabled = false;
  let alertsPrimed = false;
  let audioContext = null;
  const knownAlertIds = new Set();
  let contentItems = [];
  let auditItems = [];

  const loaders = {
    dashboard: loadDashboard,
    sessions: loadSessions,
    important: loadImportant,
    content: loadContent,
    notifications: loadNotifications,
    rules: loadRules,
    audit: loadAudit,
  };

  function endpointId(id) {
    return encodeURIComponent(String(id));
  }

  function setHtml(id, html) {
    const element = document.getElementById(id);
    if (element) element.innerHTML = html;
  }

  async function loadIdentity() {
    try {
      const data = await Ops.request("/api/ops/me");
      const user = data.user || data;
      document.getElementById("operatorName").textContent = user.name || "运营管理员";
      document.getElementById("operatorRole").textContent = user.roleLabel || user.role || "管理员";
      Ops.setConnection("运营服务已连接", "positive");
      startAlertPolling();
    } catch (error) {
      document.getElementById("operatorRole").textContent = error.status === 401 || error.status === 403 ? "需要登录" : "服务待接入";
      Ops.setConnection(error.status === 401 || error.status === 403 ? "身份验证失败" : "运营接口未连接", "negative");
    }
  }

  function updateAlertButton() {
    const button = document.getElementById("enableAlertsButton");
    if (!button) return;
    button.setAttribute("aria-pressed", String(alertsEnabled));
    const label = button.querySelector(".button-label-wide");
    if (label) label.textContent = alertsEnabled ? "提醒已开启" : "开启提醒";
  }

  function playAlertSound() {
    if (!alertsEnabled) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audioContext = audioContext || new Context();
    if (audioContext.state === "suspended") void audioContext.resume();
    const start = audioContext.currentTime;
    [0, 0.16].forEach((offset, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = index ? 740 : 880;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.14, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.13);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.14);
    });
  }

  function showHandoffAlert(item) {
    playAlertSound();
    Ops.toast(`新的人工服务请求：${item.preview || item.reason || "访客正在等待"}`, "warning");
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const notification = new Notification("勤益：新的人工服务请求", {
      body: item.preview || item.reason || "访客正在等待人工客服",
      tag: `qinyi-handoff-${item.ticketId || item.id}`,
    });
    notification.onclick = function () {
      window.focus();
      shell.activate("sessions", true);
      void loadSessionDetail(item.id);
      notification.close();
    };
  }

  async function pollHandoffAlerts(notifyExisting) {
    try {
      const data = await Ops.request("/api/ops/sessions?limit=100");
      const waiting = Ops.list(data).filter((item) => ["waiting_human", "acknowledged"].includes(item.status));
      const shouldNotify = alertsEnabled && (alertsPrimed || notifyExisting);
      waiting.forEach((item) => {
        const key = String(item.ticketId || item.id);
        if (shouldNotify && !knownAlertIds.has(key)) showHandoffAlert(item);
        knownAlertIds.add(key);
      });
      alertsPrimed = true;
    } catch (_error) {
      // The normal connection indicator already reports API failures.
    }
  }

  function startAlertPolling() {
    window.clearInterval(alertPoll);
    if (!alertsEnabled) return;
    alertPoll = window.setInterval(() => pollHandoffAlerts(false), ALERT_POLL_INTERVAL_MS);
  }

  async function enableAlerts() {
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    alertsEnabled = true;
    updateAlertButton();
    Ops.toast("声音与浏览器提醒已开启");
    knownAlertIds.clear();
    await pollHandoffAlerts(true);
    startAlertPolling();
  }

  function metricCard(label, value, foot, trend, tone) {
    return `<article class="metric"><div><div class="metric-label">${Ops.escapeHtml(label)}</div><div class="metric-value">${Ops.formatNumber(value)}</div></div><div class="metric-foot"><span>${Ops.escapeHtml(foot || "")}</span>${trend ? `<span class="trend" data-tone="${tone || "positive"}">${Ops.escapeHtml(trend)}</span>` : ""}</div></article>`;
  }

  async function loadDashboard() {
    ["dashboardMetrics", "dashboardQueue", "dashboardAlerts", "dashboardContent", "dashboardActivity"].forEach((id) => Ops.setBusy(document.getElementById(id)));
    try {
      const data = await Ops.request("/api/ops/overview");
      const metrics = data.metrics || {};
      setHtml("dashboardMetrics", [
        metricCard("等待人工", metrics.waitingHuman, "当前需要接手", metrics.waitingHumanTrend),
        metricCard("今日会话", metrics.todaySessions, "含 AI 与人工", metrics.todaySessionsTrend),
        metricCard("平均等待", metrics.averageWaitMinutes, "分钟", metrics.averageWaitTrend, Number(metrics.averageWaitTrend) > 0 ? "negative" : "positive"),
        metricCard("待审内容", metrics.pendingContent, "发布前需确认", metrics.pendingContentTrend),
      ].join(""));
      const queue = Ops.list(data.queue);
      setHtml("dashboardQueue", queue.length ? `<div class="row-list">${queue.slice(0, 6).map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.customerName || item.title || "访客会话")}</strong><small>${Ops.escapeHtml(item.reason || item.preview || "等待人工处理")}</small></div><div class="row-meta">${Ops.statusBadge(item.priority || item.status, item.priorityLabel)}<small>${Ops.relativeTime(item.updatedAt)}</small></div></div>`).join("")}</div>` : Ops.emptyState("没有等待中的会话", "新的人工请求会显示在这里。"));
      const alerts = Ops.list(data.alerts);
      setHtml("dashboardAlerts", alerts.length ? alerts.slice(0, 5).map((item) => `<div class="alert-item" data-tone="${Ops.statusTone(item.severity)}"><strong>${Ops.escapeHtml(item.title || "服务提醒")}</strong><span>${Ops.escapeHtml(item.detail || item.message || "")}</span></div>`).join("") : Ops.emptyState("当前没有重要提醒", "服务风险或业务变动会显示在这里。"));
      const content = data.content || {};
      setHtml("dashboardContent", `<div class="row-list"><div class="row-item"><div class="row-main"><strong>草稿</strong><small>尚未提交审核</small></div><strong>${Ops.formatNumber(content.draftCount)}</strong></div><div class="row-item"><div class="row-main"><strong>待审核</strong><small>等待负责人确认</small></div><strong>${Ops.formatNumber(content.pendingCount)}</strong></div><div class="row-item"><div class="row-main"><strong>最近发布</strong><small>${Ops.escapeHtml(content.lastPublishedTitle || "暂无发布记录")}</small></div><small>${Ops.relativeTime(content.lastPublishedAt)}</small></div></div>`);
      const activity = Ops.list(data.activity);
      setHtml("dashboardActivity", activity.length ? `<div class="row-list">${activity.slice(0, 6).map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.summary || item.action || "运营操作")}</strong><small>${Ops.escapeHtml(item.actor || "系统")} · ${Ops.relativeTime(item.createdAt)}</small></div>${Ops.statusBadge(item.result || "active", item.resultLabel || "已记录")}</div>`).join("")}</div>` : Ops.emptyState("暂无最近动态", "关键运营操作会留在这里。"));
      Ops.setConnection(`数据更新于 ${Ops.formatTime(data.generatedAt)}`, "positive");
    } catch (error) {
      ["dashboardMetrics", "dashboardQueue", "dashboardAlerts", "dashboardContent", "dashboardActivity"].forEach((id) => setHtml(id, Ops.errorState(error, "dashboard")));
      Ops.setConnection("工作台数据不可用", "negative");
    }
  }

  function filteredSessions() {
    const query = document.getElementById("sessionSearch").value.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((item) => [item.customerName, item.preview, item.id, item.ticketId].some((value) => String(value || "").toLowerCase().includes(query)));
  }

  function renderSessionList() {
    const items = filteredSessions();
    setHtml("sessionList", items.length ? items.map((item) => `<button class="session-item${String(item.id) === String(activeSessionId) ? " is-active" : ""}" type="button" data-session-id="${Ops.escapeHtml(item.id)}"><span class="session-item-head"><span class="session-item-name">${Ops.escapeHtml(item.customerName || "匿名访客")}</span><time class="session-item-time">${Ops.relativeTime(item.updatedAt)}</time></span><span class="session-item-preview">${Ops.escapeHtml(item.preview || "暂无消息摘要")}</span><span class="session-item-foot">${Ops.statusBadge(item.status || "open", item.statusLabel)}${item.unreadCount ? `<span class="tag tag--blue">${Ops.formatNumber(item.unreadCount)} 条新消息</span>` : ""}</span></button>`).join("") : Ops.emptyState("没有符合条件的会话", "调整搜索条件或等待新的访客消息。"));
  }

  async function loadSessions(silent) {
    if (!silent) Ops.setBusy(document.getElementById("sessionList"), "正在读取会话");
    try {
      const data = await Ops.request("/api/ops/sessions?limit=80&status=open,pending,active");
      sessions = Ops.list(data);
      renderSessionList();
      const activeCount = sessions.filter((item) => !["resolved", "closed"].includes(item.status)).length;
      document.getElementById("sessionLiveStatus").innerHTML = Ops.statusBadge("online", `${activeCount} 个进行中`);
      if (activeSessionId) await loadSessionDetail(activeSessionId);
      Ops.setConnection("会话已同步", "positive");
    } catch (error) {
      if (!silent) setHtml("sessionList", Ops.errorState(error, "sessions"));
      document.getElementById("sessionLiveStatus").innerHTML = Ops.statusBadge("offline", "同步失败");
    }
  }

  function renderMessages(messages) {
    return messages.length ? messages.map((message) => {
      if (String(message.role).toLowerCase() === "system") {
        return `<div class="ops-system-event"><time>${Ops.formatTime(message.createdAt)}</time><span>${Ops.escapeHtml(message.text || message.content || "")}</span></div>`;
      }
      const visitor = ["user", "visitor", "customer"].includes(String(message.role).toLowerCase());
      return `<article class="ops-message${visitor ? " ops-message--visitor" : ""}"><span class="message-avatar">${visitor ? "客" : message.role === "agent" ? "人" : "AI"}</span><div class="message-body"><div class="message-meta"><strong>${Ops.escapeHtml(message.author || (visitor ? "访客" : message.role === "agent" ? "人工客服" : "智能客服"))}</strong><time>${Ops.formatTime(message.createdAt)}</time></div><div class="message-bubble">${Ops.escapeHtml(message.text || message.content || "")}</div></div></article>`;
    }).join("") : Ops.emptyState("尚无消息", "访客发送消息后会显示在这里。");
  }

  async function loadSessionDetail(id) {
    activeSessionId = String(id);
    renderSessionList();
    Ops.setBusy(document.getElementById("messageStream"), "正在读取对话");
    Ops.setBusy(document.getElementById("sessionDetail"), "正在读取客户信息");
    try {
      const data = await Ops.request(`/api/ops/sessions/${endpointId(id)}`);
      const session = data.session || {};
      const customer = data.customer || {};
      const handoff = data.handoff || {};
      const claimed = Boolean(session.claimedByCurrentUser || session.assignment?.isCurrentUser);
      const claimedBySomeone = Boolean(session.claimedBySomeone);
      let actions = "";
      if (["resolved", "closed"].includes(session.status)) actions = Ops.statusBadge(session.status);
      else if (session.status === "waiting_human") actions = `<button class="button button--secondary button--small" type="button" data-session-action="acknowledge">确认知晓</button>`;
      else if (session.status === "acknowledged" && !claimedBySomeone) actions = `<button class="button button--secondary button--small" type="button" data-session-action="takeover">接管</button>`;
      else if (claimed) actions = `<button class="button button--secondary button--small" type="button" data-session-action="resolve">结束</button>`;
      else if (claimedBySomeone) actions = Ops.statusBadge("active", `由 ${session.assigneeName || "其他客服"} 处理`);
      setHtml("conversationHead", `<div><h2>${Ops.escapeHtml(customer.name || session.customerName || "匿名访客")}</h2><p>${Ops.escapeHtml(session.channelLabel || "网站客服")} · ${Ops.escapeHtml(session.language || "语言待确认")}</p></div><div class="page-actions">${actions}</div>`);
      setHtml("messageStream", renderMessages(Ops.list(data.messages)));
      const stream = document.getElementById("messageStream");
      stream.scrollTop = stream.scrollHeight;
      document.getElementById("replyInput").disabled = !claimed || session.status === "resolved";
      document.getElementById("sendReplyButton").disabled = !claimed || session.status === "resolved";
      setHtml("sessionDetail", `<section class="detail-section"><h3>联系方式</h3><dl class="detail-list"><div><dt>姓名</dt><dd>${Ops.escapeHtml(customer.name || "未提供")}</dd></div><div><dt>公司</dt><dd>${Ops.escapeHtml(customer.company || "未提供")}</dd></div><div><dt>邮箱</dt><dd>${Ops.escapeHtml(customer.email || "未提供")}</dd></div><div><dt>地区</dt><dd>${Ops.escapeHtml(customer.country || customer.region || "未确认")}</dd></div></dl></section><section class="detail-section"><h3>服务信息</h3><dl class="detail-list"><div><dt>会话编号</dt><dd>${Ops.escapeHtml(session.id || id)}</dd></div><div><dt>状态</dt><dd>${Ops.statusBadge(session.status, session.statusLabel)}</dd></div><div><dt>负责人</dt><dd>${Ops.escapeHtml(session.assigneeName || "尚未分配")}</dd></div><div><dt>开始时间</dt><dd>${Ops.formatTime(session.createdAt, true)}</dd></div></dl></section><section class="detail-section"><h3>转人工原因</h3><p>${Ops.escapeHtml(handoff.reason || "未记录特殊原因")}</p>${handoff.ticketId ? `<span class="tag">工单 ${Ops.escapeHtml(handoff.ticketId)}</span>` : ""}</section><section class="detail-section"><h3>客户意向</h3><p>${Ops.escapeHtml(customer.intentSummary || session.summary || "尚未形成摘要")}</p></section>`);
    } catch (error) {
      setHtml("messageStream", Ops.errorState(error));
      setHtml("sessionDetail", Ops.errorState(error));
    }
  }

  async function sessionAction(action) {
    if (!activeSessionId) return;
    const labels = { acknowledge: "已确认人工服务请求", takeover: "会话已接管", resolve: "会话已结束" };
    try {
      await Ops.request(`/api/ops/sessions/${endpointId(activeSessionId)}/${action}`, { method: "POST", body: {} });
      Ops.toast(labels[action] || "操作已完成");
      await Promise.all([loadSessions(true), loadSessionDetail(activeSessionId)]);
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function sendReply(event) {
    event.preventDefault();
    const input = document.getElementById("replyInput");
    const message = input.value.trim();
    if (!activeSessionId || !message) return;
    const button = document.getElementById("sendReplyButton");
    button.disabled = true;
    try {
      await Ops.request(`/api/ops/sessions/${endpointId(activeSessionId)}/messages`, { method: "POST", body: { message } });
      input.value = "";
      await loadSessionDetail(activeSessionId);
    } catch (error) { Ops.toast(error.message, "negative"); }
    finally { button.disabled = false; }
  }

  function inputField(label, name, value, options) {
    const settings = options || {};
    const control = settings.multiline
      ? `<textarea id="important-${name}" name="${name}" maxlength="${settings.maxlength || 1000}" rows="${settings.rows || 4}">${Ops.escapeHtml(value || "")}</textarea>`
      : `<input id="important-${name}" name="${name}" maxlength="${settings.maxlength || 1000}" type="${settings.type || "text"}" value="${Ops.escapeHtml(value || "")}" />`;
    return `<div class="field${settings.wide ? " field--wide" : ""}"><label for="important-${name}">${Ops.escapeHtml(label)}</label>${control}</div>`;
  }

  async function loadImportant() {
    Ops.setBusy(document.getElementById("importantFormBody"));
    try {
      const data = await Ops.request("/api/ops/important-information");
      const fields = data.fields || data;
      setHtml("importantFormBody", `<div class="form-grid">${inputField("业务邮箱", "contactEmail", fields.contactEmail, { type: "email" })}${inputField("联系电话", "contactPhone", fields.contactPhone)}${inputField("当前生产周期", "leadTime", fields.leadTime)}${inputField("起订量说明", "moq", fields.moq)}${inputField("近期假期与停工安排", "holidayNotice", fields.holidayNotice, { multiline: true, wide: true })}${inputField("临时业务说明", "businessNotice", fields.businessNotice, { multiline: true, wide: true })}${inputField("禁止承诺事项", "restrictedCommitments", Array.isArray(fields.restrictedCommitments) ? fields.restrictedCommitments.join("\n") : fields.restrictedCommitments, { multiline: true, wide: true })}</div><p class="cell-subtitle">当前版本：${Ops.escapeHtml(data.revision || "未发布")} · 最近更新：${Ops.formatTime(data.updatedAt, true)}</p>`);
    } catch (error) { setHtml("importantFormBody", Ops.errorState(error, "important")); }
  }

  function formObject(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  async function saveImportant(event) {
    event.preventDefault();
    const fields = formObject(event.currentTarget);
    fields.restrictedCommitments = String(fields.restrictedCommitments || "").split(/\n+/).map((item) => item.trim()).filter(Boolean);
    try {
      const data = await Ops.request("/api/ops/important-information/draft", { method: "PUT", body: { fields } });
      Ops.toast(`草稿已保存${data.revision ? ` · ${data.revision}` : ""}`);
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function previewImportant() {
    const form = document.getElementById("importantForm");
    const fields = formObject(form);
    try {
      const data = await Ops.request("/api/ops/important-information/preview", { method: "POST", body: { fields } });
      if (data.previewUrl) window.open(data.previewUrl, "_blank", "noopener");
      else Ops.toast("预览已生成，但接口未返回预览地址。", "negative");
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  function renderContent() {
    const query = document.getElementById("contentSearch").value.trim().toLowerCase();
    const status = document.getElementById("contentStatusFilter").value;
    const items = contentItems.filter((item) => (!query || [item.title, item.page, item.locale].some((value) => String(value || "").toLowerCase().includes(query))) && (!status || item.status === status));
    setHtml("contentTable", items.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>内容</th><th>页面</th><th>语言</th><th>状态</th><th>最近更新</th><th>操作</th></tr></thead><tbody>${items.map((item) => `<tr><td><span class="cell-title">${Ops.escapeHtml(item.title || "未命名内容")}</span><span class="cell-subtitle">${Ops.escapeHtml(item.author || "未知编辑者")}</span></td><td>${Ops.escapeHtml(item.page || "--")}</td><td>${Ops.escapeHtml(item.locale || "全部")}</td><td>${Ops.statusBadge(item.status, item.statusLabel)}</td><td>${Ops.relativeTime(item.updatedAt)}</td><td><div class="page-actions">${item.previewUrl ? `<a class="button button--secondary button--small" href="${Ops.escapeHtml(item.previewUrl)}" target="_blank" rel="noopener">预览</a>` : `<button class="button button--secondary button--small" type="button" data-content-action="preview" data-content-id="${Ops.escapeHtml(item.id)}">预览</button>`}${item.status === "draft" ? `<button class="button button--small" type="button" data-content-action="submit-review" data-content-id="${Ops.escapeHtml(item.id)}">送审</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("没有符合条件的内容", "新建内容或调整筛选条件。"));
  }

  async function loadContent() {
    Ops.setBusy(document.getElementById("contentTable"));
    try {
      const data = await Ops.request("/api/ops/content?limit=100");
      contentItems = Ops.list(data);
      renderContent();
    } catch (error) { setHtml("contentTable", Ops.errorState(error, "content")); }
  }

  async function createContent() {
    const title = window.prompt("请输入内容标题");
    if (!title || !title.trim()) return;
    try {
      await Ops.request("/api/ops/content", { method: "POST", body: { title: title.trim(), locale: "zh-CN" } });
      Ops.toast("内容草稿已创建");
      await loadContent();
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function contentAction(action, id) {
    try {
      const data = await Ops.request(`/api/ops/content/${endpointId(id)}/${action}`, { method: "POST", body: {} });
      if (action === "preview" && data.previewUrl) window.open(data.previewUrl, "_blank", "noopener");
      else Ops.toast(action === "submit-review" ? "已提交审核" : "操作已完成");
      await loadContent();
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  function toggleRows(items, group) {
    return items.map((item) => `<div class="toggle-row"><div class="toggle-copy"><strong>${Ops.escapeHtml(item.label || item.name)}</strong><small>${Ops.escapeHtml(item.description || "")}</small></div><label class="switch"><input type="checkbox" name="${group}:${Ops.escapeHtml(item.key)}" ${item.enabled ? "checked" : ""} /><span aria-hidden="true"></span><span class="sr-only">启用${Ops.escapeHtml(item.label || item.name)}</span></label></div>`).join("");
  }

  async function loadNotifications() {
    Ops.setBusy(document.getElementById("notificationEvents"));
    Ops.setBusy(document.getElementById("notificationChannels"));
    try {
      const data = await Ops.request("/api/ops/notifications");
      setHtml("notificationEvents", toggleRows(Ops.list(data.events), "event") || Ops.emptyState("暂无事件配置"));
      setHtml("notificationChannels", toggleRows(Ops.list(data.channels), "channel") || Ops.emptyState("暂无接收渠道"));
    } catch (error) {
      setHtml("notificationEvents", Ops.errorState(error, "notifications"));
      setHtml("notificationChannels", Ops.errorState(error, "notifications"));
    }
  }

  async function saveNotifications(event) {
    event.preventDefault();
    const values = Array.from(event.currentTarget.querySelectorAll('input[type="checkbox"]')).map((input) => ({ key: input.name.split(":")[1], group: input.name.split(":")[0], enabled: input.checked }));
    try { await Ops.request("/api/ops/notifications", { method: "PUT", body: { settings: values } }); Ops.toast("通知设置已保存"); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function loadRules() {
    Ops.setBusy(document.getElementById("serviceModeRules"));
    Ops.setBusy(document.getElementById("handoffRules"));
    try {
      const data = await Ops.request("/api/ops/rules");
      const modes = [
        { value: "auto", label: "AI 优先", description: "常规问题自动回复，敏感事项转人工" },
        { value: "draft", label: "人工审核", description: "AI 生成草稿，由客服确认后发送" },
        { value: "paused", label: "人工优先", description: "暂停自动回复，所有会话进入人工队列" },
      ];
      setHtml("serviceModeRules", `<div class="stack">${modes.map((mode) => `<label class="toggle-row"><span class="toggle-copy"><strong>${mode.label}</strong><small>${mode.description}</small></span><input type="radio" name="serviceMode" value="${mode.value}" ${data.mode === mode.value ? "checked" : ""} /></label>`).join("")}</div>`);
      setHtml("handoffRules", toggleRows(Ops.list(data.handoff), "handoff") || Ops.emptyState("尚未配置转人工规则"));
      document.getElementById("rulesNote").value = data.note || "";
    } catch (error) {
      setHtml("serviceModeRules", Ops.errorState(error, "rules"));
      setHtml("handoffRules", Ops.errorState(error, "rules"));
    }
  }

  async function saveRules(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const mode = form.querySelector('input[name="serviceMode"]:checked')?.value || "auto";
    const handoff = Array.from(document.querySelectorAll('#handoffRules input[type="checkbox"]')).map((input) => ({ key: input.name.split(":")[1], enabled: input.checked }));
    try { await Ops.request("/api/ops/rules", { method: "PUT", body: { mode, handoff, note: document.getElementById("rulesNote").value } }); Ops.toast("规则草稿已保存"); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function testRules() {
    const message = window.prompt("输入一条客户问题，用于测试当前规则");
    if (!message || !message.trim()) return;
    try {
      const data = await Ops.request("/api/ops/rules/test", { method: "POST", body: { message: message.trim() } });
      Ops.toast(`${data.matched ? "已命中规则" : "未命中特殊规则"}${data.action ? `：${data.action}` : ""}${data.explanation ? ` · ${data.explanation}` : ""}`, data.action === "block" ? "negative" : "positive");
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  function renderAudit() {
    const query = document.getElementById("auditSearch").value.trim().toLowerCase();
    const action = document.getElementById("auditActionFilter").value;
    const items = auditItems.filter((item) => (!query || [item.actor, item.action, item.target, item.summary].some((value) => String(value || "").toLowerCase().includes(query))) && (!action || String(item.category || item.action || "").includes(action)));
    setHtml("auditTable", items.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>说明</th><th>结果</th></tr></thead><tbody>${items.map((item) => `<tr><td>${Ops.formatTime(item.createdAt, true)}</td><td>${Ops.escapeHtml(item.actor || "系统")}</td><td>${Ops.escapeHtml(item.actionLabel || item.action || "--")}</td><td>${Ops.escapeHtml(item.target || "--")}</td><td>${Ops.escapeHtml(item.summary || "--")}</td><td>${Ops.statusBadge(item.result || "active", item.resultLabel || "已记录")}</td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("没有符合条件的操作记录", "调整搜索或筛选条件。"));
  }

  async function loadAudit() {
    Ops.setBusy(document.getElementById("auditTable"));
    try { const data = await Ops.request("/api/ops/audit?limit=200"); auditItems = Ops.list(data); renderAudit(); }
    catch (error) { setHtml("auditTable", Ops.errorState(error, "audit")); }
  }

  function onView(view) {
    currentView = view;
    if (view === "sessions") {
      window.clearInterval(sessionPoll);
      sessionPoll = window.setInterval(() => loadSessions(true), SESSION_POLL_INTERVAL_MS);
    } else window.clearInterval(sessionPoll);
    if (!loaded.has(view)) {
      loaded.add(view);
      loaders[view]();
    }
  }

  function bindEvents() {
    document.getElementById("enableAlertsButton").addEventListener("click", enableAlerts);
    document.querySelector("[data-refresh-current]").addEventListener("click", () => loaders[currentView]());
    document.querySelectorAll("[data-go-view]").forEach((button) => button.addEventListener("click", () => shell.activate(button.dataset.goView, true)));
    document.getElementById("sessionSearch").addEventListener("input", renderSessionList);
    document.getElementById("sessionList").addEventListener("click", (event) => { const item = event.target.closest("[data-session-id]"); if (item) loadSessionDetail(item.dataset.sessionId); });
    document.getElementById("conversationHead").addEventListener("click", (event) => { const button = event.target.closest("[data-session-action]"); if (button) sessionAction(button.dataset.sessionAction); });
    document.getElementById("replyForm").addEventListener("submit", sendReply);
    document.getElementById("importantForm").addEventListener("submit", saveImportant);
    document.getElementById("importantPreviewButton").addEventListener("click", previewImportant);
    document.getElementById("contentSearch").addEventListener("input", renderContent);
    document.getElementById("contentStatusFilter").addEventListener("change", renderContent);
    document.getElementById("newContentButton").addEventListener("click", createContent);
    document.getElementById("contentTable").addEventListener("click", (event) => { const button = event.target.closest("[data-content-action]"); if (button) contentAction(button.dataset.contentAction, button.dataset.contentId); });
    document.getElementById("notificationsForm").addEventListener("submit", saveNotifications);
    document.getElementById("rulesForm").addEventListener("submit", saveRules);
    document.getElementById("rulesTestButton").addEventListener("click", testRules);
    document.getElementById("auditSearch").addEventListener("input", renderAudit);
    document.getElementById("auditActionFilter").addEventListener("change", renderAudit);
    document.getElementById("exportAuditButton").addEventListener("click", () => { window.location.href = "/api/ops/audit/export?format=csv"; });
  }

  bindEvents();
  updateAlertButton();
  shell = Ops.initShell({ defaultView: "dashboard", onView, onRetry: (view) => loaders[view]?.() });
  loadIdentity();
}());
