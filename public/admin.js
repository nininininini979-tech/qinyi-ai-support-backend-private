(function () {
  "use strict";

  /*
   * Admin API contract (all responses JSON, same-origin authenticated session):
   * GET  /api/ops/me -> {user:{name,role}}
   * GET  /api/ops/overview -> {metrics,queue,alerts,content,activity,generatedAt}
   * GET  /api/ops/sessions -> {items:[{id,customerName,preview,status,priority,updatedAt,unreadCount}]}
   * GET  /api/ops/sessions/:id -> {session,messages,attachments,customer,handoff}
   * POST /api/ops/sessions/:id/acknowledge|takeover|messages|resolve
   * GET  /api/ops/important-information -> {revision,fields,updatedAt}
   * PUT  /api/ops/important-information/draft -> {revision,savedAt}
   * POST /api/ops/important-information/preview -> {previewUrl}
   * GET  /api/ops/content -> {items:[{id,title,page,status,locale,updatedAt,author,previewUrl}]}
   * POST /api/ops/content and /api/ops/content/:id/submit-review
   * GET|PUT /api/ops/notifications -> {events,channels}
   * GET|PUT /api/ops/rules -> {mode,handoff,note,revision}
   * POST /api/ops/rules/test -> {matched,action,explanation}
   * POST /api/ops/ai-drafts/:id/approve|reject -> reviewed AI draft
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
  let contentWorkspace = null;
  let contentAssets = [];
  let activePageId = null;
  let seoState = null;
  let scheduleState = null;
  let profileUser = null;
  let orderItems = [];
  let orderQuotes = [];
  let activeOrderId = null;
  let rulesRevision = null;

  const loaders = {
    dashboard: loadDashboard,
    sessions: loadSessions,
    orders: loadOrders,
    important: loadImportant,
    content: loadContent,
    analytics: loadAnalytics,
    seo: loadSeo,
    notifications: loadNotifications,
    rules: loadRules,
    schedule: loadSchedule,
    profile: loadProfile,
    audit: loadAudit,
  };

  function endpointId(id) {
    return encodeURIComponent(String(id));
  }

  function setHtml(id, html) {
    const element = document.getElementById(id);
    if (element) element.innerHTML = html;
  }

  function formatFileSize(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const customerOrderStages = ["inquiry","quoted","price_confirmed","files_received","layout_confirmed","sample_ordered","sample_confirmed","bulk_ordered","deposit_arranged","bulk_production","balance_paid","shipped"];
  const customerOrderLabels = ["询盘状态","报价","确认价格","提供文件","排版确认","下单打样","样品确认","下大货单","安排订金","大货生产","支付尾款","订单发货"];
  const productionOrderStages = ["order_received","production_order_created","materials_prepared","prepress_layout","materials_issued","printing","surface_finishing","laminating","die_cutting","stamping","box_assembly","packing","dispatched"];
  const productionOrderLabels = ["接到客户订单","开生产单","备料","排版","发料","印刷","表面工艺处理","裱合","啤切","冲压","包盒","包装","出货"];

  function orderProgress(labels, currentIndex) {
    return `<div class="row-list">${labels.map((label, index) => `<div class="row-item"><div class="row-main"><strong>${index + 1}. ${Ops.escapeHtml(label)}</strong></div>${Ops.statusBadge(index < currentIndex ? "complete" : index === currentIndex ? "active" : "pending", index < currentIndex ? "已完成" : index === currentIndex ? "当前" : "待处理")}</div>`).join("")}</div>`;
  }

  function renderOrderDetail() {
    const order = orderItems.find((item) => item.id === activeOrderId);
    if (!order) return setHtml("orderDetail", Ops.emptyState("请选择一个订单"));
    const nextCustomer = customerOrderStages[order.stageIndex + 1];
    const nextProduction = order.productionStageIndex == null ? null : productionOrderStages[order.productionStageIndex + 1];
    setHtml("orderDetail", `<div class="detail-section"><h3>${Ops.escapeHtml(order.title)}</h3><dl class="detail-list"><div><dt>订单编号</dt><dd>${Ops.escapeHtml(order.id)}</dd></div><div><dt>客户手机</dt><dd>${Ops.escapeHtml(order.customerPhoneMasked)}</dd></div><div><dt>当前阶段</dt><dd>${Ops.escapeHtml(customerOrderLabels[order.stageIndex] || order.stage)}</dd></div><div><dt>关联询价</dt><dd>${Ops.escapeHtml(order.quoteId || "未关联")}</dd></div></dl></div>
      <div class="detail-section"><h3>客户订单流程</h3>${orderProgress(customerOrderLabels, order.stageIndex)}${nextCustomer ? `<button class="button" type="button" data-order-advance="${Ops.escapeHtml(nextCustomer)}">推进至：${Ops.escapeHtml(customerOrderLabels[order.stageIndex + 1])}</button>` : ""}</div>
      ${order.productionStageIndex == null ? "" : `<div class="detail-section"><h3>工厂生产流程</h3>${orderProgress(productionOrderLabels, order.productionStageIndex)}${nextProduction ? `<button class="button button--secondary" type="button" data-production-advance="${Ops.escapeHtml(nextProduction)}">推进至：${Ops.escapeHtml(productionOrderLabels[order.productionStageIndex + 1])}</button>` : ""}</div>`}`);
  }

  function renderOrders() {
    const active = orderItems.filter((item) => item.status === "active").length;
    const production = orderItems.filter((item) => item.stage === "bulk_production").length;
    setHtml("orderMetrics", `${metricCard("全部订单", orderItems.length, "", "已建立")}${metricCard("进行中", active, "", "当前")}${metricCard("大货生产", production, "", "当前阶段")}`);
    setHtml("orderTable", orderItems.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>订单</th><th>客户</th><th>阶段</th><th>生产</th><th>更新时间</th></tr></thead><tbody>${orderItems.map((item) => `<tr data-order-id="${Ops.escapeHtml(item.id)}" tabindex="0"><td><span class="cell-title">${Ops.escapeHtml(item.title)}</span><span class="cell-subtitle">${Ops.escapeHtml(item.id)}</span></td><td>${Ops.escapeHtml(item.customerPhoneMasked)}</td><td>${Ops.statusBadge("active", customerOrderLabels[item.stageIndex] || item.stage)}</td><td>${Ops.escapeHtml(item.productionStageIndex == null ? "未开始" : productionOrderLabels[item.productionStageIndex])}</td><td>${Ops.formatTime(item.updatedAt, true)}</td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("暂无订单", "可从询价确认后建立订单。"));
    setHtml("orderQuoteQueue", orderQuotes.length ? `<div class="row-list">${orderQuotes.map((quote) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(quote.name || quote.company || quote.id)}</strong><small>${Ops.escapeHtml(quote.id)} · ${Ops.escapeHtml(quote.product || "产品待补充")} · ${Ops.escapeHtml(quote.quantity || "数量待补充")}</small></div><button class="button button--secondary button--small" type="button" data-order-use-quote="${Ops.escapeHtml(quote.id)}">带入</button></div>`).join("")}</div>` : Ops.emptyState("暂无待转订单询价"));
    const select = document.getElementById("orderQuoteId");
    const selected = select.value;
    select.innerHTML = `<option value="">不关联询价</option>${orderQuotes.map((quote) => `<option value="${Ops.escapeHtml(quote.id)}">${Ops.escapeHtml(quote.id)} · ${Ops.escapeHtml(quote.name || quote.company || "未命名客户")}</option>`).join("")}`;
    if (orderQuotes.some((quote) => quote.id === selected)) select.value = selected;
    renderOrderDetail();
  }

  async function loadOrders() {
    Ops.setBusy(document.getElementById("orderTable"));
    Ops.setBusy(document.getElementById("orderQuoteQueue"));
    try {
      const [orders, quotes] = await Promise.all([Ops.request("/api/admin/orders"), Ops.request("/api/admin/quotes?status=new&limit=100")]);
      orderItems = Ops.list(orders);
      orderQuotes = Ops.list(quotes);
      if (!activeOrderId || !orderItems.some((item) => item.id === activeOrderId)) activeOrderId = orderItems[0]?.id || null;
      renderOrders();
    } catch (error) {
      setHtml("orderTable", Ops.errorState(error, "orders"));
      setHtml("orderQuoteQueue", Ops.errorState(error, "orders"));
    }
  }

  async function useOrderQuote(quoteId) {
    try {
      const quote = await Ops.request(`/api/admin/quotes/${endpointId(quoteId)}`);
      const form = document.getElementById("newOrderForm");
      form.quoteId.value = quote.id;
      form.customerPhone.value = quote.contact?.phone || "";
      form.title.value = `${quote.product || "定制印刷"} · ${quote.name || quote.company || quote.id}`;
      form.summary.value = [
        quote.quantity && `数量：${quote.quantity}`,
        quote.finishedDimensions && `尺寸：${quote.finishedDimensions}`,
        quote.material && `材质：${quote.material}`,
        quote.process && `工艺：${quote.process}`,
        quote.delivery && `期望交期：${quote.delivery}`,
        quote.notes
      ].filter(Boolean).join("\n").slice(0, 4000);
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      form.customerPhone.focus();
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function createOrder(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const order = await Ops.request("/api/admin/orders", { method: "POST", body: {
        quoteId: form.quoteId.value || null,
        customerPhone: form.customerPhone.value.trim(),
        title: form.title.value.trim(),
        summary: form.summary.value.trim(),
        externalReference: form.externalReference.value.trim()
      } });
      activeOrderId = order.id;
      form.reset();
      await loadOrders();
      document.getElementById("orderDetail").scrollIntoView({ behavior: "smooth", block: "start" });
      Ops.toast("订单已建立");
    }
    catch (error) { Ops.toast(error.message, "negative"); }
    finally { submit.disabled = false; }
  }

  async function advanceOrder(targetStage, production) {
    if (!activeOrderId) return;
    const note = window.prompt("本次推进备注（可留空）") || "";
    const path = production ? `/api/admin/orders/${endpointId(activeOrderId)}/production/advance` : `/api/admin/orders/${endpointId(activeOrderId)}/advance`;
    try { await Ops.request(path, { method: "POST", body: { targetStage, note } }); await loadOrders(); Ops.toast("订单进度已更新"); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function loadIdentity() {
    try {
      const data = await Ops.request("/api/ops/me");
      const user = data.user || data;
      profileUser = user;
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

  function showTransferAlert(item) {
    playAlertSound();
    Ops.toast("收到一项待确认的会话转交，请进入人工接管处理。", "warning");
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const notification = new Notification("勤益：待确认的会话转交", {
      body: "您可以确认接管、退回或再次转交。",
      tag: `qinyi-transfer-${item.id}`
    });
    notification.onclick = function () {
      window.focus();
      shell.activate("sessions", true);
      if (item.conversationId) void loadSessionDetail(item.conversationId);
      notification.close();
    };
  }

  async function pollHandoffAlerts(notifyExisting) {
    try {
      const [data, notificationData] = await Promise.all([
        Ops.request("/api/ops/sessions?limit=100"),
        Ops.request("/api/admin/notifications?status=pending&limit=100")
      ]);
      const waiting = Ops.list(data).filter((item) => ["waiting_human", "acknowledged"].includes(item.status));
      const transfers = Ops.list(notificationData).filter((item) => item.type === "handoff_transfer_requested");
      const shouldNotify = alertsEnabled && (alertsPrimed || notifyExisting);
      waiting.forEach((item) => {
        const key = `handoff:${item.ticketId || item.id}`;
        if (shouldNotify && !knownAlertIds.has(key)) showHandoffAlert(item);
        knownAlertIds.add(key);
      });
      transfers.forEach((item) => {
        const key = `transfer:${item.id}`;
        if (shouldNotify && !knownAlertIds.has(key)) showTransferAlert(item);
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

  function renderAiDrafts(drafts) {
    if (!drafts.length) return `<p class="cell-subtitle">当前会话没有待审核 AI 草稿</p>`;
    return `<div class="stack">${drafts.map((draft) => {
      const pending = draft.status === "pending";
      const label = draft.mode === "observe" ? "观察模式建议" : "AI 回复草稿";
      return `<article class="alert-item" data-tone="${pending ? "warning" : draft.status === "approved" ? "positive" : "neutral"}" data-ai-draft-id="${Ops.escapeHtml(draft.id)}"><strong>${Ops.escapeHtml(label)} · ${Ops.escapeHtml(draft.id)}</strong><span>${Ops.formatTime(draft.createdAt, true)} · ${draft.grounded ? "已有资料依据" : "资料依据不足，需谨慎核实"}</span>${pending ? `<div class="field"><label>审核后发送内容</label><textarea rows="6" maxlength="4000" data-ai-draft-content>${Ops.escapeHtml(draft.content || "")}</textarea></div><div class="page-actions"><button class="button button--secondary button--small" type="button" data-ai-draft-action="reject">驳回草稿</button><button class="button button--small" type="button" data-ai-draft-action="approve">批准并发送</button></div>` : `<p>${Ops.escapeHtml(draft.status === "approved" ? `已由 ${draft.reviewerName || "管理员"} 批准并发送` : `已驳回：${draft.rejectionReason || "未记录原因"}`)}</p>`}</article>`;
    }).join("")}</div>`;
  }

  async function loadHandoffTools(handoff, claimed) {
    const handoffId = handoff?.ticketId || handoff?.id;
    if (!handoffId) return;
    try {
      const [operators, transfers, notes] = await Promise.all([
        Ops.request("/api/admin/operators"),
        Ops.request(`/api/admin/handoffs/${endpointId(handoffId)}/transfers`),
        Ops.request(`/api/admin/handoffs/${endpointId(handoffId)}/internal-notes`)
      ]);
      const people = Ops.list(operators).filter((item) => item.username !== profileUser?.username);
      const pending = Ops.list(transfers).find((item) => item.status === "pending");
      const targetOptions = people.map((item) => `<option value="${Ops.escapeHtml(item.username)}">${Ops.escapeHtml(item.name)} · ${Ops.escapeHtml(item.username)}</option>`).join("");
      const incoming = pending?.toUsername === profileUser?.username;
      const transferControls = pending
        ? `<div class="alert-item" data-tone="warning"><strong>${incoming ? "有待确认的转交" : "转交等待对方确认"}</strong><span>${Ops.escapeHtml(pending.fromDisplayName)} → ${Ops.escapeHtml(pending.toDisplayName)}</span>${incoming ? `<div class="page-actions"><button class="button button--small" type="button" data-transfer-action="accept" data-transfer-id="${Ops.escapeHtml(pending.id)}">确认接管</button><button class="button button--secondary button--small" type="button" data-transfer-action="return" data-transfer-id="${Ops.escapeHtml(pending.id)}">退回</button><button class="button button--secondary button--small" type="button" data-transfer-action="forward" data-transfer-id="${Ops.escapeHtml(pending.id)}">再次转交</button></div>` : ""}</div>`
        : claimed && people.length ? `<div class="field"><label for="transferTarget">转交给另一名管理员</label><select id="transferTarget"><option value="">选择接收方</option>${targetOptions}</select></div><div class="field"><label for="transferNote">内部说明（访客不可见，可留空）</label><textarea id="transferNote" rows="3"></textarea></div><button class="button button--secondary button--small" type="button" data-transfer-action="request">发起转交</button>` : `<p class="cell-subtitle">接管后可指定另一名管理员转交。</p>`;
      const noteItems = Ops.list(notes);
      document.getElementById("sessionDetail").insertAdjacentHTML("beforeend", `<section class="detail-section" id="handoffTools"><h3>人工移交</h3>${transferControls}</section><section class="detail-section"><h3>内部备注</h3>${noteItems.length ? `<div class="row-list">${noteItems.map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.actorDisplayName || item.actorUsername)}</strong><small>${Ops.escapeHtml(item.content)} · ${Ops.formatTime(item.createdAt, true)}</small></div></div>`).join("")}</div>` : `<p class="cell-subtitle">暂无内部备注</p>`}<div class="field"><label for="internalNoteInput">新增备注（访客不可见）</label><textarea id="internalNoteInput" rows="3"></textarea></div><button class="button button--secondary button--small" type="button" data-internal-note="${Ops.escapeHtml(handoffId)}">添加备注</button></section>`);
    } catch (error) {
      document.getElementById("sessionDetail").insertAdjacentHTML("beforeend", Ops.errorState(error));
    }
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
      const attachments = Ops.list(data.attachments);
      const aiDrafts = Ops.list(data.aiDrafts);
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
      const attachmentRows = attachments.length ? `<div class="row-list">${attachments.map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.filename || "客户附件")}</strong><small>${Ops.escapeHtml(item.mimeType || "文件")} · ${Ops.escapeHtml(formatFileSize(item.size))}</small></div>${item.downloadable && item.downloadUrl ? `<button class="button button--secondary button--small" type="button" data-attachment-download="${Ops.escapeHtml(item.downloadUrl)}" data-attachment-filename="${Ops.escapeHtml(item.filename || "attachment")}">下载</button>` : Ops.statusBadge("warning", "文件待补充")}</div>`).join("")}</div>` : `<p class="cell-subtitle">客户尚未上传附件</p>`;
      setHtml("sessionDetail", `<section class="detail-section"><h3>联系方式</h3><dl class="detail-list"><div><dt>姓名</dt><dd>${Ops.escapeHtml(customer.name || "未提供")}</dd></div><div><dt>公司</dt><dd>${Ops.escapeHtml(customer.company || "未提供")}</dd></div><div><dt>邮箱</dt><dd>${Ops.escapeHtml(customer.email || "未提供")}</dd></div><div><dt>地区</dt><dd>${Ops.escapeHtml(customer.country || customer.region || "未确认")}</dd></div></dl></section><section class="detail-section"><h3>服务信息</h3><dl class="detail-list"><div><dt>会话编号</dt><dd>${Ops.escapeHtml(session.id || id)}</dd></div><div><dt>状态</dt><dd>${Ops.statusBadge(session.status, session.statusLabel)}</dd></div><div><dt>负责人</dt><dd>${Ops.escapeHtml(session.assigneeName || "尚未分配")}</dd></div><div><dt>开始时间</dt><dd>${Ops.formatTime(session.createdAt, true)}</dd></div></dl></section><section class="detail-section"><h3>AI 草稿审核</h3><p class="cell-subtitle">草稿在管理员明确批准前不会发送给访客。</p>${renderAiDrafts(aiDrafts)}</section><section class="detail-section"><h3>客户附件</h3>${attachmentRows}</section><section class="detail-section"><h3>转人工原因</h3><p>${Ops.escapeHtml(handoff.reason || "未记录特殊原因")}</p>${handoff.ticketId ? `<span class="tag">工单 ${Ops.escapeHtml(handoff.ticketId)}</span>` : ""}</section><section class="detail-section"><h3>客户意向</h3><p>${Ops.escapeHtml(customer.intentSummary || session.summary || "尚未形成摘要")}</p></section>`);
      await loadHandoffTools(handoff, claimed);
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
      await loadSessions(true);
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

  async function reviewAiDraft(container, action) {
    const draftId = container?.dataset.aiDraftId;
    if (!draftId) return;
    const body = action === "approve"
      ? { content: container.querySelector("[data-ai-draft-content]")?.value.trim() || "" }
      : { reason: window.prompt("填写驳回原因")?.trim() || "" };
    if (action === "approve" && !body.content) return Ops.toast("发送内容不能为空", "negative");
    if (action === "reject" && !body.reason) return;
    try {
      await Ops.request(`/api/ops/ai-drafts/${endpointId(draftId)}/${action}`, { method: "POST", body });
      Ops.toast(action === "approve" ? "草稿已由管理员确认并发送给访客" : "草稿已驳回，访客未收到该内容");
      await loadSessions(true);
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function transferAction(action, transferId) {
    try {
      if (action === "request") {
        const target = document.getElementById("transferTarget")?.value;
        if (!target) return Ops.toast("请选择接收管理员", "negative");
        await Ops.request(`/api/admin/handoffs/${endpointId(document.querySelector("[data-internal-note]")?.dataset.internalNote || "")}/transfers`, { method: "POST", body: { targetUsername: target, internalNote: document.getElementById("transferNote")?.value || "" } });
      } else if (action === "forward") {
        const target = window.prompt("输入再次转交的管理员账号（例如 admin02）");
        if (!target?.trim()) return;
        await Ops.request(`/api/admin/handoff-transfers/${endpointId(transferId)}/forward`, { method: "POST", body: { targetUsername: target.trim(), internalNote: "再次转交" } });
      } else {
        await Ops.request(`/api/admin/handoff-transfers/${endpointId(transferId)}/${action}`, { method: "POST", body: { internalNote: action === "return" ? (window.prompt("退回说明（可留空）", "") || "") : "" } });
      }
      Ops.toast(action === "accept" ? "已确认接管" : action === "return" ? "已退回转交" : action === "forward" ? "已再次转交" : "转交请求已发送");
      await loadSessionDetail(activeSessionId);
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function addInternalNote(handoffId) {
    const input = document.getElementById("internalNoteInput");
    const content = input?.value.trim();
    if (!content) return;
    try { await Ops.request(`/api/admin/handoffs/${endpointId(handoffId)}/internal-notes`, { method: "POST", body: { content } }); Ops.toast("内部备注已记录"); await loadSessionDetail(activeSessionId); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function downloadAttachment(button) {
    button.disabled = true;
    try { await Ops.download(button.dataset.attachmentDownload, button.dataset.attachmentFilename); }
    catch (error) { Ops.toast(error.message, "negative"); }
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

  function selectedPage() {
    return contentWorkspace?.pages?.find((item) => item.id === activePageId) || null;
  }

  function renderPageEditor() {
    const page = selectedPage();
    if (!page) return setHtml("pageEditor", Ops.emptyState("请选择一个页面", "页面字段将在这里显示。"));
    const nav = contentWorkspace.navigation.find((item) => item.href === page.slug) || {};
    const customizer = page.id === "custom-quote" ? `<div class="detail-section"><h3>灵感定制工作室</h3><div class="field"><label for="customizerSteps">步骤与选项（结构化 JSON）</label><textarea id="customizerSteps" rows="8">${Ops.escapeHtml(JSON.stringify(contentWorkspace.customizer.steps, null, 2))}</textarea></div><div class="field"><label for="customizerModels">建模插槽（GLB/GLTF 可替换）</label><textarea id="customizerModels" rows="6">${Ops.escapeHtml(JSON.stringify(contentWorkspace.customizer.modelSlots, null, 2))}</textarea></div></div>` : "";
    setHtml("pageEditor", `<div class="form-grid">
      <div class="field"><label for="pageSlug">页面地址</label><input id="pageSlug" value="${Ops.escapeHtml(page.slug)}" pattern="[a-z0-9-]+\\.html" required></div>
      <div class="field"><label for="pageStatus">状态</label><select id="pageStatus"><option value="draft" ${page.status === "draft" ? "selected" : ""}>草稿</option><option value="published" ${page.status === "published" ? "selected" : ""}>已发布</option><option value="retired" ${page.status === "retired" ? "selected" : ""}>下架</option></select></div>
      <div class="field"><label for="pageTitleZh">页面标题（中文）</label><input id="pageTitleZh" value="${Ops.escapeHtml(page.titleZh)}" required></div>
      <div class="field"><label for="pageTitleEn">Page title (English)</label><input id="pageTitleEn" value="${Ops.escapeHtml(page.titleEn)}" required></div>
      <div class="field"><label for="navLabelZh">导航名称（中文）</label><input id="navLabelZh" value="${Ops.escapeHtml(nav.labelZh || page.titleZh)}" required></div>
      <div class="field"><label for="navLabelEn">Navigation label (English)</label><input id="navLabelEn" value="${Ops.escapeHtml(nav.labelEn || page.titleEn)}" required></div>
      <div class="field field--wide"><label for="heroTitleZh">首屏标题（中文）</label><input id="heroTitleZh" value="${Ops.escapeHtml(page.hero?.titleZh || page.titleZh)}" required></div>
      <div class="field field--wide"><label for="heroTitleEn">Hero title (English)</label><input id="heroTitleEn" value="${Ops.escapeHtml(page.hero?.titleEn || page.titleEn)}" required></div>
      <div class="field field--wide"><label for="heroBodyZh">首屏说明（中文）</label><textarea id="heroBodyZh">${Ops.escapeHtml(page.hero?.bodyZh || "")}</textarea></div>
      <div class="field field--wide"><label for="heroBodyEn">Hero description (English)</label><textarea id="heroBodyEn">${Ops.escapeHtml(page.hero?.bodyEn || "")}</textarea></div>
      <div class="field field--wide"><label for="pageSections">板块、图片、文字与选项（结构化 JSON）</label><textarea id="pageSections" rows="10">${Ops.escapeHtml(JSON.stringify(page.sections || [], null, 2))}</textarea></div>
      <label class="toggle-row field--wide"><span class="toggle-copy"><strong>显示在导航栏</strong><small>下架页面会自动从导航隐藏</small></span><input id="navVisible" type="checkbox" ${nav.visible !== false && page.status !== "retired" ? "checked" : ""}></label>
    </div>${customizer}`);
  }

  function editorJson(id, label) {
    try {
      const value = JSON.parse(document.getElementById(id).value || "[]");
      if (!Array.isArray(value)) throw new Error("expected array");
      return value;
    } catch (_error) {
      throw new Error(`${label}必须是有效的 JSON 数组。`);
    }
  }

  function syncActivePageFromEditor() {
    const page = selectedPage();
    if (!page || !document.getElementById("pageSlug")) return;
    const oldSlug = page.slug;
    const previousHero = { ...(page.hero || {}) };
    page.slug = document.getElementById("pageSlug").value.trim();
    page.status = document.getElementById("pageStatus").value;
    page.titleZh = document.getElementById("pageTitleZh").value.trim();
    page.titleEn = document.getElementById("pageTitleEn").value.trim();
    page.hero = { ...page.hero, titleZh: document.getElementById("heroTitleZh").value.trim(), titleEn: document.getElementById("heroTitleEn").value.trim(), bodyZh: document.getElementById("heroBodyZh").value.trim(), bodyEn: document.getElementById("heroBodyEn").value.trim() };
    if (previousHero.titleStatus === "pending_input" && (page.hero.titleZh !== previousHero.titleZh || page.hero.titleEn !== previousHero.titleEn)) delete page.hero.titleStatus;
    if (previousHero.bodyStatus === "pending_input" && (page.hero.bodyZh !== previousHero.bodyZh || page.hero.bodyEn !== previousHero.bodyEn)) delete page.hero.bodyStatus;
    page.sections = editorJson("pageSections", "页面板块");
    let nav = contentWorkspace.navigation.find((item) => item.href === oldSlug || item.id === page.id);
    if (!nav) { nav = { id: page.id, order: contentWorkspace.navigation.length }; contentWorkspace.navigation.push(nav); }
    nav.href = page.slug;
    nav.labelZh = document.getElementById("navLabelZh").value.trim();
    nav.labelEn = document.getElementById("navLabelEn").value.trim();
    nav.visible = document.getElementById("navVisible").checked && page.status !== "retired";
    if (page.id === "custom-quote") {
      contentWorkspace.customizer.steps = editorJson("customizerSteps", "定制流程");
      contentWorkspace.customizer.modelSlots = editorJson("customizerModels", "模型插槽");
    }
  }

  function renderContent() {
    const query = document.getElementById("contentSearch").value.trim().toLowerCase();
    const status = document.getElementById("contentStatusFilter").value;
    const items = (contentWorkspace?.pages || []).filter((item) => (!query || [item.titleZh, item.titleEn, item.slug].some((value) => String(value || "").toLowerCase().includes(query))) && (!status || item.status === status));
    setHtml("contentTable", items.length ? items.map((item) => `<button class="content-page-row${item.id === activePageId ? " is-active" : ""}" type="button" data-page-id="${Ops.escapeHtml(item.id)}"><span><strong>${Ops.escapeHtml(item.titleZh)}</strong><small>${Ops.escapeHtml(item.titleEn)} · ${Ops.escapeHtml(item.slug)}</small></span><span class="row-meta">${Ops.statusBadge(item.status)}<small>${Ops.escapeHtml(item.template)}</small></span></button>`).join("") : Ops.emptyState("没有符合条件的页面", "调整搜索条件或新增模板页面。"));
    document.getElementById("workspaceRevision").textContent = contentWorkspace ? `版本 ${contentWorkspace.revision} · ${contentWorkspace.status === "published" ? "当前已发布" : "有未发布修改"}` : "等待内容服务";
    renderPageEditor();
  }

  function renderAgentChanges(items) {
    setHtml("agentChangeTable", items.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>任务</th><th>B 生成</th><th>C 审核</th><th>A 发布</th><th>风险</th><th>操作</th></tr></thead><tbody>${items.map((item) => `<tr><td><span class="cell-title">${Ops.escapeHtml(item.instruction)}</span><span class="cell-subtitle">${Ops.formatTime(item.createdAt, true)} · ${Ops.escapeHtml(item.changePaths?.length ? `${item.changePaths.length} 处受控变更` : `基于版本 ${item.baseRevision}`)}</span></td><td>${Ops.statusBadge(item.agents?.B?.status)}</td><td>${Ops.statusBadge(item.agents?.C?.status)}</td><td>${Ops.statusBadge(item.agents?.A?.status)}</td><td>${Ops.escapeHtml(item.uncertainty || item.risk)}</td><td>${item.status === "ready_for_approval" ? `<div class="table-actions"><button class="button button--secondary button--small" data-agent-reject="${Ops.escapeHtml(item.id)}" type="button">驳回</button><button class="button button--small" data-agent-approve="${Ops.escapeHtml(item.id)}" type="button">管理员批准</button></div>` : Ops.statusBadge(item.status)}</td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("尚无 Agent 修改任务", "管理员可提交修改意图并查看独立审核结果。"));
  }

  function renderContentAssets() {
    setHtml("contentAssetLibrary", contentAssets.length ? contentAssets.map((item) => {
      const available = item.status === "available";
      const kindLabel = item.kind === "model" ? "3D 模型" : "图片";
      const size = `${(Number(item.size || 0) / 1024 / 1024).toFixed(2)} MB`;
      return `<div class="asset-row"><div><strong>${Ops.escapeHtml(item.filename)}</strong><small>${Ops.escapeHtml(kindLabel)} · ${Ops.escapeHtml(item.mimeType)} · ${size}${item.validation?.validator ? ` · ${Ops.escapeHtml(item.validation.validator)}` : ""}</small></div><div class="asset-actions">${Ops.statusBadge(item.status, available ? "可用" : "已下架")}${available ? `<button class="button button--secondary button--small" type="button" data-asset-use="${Ops.escapeHtml(item.id)}">${item.kind === "model" ? "用于定制模型" : "加入当前页面"}</button><button class="button button--danger button--small" type="button" data-asset-retire="${Ops.escapeHtml(item.id)}">下架</button>` : ""}</div></div>`;
    }).join("") : Ops.emptyState("尚无素材", "上传图片或 GLB/glTF 模型后会显示在这里。"));
  }

  function publishableMedia(asset) {
    return {
      id: asset.id,
      type: asset.kind,
      filename: asset.filename,
      mimeType: asset.mimeType,
      status: "published",
      publicUrl: `/api/public/site-assets/${asset.id}`,
      thumbnailUrl: asset.kind === "image" ? `/api/public/site-assets/${asset.id}/thumbnail` : null
    };
  }

  function useContentAsset(assetId) {
    const asset = contentAssets.find((item) => item.id === assetId);
    const page = selectedPage();
    if (!asset || !page || !contentWorkspace) return;
    try { syncActivePageFromEditor(); } catch (error) { return Ops.toast(error.message, "negative"); }
    contentWorkspace.media ||= [];
    if (!contentWorkspace.media.some((item) => item.id === asset.id)) contentWorkspace.media.push(publishableMedia(asset));
    if (asset.kind === "image") {
      page.sections ||= [];
      page.sections.push({
        id: `media-${asset.id.toLowerCase()}`,
        kind: "media",
        status: "published",
        titleZh: asset.filename,
        titleEn: asset.filename,
        imageAssetId: asset.id
      });
      Ops.toast("图片已加入当前页面草稿；补充中英文说明后保存并发布");
    } else {
      const slots = contentWorkspace.customizer?.modelSlots || [];
      const target = slots.find((item) => !item.assetId) || slots[0];
      if (target) Object.assign(target, { assetId: asset.id, status: "published" });
      else slots.push({ id: `model-${asset.id.toLowerCase()}`, labelZh: asset.filename, labelEn: asset.filename, status: "published", assetId: asset.id });
      Ops.toast("模型已放入定制工作室插槽草稿");
    }
    renderContent();
  }

  async function retireContentAsset(assetId) {
    if (!window.confirm("确认下架此素材？已发布页面中的引用会在下一次内容发布后移除。")) return;
    try {
      await Ops.request(`/api/ops/content/assets/${endpointId(assetId)}`, { method: "DELETE" });
      contentWorkspace.media = (contentWorkspace.media || []).filter((item) => item.id !== assetId);
      for (const page of contentWorkspace.pages || []) page.sections = (page.sections || []).filter((item) => item.assetId !== assetId && item.imageAssetId !== assetId && item.modelAssetId !== assetId);
      for (const slot of contentWorkspace.customizer?.modelSlots || []) if (slot.assetId === assetId) Object.assign(slot, { assetId: null, status: "pending_input" });
      contentAssets = contentAssets.map((item) => item.id === assetId ? { ...item, status: "retired" } : item);
      renderContentAssets();
      renderContent();
      Ops.toast("素材已下架；请保存并发布内容草稿");
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function uploadContentAsset(input, kind) {
    const file = input.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file, file.name);
    try {
      Ops.toast(kind === "model" ? "正在验证并上传模型" : "正在清理并上传图片");
      const asset = await Ops.upload(`/api/ops/content/assets/${kind === "model" ? "models" : "images"}`, form, { timeout: 150_000 });
      contentAssets = [asset, ...contentAssets.filter((item) => item.id !== asset.id)];
      renderContentAssets();
      Ops.toast("素材上传完成，可选择加入页面或定制模型");
    } catch (error) { Ops.toast(error.message, "negative"); }
    finally { input.value = ""; }
  }

  async function loadContent() {
    Ops.setBusy(document.getElementById("contentTable"));
    try {
      const [workspace, jobs, assets] = await Promise.all([Ops.request("/api/ops/content/workspace"), Ops.request("/api/ops/agent-changes"), Ops.request("/api/ops/content/assets")]);
      contentWorkspace = workspace;
      contentItems = contentWorkspace.pages || [];
      contentAssets = Ops.list(assets);
      if (!activePageId || !contentItems.some((item) => item.id === activePageId)) activePageId = contentItems[0]?.id || null;
      renderContent();
      renderContentAssets();
      renderAgentChanges(Ops.list(jobs));
    } catch (error) { setHtml("contentTable", Ops.errorState(error, "content")); }
  }

  function createContent() {
    if (!contentWorkspace) return;
    const title = window.prompt("新页面中文名称");
    if (!title?.trim()) return;
    const base = `page-${Date.now()}`;
    contentWorkspace.pages.push({ id: base, slug: `${base}.html`, titleZh: title.trim(), titleEn: "New page", status: "draft", template: "standard", hero: { titleZh: title.trim(), titleEn: "New page", bodyZh: "待补充", bodyEn: "Pending input", bodyStatus: "pending_input" }, sections: [], seo: { titleZh: title.trim(), titleEn: "New page", descriptionZh: "待补充", descriptionEn: "Pending input", descriptionStatus: "pending_input", canonical: `${base}.html`, indexable: true } });
    contentWorkspace.navigation.push({ id: base, href: `${base}.html`, labelZh: title.trim(), labelEn: "New page", visible: false, order: contentWorkspace.navigation.length });
    activePageId = base;
    renderContent();
    Ops.toast("模板页面已加入草稿，请补充中英文内容后保存");
  }

  async function saveWorkspace() {
    try {
      syncActivePageFromEditor();
      contentWorkspace = await Ops.request("/api/ops/content/workspace", { method: "PUT", body: { workspace: contentWorkspace } });
      Ops.toast("网站内容草稿已保存");
      renderContent();
      return true;
    } catch (error) { Ops.toast(error.message, "negative"); return false; }
  }

  async function previewWorkspace() {
    if (!selectedPage()) return Ops.toast("请先选择需要预览的页面", "warning");
    if (!(await saveWorkspace())) return;
    try {
      await Ops.openHtml(`/api/ops/content/pages/${endpointId(selectedPage().slug)}/preview?locale=zh-CN`);
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function publishWorkspace() {
    try {
      if (!(await saveWorkspace())) return;
      await Ops.request("/api/ops/agent-changes", { method: "POST", body: { scope: "content", instruction: "发布管理员已保存的网站内容草稿", workspace: contentWorkspace } });
      Ops.toast("候选已通过结构校验，等待另一项明确的管理员批准操作");
      await loadContent();
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function createAgentChange() {
    const instruction = window.prompt("描述希望 Agent 修改的网站内容或规则");
    if (!instruction?.trim() || !contentWorkspace) return;
    try {
      syncActivePageFromEditor();
      await Ops.request("/api/ops/agent-changes", { method: "POST", body: { scope: activePageId === "custom-quote" ? "customizer" : "content", instruction: instruction.trim(), workspace: contentWorkspace } });
      Ops.toast("B 已生成候选，C 已完成结构审核，等待管理员批准");
      await loadContent();
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function approveAgentChange(id) {
    try { await Ops.request(`/api/ops/agent-changes/${endpointId(id)}/approve`, { method: "POST", body: {} }); Ops.toast("Agent 修改已批准并发布"); await loadContent(); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function rejectAgentChange(id) {
    const reason = window.prompt("填写驳回原因（将进入审计记录）");
    if (!reason?.trim()) return;
    try { await Ops.request(`/api/ops/agent-changes/${endpointId(id)}/reject`, { method: "POST", body: { reason: reason.trim() } }); Ops.toast("Agent 候选已驳回，不会发布到访客端"); await loadContent(); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function loadAnalytics() {
    ["analyticsMetrics", "analyticsPages", "analyticsEvents"].forEach((id) => Ops.setBusy(document.getElementById(id)));
    try {
      const data = await Ops.request("/api/admin/analytics");
      const totals = data.totals || {};
      setHtml("analyticsMetrics", [
        metricCard("页面访问", totals.pageViews, "匿名浏览"),
        metricCard("有效点击", totals.clicks, "导航与功能入口"),
        metricCard("完成定制", totals.customizerCompletions, `开始 ${totals.customizerStarts || 0}`),
        metricCard("报价提交", totals.quoteSubmissions, `开始 ${totals.quoteStarts || 0}`)
      ].join(""));
      const series = Ops.list(data.series);
      setHtml("analyticsPages", series.length ? `<div class="row-list">${series.slice(-14).reverse().map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.day)}</strong><small>当日全部有效事件</small></div><strong>${Ops.formatNumber(item.count)}</strong></div>`).join("")}</div>` : Ops.emptyState("尚无访问数据", "访客使用网站后，这里会显示匿名聚合数据。"));
      const labels = { page_view: "页面访问", navigation_click: "导航点击", cta_click: "功能入口点击", customizer_opened: "打开定制", customizer_completed: "完成定制", quote_started: "开始报价", quote_submitted: "提交报价", chat_opened: "打开客服", handoff_requested: "请求人工" };
      const events = Object.entries(data.byType || {}).sort((a, b) => b[1] - a[1]);
      setHtml("analyticsEvents", events.length ? `<div class="row-list">${events.map(([type, count]) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(labels[type] || type)}</strong><small>${Ops.escapeHtml(type)}</small></div><strong>${Ops.formatNumber(count)}</strong></div>`).join("")}</div>` : Ops.emptyState("尚无转化事件", "不会为展示生成虚假指标。"));
    } catch (error) { ["analyticsMetrics", "analyticsPages", "analyticsEvents"].forEach((id) => setHtml(id, Ops.errorState(error, "analytics"))); }
  }

  function renderSeo() {
    if (!seoState) return;
    setHtml("seoMetrics", [
      metricCard("站点健康", seoState.siteHealth?.score, seoState.siteHealth?.message),
      metricCard("搜索点击", seoState.searchPerformance?.clicks, seoState.searchPerformance?.message),
      metricCard("GEO 引用", seoState.geoVisibility?.citations, seoState.geoVisibility?.message),
      metricCard("目标问题", seoState.targetQuestions?.length || 0, `版本 ${seoState.revision}`)
    ].join(""));
    const entity = seoState.brandEntity || {};
    setHtml("seoEntityForm", `<div class="field"><label for="seoNameZh">品牌名称（中文）</label><input id="seoNameZh" value="${Ops.escapeHtml(entity.nameZh || "")}"></div><div class="field"><label for="seoNameEn">Brand name (English)</label><input id="seoNameEn" value="${Ops.escapeHtml(entity.nameEn || "")}"></div><div class="field"><label for="seoDescriptionZh">品牌事实说明（中文）</label><textarea id="seoDescriptionZh">${Ops.escapeHtml(entity.descriptionZh || "")}</textarea></div><div class="field"><label for="seoDescriptionEn">Brand facts (English)</label><textarea id="seoDescriptionEn">${Ops.escapeHtml(entity.descriptionEn || "")}</textarea></div>`);
    document.getElementById("seoQuestions").value = (seoState.targetQuestions || []).join("\n");
      setHtml("seoConnectors", `<div class="row-list">${(seoState.connectors || []).map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.name)}</strong><small>待补充：连接后才会显示真实数据</small></div>${Ops.statusBadge(item.status, item.status === "waiting_configuration" ? "待补充" : item.status)}</div>`).join("")}</div>`);
  }

  function renderSeoAgentChanges(items) {
    setHtml("seoAgentChanges", items.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>候选</th><th>结构审核</th><th>外部数据</th><th>操作</th></tr></thead><tbody>${items.map((item) => `<tr><td><span class="cell-title">${Ops.escapeHtml(item.instruction)}</span><span class="cell-subtitle">${Ops.formatTime(item.createdAt, true)} · 版本 ${Ops.escapeHtml(item.baseRevision)}</span></td><td>${Ops.statusBadge(item.agents?.C?.status)}</td><td>${Ops.escapeHtml(item.uncertainty)}</td><td>${item.status === "ready_for_approval" ? `<div class="table-actions"><button class="button button--secondary button--small" data-seo-agent-reject="${Ops.escapeHtml(item.id)}" type="button">驳回</button><button class="button button--small" data-seo-agent-approve="${Ops.escapeHtml(item.id)}" type="button">批准发布</button></div>` : Ops.statusBadge(item.status)}</td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("尚无 SEO/GEO 候选", "保存参数后提交 Agent 审核。"));
  }

  async function loadSeo() {
    ["seoMetrics", "seoEntityForm", "seoConnectors"].forEach((id) => Ops.setBusy(document.getElementById(id)));
    try { const [state, jobs] = await Promise.all([Ops.request("/api/ops/seo-geo"), Ops.request("/api/ops/seo-geo/agent-changes")]); seoState = state; renderSeo(); renderSeoAgentChanges(Ops.list(jobs)); }
    catch (error) { ["seoMetrics", "seoEntityForm", "seoConnectors"].forEach((id) => setHtml(id, Ops.errorState(error, "seo"))); }
  }

  async function saveSeo() {
    if (!seoState) return;
    const changes = {
      brandEntity: { nameZh: document.getElementById("seoNameZh").value.trim(), nameEn: document.getElementById("seoNameEn").value.trim(), descriptionZh: document.getElementById("seoDescriptionZh").value.trim(), descriptionEn: document.getElementById("seoDescriptionEn").value.trim() },
      targetQuestions: document.getElementById("seoQuestions").value.split(/\n+/).map((item) => item.trim()).filter(Boolean).slice(0, 100)
    };
    try { seoState = await Ops.request("/api/ops/seo-geo", { method: "PUT", body: { changes } }); Ops.toast("SEO/GEO 参数草稿已保存"); renderSeo(); return true; }
    catch (error) { Ops.toast(error.message, "negative"); return false; }
  }

  async function publishSeo() {
    try { if (!(await saveSeo())) return; await Ops.request("/api/ops/seo-geo/agent-changes", { method: "POST", body: { instruction: "发布已保存的 SEO/GEO 参数草稿" } }); Ops.toast("SEO/GEO 候选已生成，等待管理员明确批准"); await loadSeo(); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function seoAgentAction(id, action) {
    const body = action === "reject" ? { reason: window.prompt("填写驳回原因")?.trim() || "" } : {};
    if (action === "reject" && !body.reason) return;
    try { await Ops.request(`/api/ops/seo-geo/agent-changes/${endpointId(id)}/${action}`, { method: "POST", body }); Ops.toast(action === "approve" ? "SEO/GEO 已批准发布" : "SEO/GEO 候选已驳回"); await loadSeo(); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  function renderSchedule() {
    const schedule = scheduleState?.schedule || {};
    const duty = scheduleState?.extraDuty || {};
    document.getElementById("scheduleTimezone").textContent = `${schedule.timezone || "Asia/Shanghai"} · 管理员只读`;
    setHtml("scheduleWindows", `<div class="row-list">${(schedule.windows || []).map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.label || item.id)}</strong><small>星期 ${Ops.escapeHtml((item.days || []).join("、"))}</small></div><strong>${Ops.escapeHtml(item.start)}–${Ops.escapeHtml(item.end)}</strong></div>`).join("")}</div><div class="alert-item" data-tone="${duty.active ? "positive" : "neutral"}"><strong>${duty.active ? "我的额外值班已上线" : "当前未启动额外值班"}</strong><span>${duty.active ? "访客端会显示人工在线。" : "下班时间可主动上线，AI 始终继续正常回复。"}</span></div>`);
    const button = document.getElementById("extraDutyButton");
    button.dataset.active = String(Boolean(duty.active));
    button.textContent = duty.active ? "关闭额外值班" : "启动额外值班";
    button.classList.toggle("button--danger", Boolean(duty.active));
  }

  async function loadSchedule() {
    Ops.setBusy(document.getElementById("scheduleWindows"));
    try { scheduleState = await Ops.request("/api/admin/operator-schedule"); renderSchedule(); }
    catch (error) { setHtml("scheduleWindows", Ops.errorState(error, "schedule")); }
  }

  async function toggleExtraDuty() {
    const active = document.getElementById("extraDutyButton").dataset.active !== "true";
    try { await Ops.request("/api/admin/operator-duty", { method: "PUT", body: { active } }); Ops.toast(active ? "额外值班已上线" : "额外值班已关闭"); await loadSchedule(); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function loadProfile() {
    try {
      const [me, accounts] = await Promise.all([Ops.request("/api/ops/me"), Ops.request("/api/admin/auth/accounts")]);
      profileUser = me.user || me;
      const account = Ops.list(accounts).find((item) => item.username === profileUser.username) || {};
      document.getElementById("profileUsername").value = profileUser.username || "";
      document.getElementById("profileDisplayName").value = profileUser.name || account.displayName || "";
      document.getElementById("profileDisplayName").disabled = account.displayNameMutable === false;
      setHtml("profileSecurity", `<div class="row-list"><div class="row-item"><div class="row-main"><strong>登录方式</strong><small>使用个人账号与密码直接登录</small></div>${Ops.statusBadge("healthy", "密码登录")}</div><div class="row-item"><div class="row-main"><strong>登录保护</strong><small>错误尝试受接口频率限制并写入审计记录</small></div>${Ops.statusBadge("healthy", "已启用")}</div><div class="row-item"><div class="row-main"><strong>角色</strong><small>所有管理员平级；开发者拥有更深权限</small></div><span class="tag">${Ops.escapeHtml(account.role || profileUser.role)}</span></div></div>`);
    } catch (error) { setHtml("profileSecurity", Ops.errorState(error, "profile")); }
  }

  async function saveProfile(event) {
    event.preventDefault();
    try {
      const data = await Ops.request("/api/admin/auth/profile", { method: "PATCH", body: { displayName: document.getElementById("profileDisplayName").value.trim() } });
      document.getElementById("operatorName").textContent = data.user.displayName;
      Ops.toast("个人名称已更新");
      await loadProfile();
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  function toggleRows(items, group) {
    return items.map((item) => `<div class="toggle-row"><div class="toggle-copy"><strong>${Ops.escapeHtml(item.label || item.name)}</strong><small>${Ops.escapeHtml(item.description || "")}${item.locked ? " 此项为安全边界，不可关闭。" : ""}</small></div><label class="switch"><input type="checkbox" name="${group}:${Ops.escapeHtml(item.key)}" ${item.enabled ? "checked" : ""} ${item.locked ? "disabled" : ""} /><span aria-hidden="true"></span><span class="sr-only">启用${Ops.escapeHtml(item.label || item.name)}</span></label></div>`).join("");
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
    Ops.setBusy(document.getElementById("rulesHistory"));
    try {
      const [data, revisions] = await Promise.all([
        Ops.request("/api/ops/rules"),
        Ops.request("/api/ops/rules/revisions?limit=50")
      ]);
      rulesRevision = data.revision;
      const modes = [
        { value: "auto", label: "AI 优先", description: "常规问题自动回复，敏感事项转人工" },
        { value: "draft", label: "人工审核", description: "AI 生成草稿，由客服确认后发送" },
        { value: "observe", label: "观察模式", description: "AI 生成内部建议，由管理员核实后决定是否发送" },
        { value: "paused", label: "人工优先", description: "暂停自动回复，所有会话进入人工队列" },
      ];
      setHtml("serviceModeRules", `<div class="stack">${modes.map((mode) => `<label class="toggle-row"><span class="toggle-copy"><strong>${mode.label}</strong><small>${mode.description}</small></span><input type="radio" name="serviceMode" value="${mode.value}" ${data.mode === mode.value ? "checked" : ""} /></label>`).join("")}</div>`);
      setHtml("handoffRules", toggleRows(Ops.list(data.handoff), "handoff") || Ops.emptyState("尚未配置转人工规则"));
      document.getElementById("rulesNote").value = data.note || "";
      const history = Ops.list(revisions);
      setHtml("rulesHistory", history.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>版本</th><th>服务模式</th><th>修改人</th><th>时间</th><th>说明</th><th>操作</th></tr></thead><tbody>${history.map((item) => `<tr><td><span class="cell-title">v${Ops.escapeHtml(item.revision)}</span>${item.revision === data.revision ? '<span class="cell-subtitle">当前版本</span>' : ""}</td><td>${Ops.statusBadge(item.mode, item.mode)}</td><td>${Ops.escapeHtml(item.updatedBy || "系统初始值")}</td><td>${Ops.formatTime(item.updatedAt, true)}</td><td>${Ops.escapeHtml(item.note || "无额外说明")}</td><td>${item.revision === data.revision ? Ops.statusBadge("active", "使用中") : `<button class="button button--secondary button--small" type="button" data-rules-restore="${Ops.escapeHtml(item.revision)}">恢复此版</button>`}</td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("暂无历史版本"));
    } catch (error) {
      setHtml("serviceModeRules", Ops.errorState(error, "rules"));
      setHtml("handoffRules", Ops.errorState(error, "rules"));
      setHtml("rulesHistory", Ops.errorState(error, "rules"));
    }
  }

  async function restoreRules(revision) {
    if (!window.confirm(`确认恢复规则版本 v${revision}？系统会保留当前版本并创建一条新的恢复记录。`)) return;
    try {
      await Ops.request(`/api/ops/rules/revisions/${endpointId(revision)}/restore`, { method: "POST", body: {} });
      Ops.toast(`已恢复规则版本 v${revision}，新版本已立即生效`);
      await loadRules();
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function saveRules(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const mode = form.querySelector('input[name="serviceMode"]:checked')?.value || "auto";
    const handoff = Array.from(document.querySelectorAll('#handoffRules input[type="checkbox"]:not(:disabled)')).map((input) => ({ key: input.name.split(":")[1], enabled: input.checked }));
    try {
      await Ops.request("/api/ops/rules", { method: "PUT", body: {
        mode,
        handoff,
        note: document.getElementById("rulesNote").value,
        ...(Number.isInteger(rulesRevision) ? { expectedRevision: rulesRevision } : {})
      } });
      Ops.toast("规则已保存并立即应用");
      await loadRules();
    } catch (error) { Ops.toast(error.message, "negative"); }
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
    document.getElementById("sessionDetail").addEventListener("click", (event) => { const transfer = event.target.closest("[data-transfer-action]"); if (transfer) transferAction(transfer.dataset.transferAction, transfer.dataset.transferId); const note = event.target.closest("[data-internal-note]"); if (note) addInternalNote(note.dataset.internalNote); const attachment = event.target.closest("[data-attachment-download]"); if (attachment) downloadAttachment(attachment); const draftAction = event.target.closest("[data-ai-draft-action]"); if (draftAction) reviewAiDraft(draftAction.closest("[data-ai-draft-id]"), draftAction.dataset.aiDraftAction); });
    document.getElementById("replyForm").addEventListener("submit", sendReply);
    document.getElementById("newOrderButton").addEventListener("click", () => { document.getElementById("newOrderForm").scrollIntoView({ behavior: "smooth", block: "start" }); document.getElementById("orderCustomerPhone").focus(); });
    document.getElementById("newOrderForm").addEventListener("submit", createOrder);
    document.getElementById("orderQuoteQueue").addEventListener("click", (event) => { const button = event.target.closest("[data-order-use-quote]"); if (button) useOrderQuote(button.dataset.orderUseQuote); });
    document.getElementById("orderQuoteId").addEventListener("change", (event) => { if (event.currentTarget.value) useOrderQuote(event.currentTarget.value); });
    document.getElementById("orderTable").addEventListener("click", (event) => { const row = event.target.closest("[data-order-id]"); if (row) { activeOrderId = row.dataset.orderId; renderOrders(); } });
    document.getElementById("orderTable").addEventListener("keydown", (event) => { const row = event.target.closest("[data-order-id]"); if (row && ["Enter", " "].includes(event.key)) { event.preventDefault(); activeOrderId = row.dataset.orderId; renderOrders(); } });
    document.getElementById("orderDetail").addEventListener("click", (event) => { const customer = event.target.closest("[data-order-advance]"); const production = event.target.closest("[data-production-advance]"); if (customer) advanceOrder(customer.dataset.orderAdvance, false); if (production) advanceOrder(production.dataset.productionAdvance, true); });
    document.getElementById("importantForm").addEventListener("submit", saveImportant);
    document.getElementById("importantPreviewButton").addEventListener("click", previewImportant);
    document.getElementById("contentSearch").addEventListener("input", renderContent);
    document.getElementById("contentStatusFilter").addEventListener("change", renderContent);
    document.getElementById("newContentButton").addEventListener("click", createContent);
    document.getElementById("contentImageUpload").addEventListener("change", (event) => uploadContentAsset(event.currentTarget, "image"));
    document.getElementById("contentModelUpload").addEventListener("change", (event) => uploadContentAsset(event.currentTarget, "model"));
    document.getElementById("contentAssetLibrary").addEventListener("click", (event) => {
      const use = event.target.closest("[data-asset-use]");
      const retire = event.target.closest("[data-asset-retire]");
      if (use) useContentAsset(use.dataset.assetUse);
      if (retire) retireContentAsset(retire.dataset.assetRetire);
    });
    document.getElementById("contentTable").addEventListener("click", (event) => {
      const button = event.target.closest("[data-page-id]");
      if (!button) return;
      try { syncActivePageFromEditor(); activePageId = button.dataset.pageId; renderContent(); }
      catch (error) { Ops.toast(error.message, "negative"); }
    });
    document.getElementById("pageEditorForm").addEventListener("submit", (event) => { event.preventDefault(); saveWorkspace(); });
    document.getElementById("previewWorkspaceButton").addEventListener("click", previewWorkspace);
    document.getElementById("saveWorkspaceButton").addEventListener("click", saveWorkspace);
    document.getElementById("publishWorkspaceButton").addEventListener("click", publishWorkspace);
    document.getElementById("newAgentChangeButton").addEventListener("click", createAgentChange);
    document.getElementById("agentChangeTable").addEventListener("click", (event) => {
      const approve = event.target.closest("[data-agent-approve]");
      const reject = event.target.closest("[data-agent-reject]");
      if (approve) approveAgentChange(approve.dataset.agentApprove);
      if (reject) rejectAgentChange(reject.dataset.agentReject);
    });
    document.getElementById("saveSeoButton").addEventListener("click", saveSeo);
    document.getElementById("publishSeoButton").addEventListener("click", publishSeo);
    document.getElementById("seoAgentChanges").addEventListener("click", (event) => {
      const approve = event.target.closest("[data-seo-agent-approve]");
      const reject = event.target.closest("[data-seo-agent-reject]");
      if (approve) seoAgentAction(approve.dataset.seoAgentApprove, "approve");
      if (reject) seoAgentAction(reject.dataset.seoAgentReject, "reject");
    });
    document.getElementById("extraDutyButton").addEventListener("click", toggleExtraDuty);
    document.getElementById("profileForm").addEventListener("submit", saveProfile);
    document.getElementById("notificationsForm").addEventListener("submit", saveNotifications);
    document.getElementById("rulesForm").addEventListener("submit", saveRules);
    document.getElementById("rulesTestButton").addEventListener("click", testRules);
    document.getElementById("rulesHistory").addEventListener("click", (event) => { const button = event.target.closest("[data-rules-restore]"); if (button) restoreRules(button.dataset.rulesRestore); });
    document.getElementById("auditSearch").addEventListener("input", renderAudit);
    document.getElementById("auditActionFilter").addEventListener("change", renderAudit);
    document.getElementById("exportAuditButton").addEventListener("click", () => { window.location.href = "/api/ops/audit/export?format=csv"; });
  }

  bindEvents();
  updateAlertButton();
  shell = Ops.initShell({ defaultView: "dashboard", onView, onRetry: (view) => loaders[view]?.() });
  loadIdentity();
}());
