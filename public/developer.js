(function () {
  "use strict";

  /*
   * Developer API contract (JSON, same-origin developer role required):
   * GET /api/ops/me -> {user:{name,role}}
   * GET /api/ops/developer/status -> {environment,overall,systems,metrics,incidents,changes,generatedAt}
   * GET /api/ops/developer/traces -> {items,agents}
   * GET /api/ops/developer/traces/:id -> {trace,steps,evidence,review,output}
   * GET /api/ops/developer/releases -> {items:[{id,version,environment,status,checks,revision,...}]}
   * GET /api/ops/developer/releases/:id -> {release,changes,checks,stages,rollback}
   * POST /api/ops/developer/releases/:id/approve|reject|rollback -> {status,revision}
   * GET /api/ops/developer/environment -> {environments,integrations,configuration}
   * POST /api/ops/developer/integrations/verify -> {accepted:true}
   * GET /api/ops/developer/emergency -> {metrics,actions,onCall,incidents,history}
   * POST /api/ops/developer/emergency/actions/:action -> {accepted,auditId,status}
   */

  const Ops = window.QinyiOps;
  const loaded = new Set();
  const loaders = { systems: loadSystems, traces: loadTraces, releases: loadReleases, environment: loadEnvironment, emergency: loadEmergency, analytics: loadDeveloperAnalytics, orders: loadDeveloperOrders, seo: loadDeveloperSeo, schedule: loadDeveloperSchedule };
  let currentView = "systems";
  let shell;
  let traceItems = [];
  let activeTraceId = null;
  let tracePoll = null;
  let releaseItems = [];
  let activeReleaseId = null;

  function setHtml(id, html) {
    const element = document.getElementById(id);
    if (element) element.innerHTML = html;
  }

  function endpointId(id) {
    return encodeURIComponent(String(id));
  }

  async function loadIdentity() {
    try {
      const data = await Ops.request("/api/ops/me");
      const user = data.user || data;
      document.getElementById("developerName").textContent = user.name || "值班开发者";
      document.getElementById("developerRole").textContent = user.roleLabel || user.role || "开发者";
      Ops.setConnection("控制台已连接", "positive");
    } catch (error) {
      document.getElementById("developerRole").textContent = error.status === 401 || error.status === 403 ? "需要开发者权限" : "接口待接入";
      Ops.setConnection(error.status === 401 || error.status === 403 ? "权限验证失败" : "开发接口未连接", "negative");
    }
  }

  function metricCard(label, value, unit, detail) {
    return `<article class="metric"><div><div class="metric-label">${Ops.escapeHtml(label)}</div><div class="metric-value">${Ops.escapeHtml(value == null ? "待补充" : value)}${unit ? `<small>${Ops.escapeHtml(unit)}</small>` : ""}</div></div><div class="metric-foot"><span>${Ops.escapeHtml(detail || "")}</span></div></article>`;
  }

  function systemCard(item) {
    const tone = Ops.statusTone(item.status);
    const progress = Number.isFinite(Number(item.capacityPercent)) ? Math.max(0, Math.min(100, Number(item.capacityPercent))) : 0;
    const primaryValue = item.primaryValue || item.value || item.latencyMs || "--";
    return `<article class="system-card" data-tone="${tone}"><div class="system-card-head"><h2>${Ops.escapeHtml(item.name || item.id || "系统")}</h2>${Ops.statusBadge(item.status, item.statusLabel)}</div><div class="system-card-value">${Ops.escapeHtml(primaryValue)}${item.latencyMs && !item.primaryValue && !item.value ? " ms" : ""}</div><p>${Ops.escapeHtml(item.detail || item.description || "暂无补充说明")}</p><progress class="system-progress" value="${progress}" max="100" aria-label="容量使用 ${progress}%"></progress></article>`;
  }

  async function loadDeveloperOrders() {
    ["developerOrderMetrics", "developerCustomerStages", "developerProductionStages"].forEach((id) => Ops.setBusy(document.getElementById(id)));
    try {
      const data = await Ops.request("/api/developer/order-system");
      setHtml("developerOrderMetrics", `${metricCard("全部订单", data.orders?.total, "", "持久化记录")}${metricCard("进行中", data.orders?.active, "", "当前")}${metricCard("短信登录", data.sms?.configured ? "已配置" : "待补充", "", data.sms?.provider || "")}`);
      const rows = (items) => `<div class="row-list">${Ops.list(items).map((item) => `<div class="row-item"><div class="row-main"><strong>${item.index + 1}. ${Ops.escapeHtml(item.labelZh)}</strong><small>${Ops.escapeHtml(item.labelEn)} · ${Ops.escapeHtml(item.id)}</small></div>${Ops.statusBadge("healthy", "固定")}</div>`).join("")}</div>`;
      setHtml("developerCustomerStages", rows(data.customerStages));
      setHtml("developerProductionStages", rows(data.productionStages));
      document.getElementById("developerOrderSettingsJson").value = JSON.stringify(data.settings || { customerVisibleProduction: true, customerStageSlaDays: {}, productionStageSlaHours: {} }, null, 2);
    } catch (error) { ["developerOrderMetrics", "developerCustomerStages", "developerProductionStages"].forEach((id) => setHtml(id, Ops.errorState(error, "orders"))); }
  }

  async function saveOrderSettings() {
    try {
      const value = JSON.parse(document.getElementById("developerOrderSettingsJson").value);
      await Ops.request("/api/developer/order-system/settings", { method: "PUT", body: value });
      Ops.toast("订单系统参数已更新");
      await loadDeveloperOrders();
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function loadSystems() {
    ["systemCards", "systemMetrics", "incidents", "changesTable"].forEach((id) => Ops.setBusy(document.getElementById(id)));
    try {
      const data = await Ops.request("/api/ops/developer/status");
      const systems = Ops.list(data.systems);
      setHtml("systemCards", systems.length ? systems.slice(0, 4).map(systemCard).join("") : Ops.emptyState("暂无系统状态", "接口应返回入口、对话、Agent 与数据四个系统。"));
      document.getElementById("environmentBadge").innerHTML = `<span class="tag tag--blue">${Ops.escapeHtml(data.environment || "环境未知")}</span>`;
      document.getElementById("overallStatus").innerHTML = Ops.statusBadge(data.overall?.status || data.overall || "unknown", data.overall?.label);
      const metrics = data.metrics || {};
      setHtml("systemMetrics", `<div class="metric-grid">${metricCard("活跃会话", metrics.activeSessions, "", "当前打开")}${metricCard("人工队列", metrics.humanQueue, "", "等待处理")}${metricCard("累计会话", metrics.conversations, "", "本地运营数据")}${metricCard("待处理通知", metrics.pendingNotifications, "", "当前待办")}</div>`);
      const incidents = Ops.list(data.incidents);
      setHtml("incidents", incidents.length ? incidents.map((item) => `<div class="alert-item" data-tone="${Ops.statusTone(item.severity || item.status)}"><strong>${Ops.escapeHtml(item.title || "服务事件")}</strong><span>${Ops.escapeHtml(item.detail || item.summary || "")} · ${Ops.relativeTime(item.startedAt || item.updatedAt)}</span></div>`).join("") : Ops.emptyState("没有未恢复事件", "系统异常与性能下降会显示在这里。"));
      const changes = Ops.list(data.changes);
      setHtml("changesTable", changes.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>类型</th><th>版本 / 对象</th><th>执行人</th><th>结果</th></tr></thead><tbody>${changes.slice(0, 12).map((item) => `<tr><td>${Ops.formatTime(item.createdAt, true)}</td><td>${Ops.escapeHtml(item.typeLabel || item.type || "变更")}</td><td><span class="cell-title">${Ops.escapeHtml(item.name || item.version || "--")}</span><span class="cell-subtitle">${Ops.escapeHtml(item.summary || "")}</span></td><td>${Ops.escapeHtml(item.actor || "自动化")}</td><td>${Ops.statusBadge(item.status || item.result, item.statusLabel)}</td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("暂无近期变化", "部署和配置变更会记录在这里。"));
      Ops.setConnection(`状态更新于 ${Ops.formatTime(data.generatedAt)}`, "positive");
    } catch (error) {
      ["systemCards", "systemMetrics", "incidents", "changesTable"].forEach((id) => setHtml(id, Ops.errorState(error, "systems")));
      Ops.setConnection("系统状态不可用", "negative");
    }
  }

  function filteredTraces() {
    const query = document.getElementById("traceSearch").value.trim().toLowerCase();
    const status = document.getElementById("traceStatusFilter").value;
    const agent = document.getElementById("traceAgentFilter").value;
    return traceItems.filter((item) => {
      const haystack = [item.id, item.requestId, item.sessionId, item.summary].join(" ").toLowerCase();
      const agents = Array.isArray(item.agents) ? item.agents : [];
      return (!query || haystack.includes(query)) && (!status || item.status === status) && (!agent || agents.includes(agent));
    });
  }

  function renderTraceList() {
    const items = filteredTraces();
    setHtml("traceList", items.length ? `<div class="row-list">${items.map((item) => `<button class="session-item${String(item.id) === String(activeTraceId) ? " is-active" : ""}" type="button" data-trace-id="${Ops.escapeHtml(item.id)}"><span class="session-item-head"><span class="session-item-name">${Ops.escapeHtml(item.requestId || item.id)}</span><time class="session-item-time">${Ops.relativeTime(item.startedAt)}</time></span><span class="session-item-preview">${Ops.escapeHtml(item.summary || "请求内容已脱敏")}</span><span class="session-item-foot">${Ops.statusBadge(item.status, item.statusLabel)}<span class="tag">${Ops.escapeHtml(item.durationMs == null ? "--" : `${item.durationMs} ms`)}</span></span></button>`).join("")}</div>` : Ops.emptyState("没有符合条件的追踪", "调整筛选条件或等待新的请求。"));
  }

  async function loadTraces(silent) {
    if (!silent) Ops.setBusy(document.getElementById("traceList"), "正在读取 Agent 请求");
    try {
      const data = await Ops.request("/api/ops/developer/traces?limit=80");
      traceItems = Ops.list(data);
      const agents = Ops.list(data.agents);
      const select = document.getElementById("traceAgentFilter");
      const current = select.value;
      select.innerHTML = `<option value="">全部 Agent</option>${agents.map((item) => `<option value="${Ops.escapeHtml(item.id || item)}">${Ops.escapeHtml(item.name || item.id || item)}</option>`).join("")}`;
      select.value = current;
      renderTraceList();
      if (activeTraceId && !silent) await loadTraceDetail(activeTraceId);
    } catch (error) { if (!silent) setHtml("traceList", Ops.errorState(error, "traces")); }
  }

  async function loadTraceDetail(id) {
    activeTraceId = String(id);
    renderTraceList();
    Ops.setBusy(document.getElementById("traceDetail"), "正在读取执行链路");
    try {
      const data = await Ops.request(`/api/ops/developer/traces/${endpointId(id)}`);
      const trace = data.trace || {};
      setHtml("traceDetailHeader", `<div class="panel-title"><h2>${Ops.escapeHtml(trace.requestId || id)}</h2><p>${Ops.formatTime(trace.startedAt, true)} · ${Ops.escapeHtml(trace.environment || "环境未知")}</p></div>${Ops.statusBadge(trace.status, trace.statusLabel)}`);
      const steps = Ops.list(data.steps);
      const timeline = steps.length ? `<div class="trace-timeline">${steps.map((step, index) => `<div class="trace-step"><span class="trace-dot">${index + 1}</span><div class="trace-copy"><strong>${Ops.escapeHtml(step.agentName || step.name || step.agent || "处理阶段")}</strong><span>${Ops.escapeHtml(step.summary || step.action || "已完成")}</span></div><span class="trace-duration">${Ops.escapeHtml(step.durationMs == null ? "--" : `${step.durationMs} ms`)}</span></div>`).join("")}</div>` : Ops.emptyState("没有阶段记录");
      const evidence = Ops.list(data.evidence);
      const review = data.review || {};
      setHtml("traceDetail", `<div class="dashboard-grid dashboard-grid--equal"><section><div class="panel-title"><h3>执行链路</h3><p>Agent 分工与耗时</p></div>${timeline}</section><section><div class="panel-title"><h3>审核结果</h3><p>风险与证据充分性</p></div><div class="row-list"><div class="row-item"><div class="row-main"><strong>证据状态</strong><small>${Ops.escapeHtml(review.evidenceSummary || "未返回说明")}</small></div>${Ops.statusBadge(review.evidenceStatus || "unknown")}</div><div class="row-item"><div class="row-main"><strong>风险状态</strong><small>${Ops.escapeHtml(review.riskSummary || "未返回说明")}</small></div>${Ops.statusBadge(review.riskStatus || "unknown")}</div><div class="row-item"><div class="row-main"><strong>最终决策</strong><small>${Ops.escapeHtml(review.decisionReason || "未返回说明")}</small></div>${Ops.statusBadge(review.decision || trace.status, review.decisionLabel)}</div></div></section></div><section class="detail-section"><h3>引用证据</h3>${evidence.length ? `<div class="row-list">${evidence.map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.title || item.source || "证据")}</strong><small>${Ops.escapeHtml(item.location || item.snippet || "")}</small></div><span class="tag">${Ops.escapeHtml(item.score == null ? "已引用" : `相关度 ${item.score}`)}</span></div>`).join("")}</div>` : Ops.emptyState("没有引用证据")}</section><section><h3>脱敏输出</h3><pre class="code-block">${Ops.escapeHtml(data.output?.redacted || data.output?.summary || "未保留输出预览")}</pre></section>`);
    } catch (error) { setHtml("traceDetail", Ops.errorState(error)); }
  }

  function renderReleaseTable() {
    setHtml("releaseTable", releaseItems.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>版本</th><th>目标环境</th><th>变更</th><th>检查</th><th>状态</th><th>提交时间</th></tr></thead><tbody>${releaseItems.map((item) => `<tr data-release-id="${Ops.escapeHtml(item.id)}" tabindex="0"><td><span class="cell-title">${Ops.escapeHtml(item.version || item.id)}</span><span class="cell-subtitle">${Ops.escapeHtml(item.commit || "")}</span></td><td>${Ops.escapeHtml(item.environment || "--")}</td><td>${Ops.escapeHtml(item.summary || "--")}</td><td>${Ops.statusBadge(item.checks?.status || item.checkStatus || "pending", item.checks?.label)}</td><td>${Ops.statusBadge(item.status, item.statusLabel)}</td><td>${Ops.relativeTime(item.createdAt)}</td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("没有待处理发布", "新的发布申请会显示在这里。"));
  }

  async function loadReleases() {
    Ops.setBusy(document.getElementById("releaseTable"), "正在读取发布队列");
    Ops.setBusy(document.getElementById("managedVersionTable"), "正在读取内容版本");
    try {
      const [data, contentVersions, seoVersions] = await Promise.all([
        Ops.request("/api/ops/developer/releases?limit=60"),
        Ops.request("/api/ops/content/versions"),
        Ops.request("/api/ops/seo-geo/versions")
      ]);
      releaseItems = Ops.list(data);
      renderReleaseTable();
      const pending = releaseItems.filter((item) => item.status === "pending").length;
      document.getElementById("releaseQueueStatus").innerHTML = Ops.statusBadge(pending ? "pending" : "healthy", pending ? `${pending} 个待审批` : "队列已清空");
      const managedVersions = [
        ...Ops.list(contentVersions).map((item) => ({ ...item, kind: "content", label: "网站内容" })),
        ...Ops.list(seoVersions).map((item) => ({ ...item, kind: "seo", label: "SEO/GEO" }))
      ].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      setHtml("managedVersionTable", managedVersions.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>范围</th><th>版本</th><th>来源</th><th>发布人</th><th>时间</th><th>操作</th></tr></thead><tbody>${managedVersions.map((item) => `<tr><td>${Ops.escapeHtml(item.label)}</td><td><span class="cell-title">${Ops.escapeHtml(item.id)}</span><span class="cell-subtitle">业务版本 ${Ops.escapeHtml(item.revision)}</span></td><td>${Ops.escapeHtml(item.source || "manual_publish")}</td><td>${Ops.escapeHtml(item.actor || "system")}</td><td>${Ops.formatTime(item.createdAt, true)}</td><td><button class="button button--danger button--small" type="button" data-managed-version-kind="${item.kind}" data-managed-version-id="${Ops.escapeHtml(item.id)}">回滚到此版本</button></td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("尚无 CMS 或 SEO/GEO 发布版本", "管理员批准首个候选后会形成回滚点。"));
    } catch (error) { setHtml("releaseTable", Ops.errorState(error, "releases")); setHtml("managedVersionTable", Ops.errorState(error, "managed-versions")); }
  }

  async function rollbackManagedVersion(kind, versionId) {
    if (!window.confirm("确认回滚到此版本？系统会保留当前历史，并创建一个新的发布版本。")) return;
    const path = kind === "seo" ? `/api/ops/seo-geo/versions/${endpointId(versionId)}/rollback` : `/api/ops/content/versions/${endpointId(versionId)}/rollback`;
    try { await Ops.request(path, { method: "POST", body: {} }); Ops.toast("回滚完成，新的审计版本已生成"); await loadReleases(); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function loadReleaseDetail(id) {
    activeReleaseId = String(id);
    Ops.setBusy(document.getElementById("releaseDetail"), "正在读取发布详情");
    try {
      const data = await Ops.request(`/api/ops/developer/releases/${endpointId(id)}`);
      const release = data.release || {};
      const stages = Ops.list(data.stages);
      const changes = Ops.list(data.changes);
      const checks = Ops.list(data.checks);
      setHtml("releaseDetailHeader", `<div class="panel-title"><h2>${Ops.escapeHtml(release.version || id)}</h2><p>${Ops.escapeHtml(release.summary || "发布详情")}</p></div>${Ops.statusBadge(release.status, release.statusLabel)}`);
      setHtml("releaseDetail", `<div class="release-flow">${stages.map((stage) => `<div class="release-stage${["complete", "approved", "active"].includes(stage.status) ? " is-complete" : ""}">${Ops.escapeHtml(stage.label || stage.name)}</div>`).join("")}</div><div class="dashboard-grid dashboard-grid--equal"><section><h3>变更内容</h3>${changes.length ? `<div class="row-list">${changes.map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.title || item.path || "变更")}</strong><small>${Ops.escapeHtml(item.summary || "")}</small></div><span class="tag">${Ops.escapeHtml(item.type || "修改")}</span></div>`).join("")}</div>` : Ops.emptyState("没有变更摘要")}</section><section><h3>发布检查</h3>${checks.length ? `<div class="row-list">${checks.map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.name || "检查")}</strong><small>${Ops.escapeHtml(item.detail || "")}</small></div>${Ops.statusBadge(item.status, item.statusLabel)}</div>`).join("")}</div>` : Ops.emptyState("没有检查结果")}</section></div><div class="form-actions">${release.status === "pending" ? `<button class="button button--secondary" type="button" data-release-action="reject">驳回</button><button class="button" type="button" data-release-action="approve">批准发布</button>` : ""}${release.rollback?.available || data.rollback?.available ? `<button class="button button--danger" type="button" data-release-action="rollback">回滚此版本</button>` : ""}</div>`);
    } catch (error) { setHtml("releaseDetail", Ops.errorState(error)); }
  }

  async function releaseAction(action) {
    if (!activeReleaseId) return;
    const reason = action === "approve" ? window.prompt("审批说明（可选）", "检查通过") : window.prompt(action === "reject" ? "请输入驳回原因" : "请输入回滚原因");
    if (action !== "approve" && (!reason || !reason.trim())) return;
    if (action === "rollback" && !window.confirm("确认回滚此版本？服务可能短暂重启，操作将写入审计记录。")) return;
    const release = releaseItems.find((item) => String(item.id) === activeReleaseId);
    try {
      await Ops.request(`/api/ops/developer/releases/${endpointId(activeReleaseId)}/${action}`, { method: "POST", body: { reason: reason || "", expectedRevision: release?.revision } });
      Ops.toast(action === "approve" ? "发布已批准" : action === "reject" ? "发布已驳回" : "回滚已提交");
      await Promise.all([loadReleases(), loadReleaseDetail(activeReleaseId)]);
    } catch (error) { Ops.toast(error.status === 409 ? "版本已变化，请刷新后重新审批。" : error.message, "negative"); }
  }

  function rows(items, emptyTitle) {
    return items.length ? `<div class="row-list">${items.map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.name || item.label || item.id || "项目")}</strong><small>${Ops.escapeHtml(item.detail || item.version || item.endpoint || "")}</small></div><div class="row-meta">${Ops.statusBadge(item.status || (item.configured === false ? "warning" : "healthy"), item.statusLabel || (item.configured === false ? "未配置" : undefined))}<small>${item.checkedAt ? Ops.relativeTime(item.checkedAt) : ""}</small></div></div>`).join("")}</div>` : Ops.emptyState(emptyTitle || "暂无数据");
  }

  async function loadEnvironment() {
    ["environmentList", "integrationList", "configurationTable"].forEach((id) => Ops.setBusy(document.getElementById(id)));
    try {
      const data = await Ops.request("/api/ops/developer/environment");
      setHtml("environmentList", rows(Ops.list(data.environments), "暂无环境信息"));
      setHtml("integrationList", rows(Ops.list(data.integrations), "暂无集成信息"));
      const config = Ops.list(data.configuration);
      setHtml("configurationTable", config.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>配置项</th><th>环境</th><th>状态</th><th>最后验证</th><th>说明</th></tr></thead><tbody>${config.map((item) => `<tr><td>${Ops.escapeHtml(item.name || item.key)}</td><td>${Ops.escapeHtml(item.environment || "全部")}</td><td>${Ops.statusBadge(item.configured === false ? "warning" : item.status || "healthy", item.configured === false ? "未配置" : item.statusLabel)}</td><td>${Ops.relativeTime(item.checkedAt)}</td><td>${Ops.escapeHtml(item.detail || "密钥值不会在此显示")}</td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("暂无配置检查结果"));
    } catch (error) { ["environmentList", "integrationList", "configurationTable"].forEach((id) => setHtml(id, Ops.errorState(error, "environment"))); }
  }

  async function verifyIntegrations() {
    try { await Ops.request("/api/ops/developer/integrations/verify", { method: "POST", body: {} }); Ops.toast("验证任务已启动"); window.setTimeout(loadEnvironment, 1200); }
    catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function loadDeveloperAnalytics() {
    ["developerAnalyticsMetrics", "developerAnalyticsPolicy"].forEach((id) => Ops.setBusy(document.getElementById(id)));
    try {
      const data = await Ops.request("/api/developer/analytics");
      const traffic = data.traffic || {};
      setHtml("developerAnalyticsMetrics", `${metricCard("页面访问", traffic.pageViews, "", "匿名聚合")}${metricCard("有效点击", traffic.clicks, "", "导航与入口")}${metricCard("事件总量", traffic.totalMeaningfulEvents, "", "白名单事件")}${metricCard("原始保留", data.rawEventCount, "条", "90天")}`);
      setHtml("developerAnalyticsPolicy", `<div class="row-list"><div class="row-item"><div class="row-main"><strong>原始事件</strong><small>自动清理期限</small></div><strong>${data.rawRetentionDays} 天</strong></div><div class="row-item"><div class="row-main"><strong>聚合指标</strong><small>用于经营趋势</small></div><strong>${data.aggregateRetentionMonths} 个月</strong></div><div class="row-item"><div class="row-main"><strong>隐私边界</strong><small>原始 IP、聊天正文、表单正文</small></div>${Ops.statusBadge("healthy", "不保存")}</div></div>`);
    } catch (error) { ["developerAnalyticsMetrics", "developerAnalyticsPolicy"].forEach((id) => setHtml(id, Ops.errorState(error, "analytics"))); }
  }

  async function loadDeveloperSeo() {
    ["developerSeoMetrics", "developerSeoDetail"].forEach((id) => Ops.setBusy(document.getElementById(id)));
    try {
      const data = await Ops.request("/api/ops/developer/seo-geo");
      setHtml("developerSeoMetrics", `${metricCard("SEO健康", data.siteHealth?.score, "", data.siteHealth?.message)}${metricCard("搜索点击", data.searchPerformance?.clicks, "", data.searchPerformance?.message)}${metricCard("GEO引用", data.geoVisibility?.citations, "", data.geoVisibility?.message)}${metricCard("版本", data.revision, "", data.status)}`);
      setHtml("developerSeoDetail", `<div class="row-list">${(data.connectors || []).map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.name)}</strong><small>${item.status === "waiting_configuration" ? "待补充" : Ops.escapeHtml(item.status)}</small></div>${Ops.statusBadge(item.status, item.status === "waiting_configuration" ? "待补充" : item.status)}</div>`).join("")}</div><p class="cell-subtitle">技术输出：${Object.entries(data.technical || {}).filter(([, value]) => value).map(([key]) => key).join("、") || "待补充"}</p>`);
    } catch (error) { ["developerSeoMetrics", "developerSeoDetail"].forEach((id) => setHtml(id, Ops.errorState(error, "seo"))); }
  }

  async function loadDeveloperSchedule() {
    Ops.setBusy(document.getElementById("developerScheduleJson"));
    try { const data = await Ops.request("/api/developer/operator-schedule"); document.getElementById("developerScheduleJson").value = JSON.stringify(data.schedule || data, null, 2); }
    catch (error) { document.getElementById("developerScheduleJson").value = error.message; }
  }

  async function saveDeveloperSchedule() {
    try {
      const value = JSON.parse(document.getElementById("developerScheduleJson").value);
      await Ops.request("/api/developer/operator-schedule", { method: "PUT", body: value });
      Ops.toast("全站人工排班已更新");
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  async function loadEmergency() {
    ["emergencyMetrics", "emergencyActions", "onCallDetail", "emergencyHistory"].forEach((id) => Ops.setBusy(document.getElementById(id)));
    try {
      const data = await Ops.request("/api/ops/developer/emergency");
      const metrics = data.metrics || {};
      setHtml("emergencyMetrics", `${metricCard("未恢复事件", metrics.openIncidents, "", "当前")}${metricCard("错误率", metrics.errorRate, "%", metrics.errorRate == null ? "监控未接入" : "最近 5 分钟")}${metricCard("P95 响应", metrics.p95LatencyMs, " ms", metrics.p95LatencyMs == null ? "监控未接入" : "最近 5 分钟")}${metricCard("人工队列", metrics.humanQueue, "", "等待处理")}`);
      const actions = Ops.list(data.actions);
      setHtml("emergencyActions", actions.length ? actions.map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.label || item.name)}</strong><small>${Ops.escapeHtml(item.description || "操作将被审计")}</small></div><button class="button ${item.risk === "high" ? "button--danger" : "button--secondary"} button--small" type="button" data-emergency-action="${Ops.escapeHtml(item.key)}" data-risk="${Ops.escapeHtml(item.risk || "low")}">${Ops.escapeHtml(item.buttonLabel || "执行")}</button></div>`).join("") : Ops.emptyState("没有可用的应急操作", "接口应返回当前角色允许执行的操作。"));
      const onCall = data.onCall || {};
      const incidents = Ops.list(data.incidents);
      document.getElementById("onCallStatus").innerHTML = Ops.statusBadge(onCall.status || "unknown", onCall.statusLabel || "值班状态");
      setHtml("onCallDetail", `<div class="detail-section"><h3>当前值班</h3><dl class="detail-list"><div><dt>负责人</dt><dd>${Ops.escapeHtml(onCall.name || "未安排")}</dd></div><div><dt>班次</dt><dd>${Ops.escapeHtml(onCall.shift || "--")}</dd></div><div><dt>联系方式</dt><dd>${Ops.escapeHtml(onCall.contactMasked || "未提供")}</dd></div></dl></div><div class="detail-section"><h3>未关闭事件</h3>${incidents.length ? `<div class="row-list">${incidents.map((item) => `<div class="row-item"><div class="row-main"><strong>${Ops.escapeHtml(item.title || item.id)}</strong><small>${Ops.escapeHtml(item.summary || "")} · ${Ops.relativeTime(item.startedAt)}</small></div>${Ops.statusBadge(item.status || item.severity)}</div>`).join("")}</div>` : Ops.emptyState("当前无事件")}</div>`);
      const history = Ops.list(data.history);
      setHtml("emergencyHistory", history.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>操作</th><th>执行人</th><th>原因</th><th>结果</th></tr></thead><tbody>${history.map((item) => `<tr><td>${Ops.formatTime(item.createdAt, true)}</td><td>${Ops.escapeHtml(item.actionLabel || item.action)}</td><td>${Ops.escapeHtml(item.actor || "--")}</td><td>${Ops.escapeHtml(item.reason || "--")}</td><td>${Ops.statusBadge(item.status || item.result, item.statusLabel)}</td></tr>`).join("")}</tbody></table></div>` : Ops.emptyState("暂无应急操作记录"));
    } catch (error) { ["emergencyMetrics", "emergencyActions", "onCallDetail", "emergencyHistory"].forEach((id) => setHtml(id, Ops.errorState(error, "emergency"))); }
  }

  async function emergencyAction(action, risk) {
    const reason = window.prompt("请输入执行原因（必填）");
    if (!reason || !reason.trim()) return;
    if (risk === "high" && !window.confirm("这是高风险操作。确认立即执行并写入审计记录？")) return;
    try {
      await Ops.request(`/api/ops/developer/emergency/actions/${endpointId(action)}`, { method: "POST", body: { reason: reason.trim(), confirmed: risk === "high" } });
      Ops.toast("应急操作已提交");
      await loadEmergency();
    } catch (error) { Ops.toast(error.message, "negative"); }
  }

  function onView(view) {
    currentView = view;
    if (view === "traces" && document.getElementById("liveTraceToggle").getAttribute("aria-pressed") === "true") {
      window.clearInterval(tracePoll);
      tracePoll = window.setInterval(() => loadTraces(true), 10_000);
    } else window.clearInterval(tracePoll);
    if (!loaded.has(view)) { loaded.add(view); loaders[view](); }
  }

  function bindEvents() {
    document.querySelector("[data-refresh-current]").addEventListener("click", () => loaders[currentView]());
    document.getElementById("traceSearch").addEventListener("input", renderTraceList);
    document.getElementById("traceStatusFilter").addEventListener("change", renderTraceList);
    document.getElementById("traceAgentFilter").addEventListener("change", renderTraceList);
    document.getElementById("traceList").addEventListener("click", (event) => { const item = event.target.closest("[data-trace-id]"); if (item) loadTraceDetail(item.dataset.traceId); });
    document.getElementById("liveTraceToggle").addEventListener("click", (event) => {
      const enabled = event.currentTarget.getAttribute("aria-pressed") !== "true";
      event.currentTarget.setAttribute("aria-pressed", String(enabled));
      event.currentTarget.textContent = `实时刷新：${enabled ? "开" : "关"}`;
      if (enabled && currentView === "traces") tracePoll = window.setInterval(() => loadTraces(true), 10_000);
      else window.clearInterval(tracePoll);
    });
    document.getElementById("releaseTable").addEventListener("click", (event) => { const row = event.target.closest("[data-release-id]"); if (row) loadReleaseDetail(row.dataset.releaseId); });
    document.getElementById("releaseTable").addEventListener("keydown", (event) => { const row = event.target.closest("[data-release-id]"); if (row && ["Enter", " "].includes(event.key)) { event.preventDefault(); loadReleaseDetail(row.dataset.releaseId); } });
    document.getElementById("releaseDetail").addEventListener("click", (event) => { const button = event.target.closest("[data-release-action]"); if (button) releaseAction(button.dataset.releaseAction); });
    document.getElementById("managedVersionTable").addEventListener("click", (event) => { const button = event.target.closest("[data-managed-version-id]"); if (button) rollbackManagedVersion(button.dataset.managedVersionKind, button.dataset.managedVersionId); });
    document.getElementById("verifyIntegrationsButton").addEventListener("click", verifyIntegrations);
    document.getElementById("emergencyActions").addEventListener("click", (event) => { const button = event.target.closest("[data-emergency-action]"); if (button) emergencyAction(button.dataset.emergencyAction, button.dataset.risk); });
    document.getElementById("saveDeveloperSchedule").addEventListener("click", saveDeveloperSchedule);
    document.getElementById("saveOrderSettings").addEventListener("click", saveOrderSettings);
  }

  bindEvents();
  shell = Ops.initShell({ defaultView: "systems", onView, onRetry: (view) => loaders[view]?.() });
  loadIdentity();
}());
