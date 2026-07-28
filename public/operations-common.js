(function () {
  "use strict";

  const DEFAULT_TIMEOUT_MS = 12_000;
  const statusLabels = {
    healthy: "正常", online: "在线", ready: "就绪", active: "进行中", open: "待处理",
    success: "成功", complete: "已完成", published: "已发布",
    warning: "需关注", degraded: "性能下降", pending: "待确认", queued: "排队中", draft: "草稿",
    error: "异常", offline: "离线", failed: "失败", blocked: "已阻止", paused: "已暂停",
    resolved: "已解决", closed: "已关闭", approved: "已批准", rejected: "已驳回",
  };

  class OpsApiError extends Error {
    constructor(message, options) {
      super(message);
      this.name = "OpsApiError";
      this.status = options && options.status;
      this.requestId = options && options.requestId;
      this.payload = options && options.payload;
    }
  }

  function apiUrl(path) {
    if (!String(path).startsWith("/api/")) throw new Error("Operations API path must start with /api/");
    return path;
  }

  function sessionToken() {
    try { return window.sessionStorage.getItem("qinyi-operations-token") || ""; }
    catch (_error) { return ""; }
  }

  function storeSessionToken(token) {
    try { window.sessionStorage.setItem("qinyi-operations-token", token); }
    catch (_error) { /* Private browsing can disable session storage. */ }
  }

  function clearSessionToken() {
    try { window.sessionStorage.removeItem("qinyi-operations-token"); }
    catch (_error) { /* Private browsing can disable session storage. */ }
  }

  async function logout() {
    try { await request("/api/admin/auth/session", { method: "DELETE" }); }
    catch (_error) { /* Local credentials are cleared even if the server is unreachable. */ }
    clearSessionToken();
    window.location.reload();
  }

  function showLogin() {
    if (document.getElementById("opsLoginOverlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "opsLoginOverlay";
    overlay.className = "login-overlay";
    const surface = document.body.dataset.surface === "developer" ? "developer" : "admin";
    const portal = surface === "developer" ? { title: "勤益开发者登录", subtitle: "系统、Agent 与发布治理", accounts: "developer01–developer04", switchHref: "/admin", switchLabel: "切换至管理员界面" } : { title: "勤益管理员登录", subtitle: "客服、内容与经营管理", accounts: "admin01–admin20", switchHref: "/developer", switchLabel: "切换至开发者界面" };
    overlay.innerHTML = `<form class="login-dialog" id="opsLoginForm">
      <div class="login-brand"><span class="brand-mark" aria-hidden="true">勤</span><div><strong>${portal.title}</strong><span>${portal.subtitle}</span></div><span class="login-portal-tag">${surface === "developer" ? "开发者" : "管理员"}</span></div>
      <div class="login-progress" id="opsLoginProgress"><span class="is-active">账号密码登录</span></div>
      <div class="login-account-range"><strong>个人账号</strong><span>${portal.accounts}</span><small>${surface === "developer" ? "名称固定；拥有更深层系统权限" : "20名管理员平级；登录后只能修改自己的名称"}</small></div>
      <div id="opsLoginStep"></div>
      <div class="login-error" id="opsLoginError" role="alert" hidden></div>
      <button class="button" id="opsLoginSubmit" type="submit">继续</button>
      <a class="login-switch" href="${portal.switchHref}">${portal.switchLabel}</a>
    </form>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector("form");
    const stepBox = document.getElementById("opsLoginStep");
    const errorBox = document.getElementById("opsLoginError");
    const button = document.getElementById("opsLoginSubmit");

    function enforcePortal(payload) {
      const role = payload?.user?.role;
      if (!role) return;
      if (surface === "developer" && !["developer", "system_owner"].includes(role)) throw new Error("此入口仅供开发者账号使用，请切换至管理员界面。");
      if (surface === "admin" && role === "developer") throw new Error("此账号属于开发者，请切换至开发者界面。");
    }

    function loginFields() {
      stepBox.innerHTML = `<p>使用分配给您的个人账号和密码直接登录。</p>
        <label>后台账号<input name="username" type="text" autocomplete="username" minlength="2" maxlength="40" required></label>
        <label>后台密码<input name="password" type="password" autocomplete="current-password" minlength="12" required></label>`;
      button.textContent = "登录";
      stepBox.querySelector("input").focus();
    }

    function showError(message) {
      errorBox.textContent = message || "操作失败，请重试。";
      errorBox.hidden = false;
    }

    async function authRequest(path, body) {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || "操作失败，请检查填写内容。");
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    loginFields();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      errorBox.hidden = true;
      try {
        const payload = await authRequest("/api/admin/auth/login", {
          username: form.username.value.trim(),
          password: form.password.value
        });
        enforcePortal(payload);
        if (!payload.token) throw new Error("认证服务未返回登录会话。");
        storeSessionToken(payload.token);
        window.location.reload();
      } catch (error) {
        showError(error.message || "登录失败。");
      } finally {
        button.disabled = false;
      }
    });
  }

  async function request(path, options) {
    const settings = options || {};
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), settings.timeout || DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(apiUrl(path), {
        method: settings.method || "GET",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(sessionToken() ? { Authorization: `Bearer ${sessionToken()}` } : {}),
          ...(settings.body == null ? {} : { "Content-Type": "application/json" }),
          ...(settings.headers || {}),
        },
        body: settings.body == null ? undefined : JSON.stringify(settings.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = {};
      if (text) {
        try { payload = JSON.parse(text); }
        catch (_error) { payload = { error: text }; }
      }
      if (!response.ok) {
        if (response.status === 401) showLogin();
        throw new OpsApiError(payload.error || payload.message || `请求失败（${response.status}）`, {
          status: response.status,
          requestId: payload.requestId || response.headers.get("x-request-id"),
          payload,
        });
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new OpsApiError("连接超时，请稍后重试。", { status: 0 });
      if (error instanceof OpsApiError) throw error;
      throw new OpsApiError("无法连接运营服务，请确认后台接口已启用。", { status: 0 });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function upload(path, formData, options) {
    const settings = options || {};
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), settings.timeout || 120_000);
    try {
      const response = await fetch(apiUrl(path), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(sessionToken() ? { Authorization: `Bearer ${sessionToken()}` } : {})
        },
        body: formData,
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) showLogin();
        throw new OpsApiError(payload.error || `上传失败（${response.status}）`, {
          status: response.status,
          requestId: payload.requestId,
          payload
        });
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new OpsApiError("上传超时，请检查文件大小后重试。", { status: 0 });
      if (error instanceof OpsApiError) throw error;
      throw new OpsApiError("无法连接上传服务。", { status: 0 });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function download(path, filename) {
    const response = await fetch(apiUrl(path), {
      credentials: "same-origin",
      headers: sessionToken() ? { Authorization: `Bearer ${sessionToken()}` } : {}
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) showLogin();
      throw new OpsApiError(payload.error || `下载失败（${response.status}）`, {
        status: response.status,
        requestId: payload.requestId || response.headers.get("x-request-id"),
        payload
      });
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = String(filename || "attachment");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  async function openHtml(path) {
    const preview = window.open("about:blank", "_blank");
    if (preview) preview.opener = null;
    try {
      const response = await fetch(apiUrl(path), {
        credentials: "same-origin",
        headers: {
          Accept: "text/html",
          ...(sessionToken() ? { Authorization: `Bearer ${sessionToken()}` } : {})
        }
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401) showLogin();
        throw new OpsApiError(payload.error || `预览失败（${response.status}）`, {
          status: response.status,
          requestId: payload.requestId,
          payload
        });
      }
      const objectUrl = URL.createObjectURL(new Blob([await response.text()], { type: "text/html" }));
      if (preview) preview.location.replace(objectUrl);
      else window.open(objectUrl, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      if (preview) preview.close();
      if (error instanceof OpsApiError) throw error;
      throw new OpsApiError("无法打开页面预览。", { status: 0 });
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, (token) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[token]);
  }

  function formatNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? new Intl.NumberFormat("zh-CN").format(numeric) : "待补充";
  }

  function formatTime(value, includeDate) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", includeDate
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
      : { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }

  function relativeTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const ranges = [[60, "minute"], [60, "hour"], [24, "day"], [30, "month"], [12, "year"]];
    let amount = seconds;
    let unit = "second";
    for (const [limit, nextUnit] of ranges) {
      if (Math.abs(amount) < limit) break;
      amount = Math.round(amount / limit);
      unit = nextUnit;
    }
    return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(amount, unit);
  }

  function statusTone(status) {
    const value = String(status || "unknown").toLowerCase();
    if (["healthy", "online", "ready", "active", "resolved", "approved", "closed", "success", "complete", "published"].includes(value)) return "positive";
    if (["warning", "degraded", "pending", "queued", "draft", "open"].includes(value)) return "warning";
    if (["error", "offline", "failed", "blocked", "rejected"].includes(value)) return "negative";
    return "neutral";
  }

  function statusBadge(status, label) {
    const value = String(status || "unknown").toLowerCase();
    return `<span class="status-pill" data-tone="${statusTone(value)}"><i aria-hidden="true"></i>${escapeHtml(label || statusLabels[value] || status || "未知")}</span>`;
  }

  function loadingState(message) {
    return `<div class="state-box state-box--loading" role="status"><span class="spinner" aria-hidden="true"></span><strong>${escapeHtml(message || "正在读取最新数据")}</strong></div>`;
  }

  function emptyState(title, detail) {
    return `<div class="state-box"><span class="state-symbol" aria-hidden="true">—</span><strong>${escapeHtml(title || "暂无内容")}</strong><p>${escapeHtml(detail || "这里有新内容时会自动显示。")}</p></div>`;
  }

  function errorState(error, retryAction) {
    const requestId = error && error.requestId ? `<small>请求编号：${escapeHtml(error.requestId)}</small>` : "";
    const button = retryAction ? `<button class="button button--secondary button--small" type="button" data-retry="${escapeHtml(retryAction)}">重新加载</button>` : "";
    return `<div class="state-box state-box--error" role="alert"><span class="state-symbol" aria-hidden="true">!</span><strong>数据暂时不可用</strong><p>${escapeHtml(error && error.message ? error.message : "请稍后再试。")}</p>${requestId}${button}</div>`;
  }

  function setBusy(element, message) {
    if (element) element.innerHTML = loadingState(message);
  }

  function toast(message, tone) {
    const element = document.getElementById("opsToast");
    if (!element) return;
    element.textContent = String(message);
    element.dataset.tone = tone || "positive";
    element.hidden = false;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => { element.hidden = true; }, 4200);
  }

  function setConnection(label, tone) {
    document.querySelectorAll("[data-connection]").forEach((element) => {
      element.dataset.tone = tone || "neutral";
      const text = element.querySelector("span:last-child");
      if (text) text.textContent = label;
    });
  }

  function initShell(options) {
    const settings = options || {};
    const sections = new Map(Array.from(document.querySelectorAll("[data-view]"), (section) => [section.dataset.view, section]));
    const navItems = Array.from(document.querySelectorAll("[data-nav]"));
    const defaultView = settings.defaultView || navItems[0]?.dataset.nav;

    function activate(view, pushState) {
      const target = sections.has(view) ? view : defaultView;
      sections.forEach((section, key) => { section.hidden = key !== target; });
      navItems.forEach((item) => {
        const active = item.dataset.nav === target;
        item.classList.toggle("is-active", active);
        if (active) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
      });
      const title = navItems.find((item) => item.dataset.nav === target)?.dataset.title;
      const mobileTitle = document.getElementById("mobileViewTitle");
      if (mobileTitle && title) mobileTitle.textContent = title;
      if (pushState) history.replaceState(null, "", `#${target}`);
      window.scrollTo({ top: 0, behavior: "auto" });
      if (typeof settings.onView === "function") settings.onView(target);
    }

    navItems.forEach((item) => item.addEventListener("click", () => activate(item.dataset.nav, true)));
    document.querySelectorAll("[data-logout]").forEach((button) => button.addEventListener("click", logout));
    document.addEventListener("click", (event) => {
      const retry = event.target.closest("[data-retry]");
      if (retry && typeof settings.onRetry === "function") settings.onRetry(retry.dataset.retry);
    });
    window.addEventListener("hashchange", () => activate(location.hash.slice(1), false));
    activate(location.hash.slice(1) || defaultView, false);
    return { activate };
  }

  function list(value) {
    if (Array.isArray(value)) return value;
    return Array.isArray(value && value.items) ? value.items : [];
  }

  window.QinyiOps = {
    OpsApiError, request, upload, download, openHtml, escapeHtml, formatNumber, formatTime, relativeTime, statusBadge,
    statusTone, loadingState, emptyState, errorState, setBusy, toast, setConnection,
    initShell, list, showLogin,
  };
}());
