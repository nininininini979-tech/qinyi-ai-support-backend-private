(function () {
  "use strict";

  const REQUEST_TIMEOUT_MS = 45_000;
  const runtimeConfig = window.__QINYI_SUPPORT_CONFIG__ || {};
  const API_BASE_URL = typeof runtimeConfig.apiBaseUrl === "string"
    ? runtimeConfig.apiBaseUrl.trim().replace(/\/+$/, "")
    : "";

  function apiUrl(path) {
    return `${API_BASE_URL}${path}`;
  }

  function storageRead(storage, key) {
    try {
      return storage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function storageWrite(storage, key, value) {
    try {
      if (value == null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch (_error) {
      // Storage can be unavailable in privacy-focused browser modes.
    }
  }

  function fallbackUuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (token) {
      const random = Math.floor(Math.random() * 16);
      const value = token === "x" ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  }

  function visitorId() {
    const key = "qinyi-support-client-id";
    const existing = storageRead(window.localStorage, key);
    if (existing) return existing;
    const generated = window.crypto && typeof window.crypto.randomUUID === "function"
      ? window.crypto.randomUUID()
      : fallbackUuid();
    storageWrite(window.localStorage, key, generated);
    return generated;
  }

  const API_HEADERS = {
    "Content-Type": "application/json",
    "X-Client-Id": visitorId(),
    "X-Demo-User-Id": "demo-user-1",
    "X-Tenant-Id": "demo-tenant",
  };

  const state = {
    sessionId: storageRead(window.sessionStorage, "qinyi-support-session-id"),
    pending: false,
    controller: null,
    lastFailedMessage: null,
    toastTimer: null,
  };

  const elements = {
    chatForm: document.getElementById("chatForm"),
    messageInput: document.getElementById("messageInput"),
    sendButton: document.getElementById("sendButton"),
    messages: document.getElementById("messages"),
    emptyState: document.getElementById("emptyState"),
    newConversationButton: document.getElementById("newConversationButton"),
    sessionState: document.getElementById("sessionState"),
    serviceMode: document.getElementById("serviceMode"),
    headerStatus: document.getElementById("headerStatus"),
    headerStatusText: document.getElementById("headerStatusText"),
    mobileStatusText: document.getElementById("mobileStatusText"),
    sidebarStatusBadge: document.getElementById("sidebarStatusBadge"),
    serviceStatusTitle: document.getElementById("serviceStatusTitle"),
    serviceStatusDetail: document.getElementById("serviceStatusDetail"),
    errorBanner: document.getElementById("errorBanner"),
    errorTitle: document.getElementById("errorTitle"),
    errorMessage: document.getElementById("errorMessage"),
    retryButton: document.getElementById("retryButton"),
    dismissErrorButton: document.getElementById("dismissErrorButton"),
    toast: document.getElementById("toast"),
  };

  function setText(element, value) {
    element.textContent = value == null ? "" : String(value);
  }

  function updateSendButton() {
    elements.sendButton.disabled = state.pending || !elements.messageInput.value.trim();
  }

  function resizeComposer() {
    elements.messageInput.style.height = "auto";
    elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 120)}px`;
  }

  function scrollToLatest() {
    window.requestAnimationFrame(function () {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  }

  function formatTime() {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  }

  function createMessage(role, text, responseData) {
    const article = document.createElement("article");
    article.className = `message message--${role}`;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    setText(avatar, role === "user" ? "我" : "客服");

    const content = document.createElement("div");
    content.className = "message-content";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const author = document.createElement("span");
    setText(author, role === "user" ? "您" : "智能客服");
    const time = document.createElement("time");
    setText(time, formatTime());
    meta.append(author, time);

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    const paragraph = document.createElement("p");
    paragraph.className = "message-text";
    paragraph.textContent = text;
    bubble.appendChild(paragraph);

    if (role === "assistant" && responseData) {
      appendActionState(bubble, responseData);
      appendCitations(bubble, responseData.citations);
    }

    content.append(meta, bubble);
    article.append(avatar, content);
    return article;
  }

  function normalizeAction(action) {
    if (typeof action === "string") {
      return action.toLowerCase();
    }
    if (action && typeof action === "object") {
      const value = action.type || action.action || action.name || action.status;
      return typeof value === "string" ? value.toLowerCase() : "";
    }
    return "";
  }

  function appendActionState(container, responseData) {
    const action = normalizeAction(responseData.action);
    const hasTicket = Boolean(responseData.ticketId);
    const isHandoff = hasTicket || ["handoff", "human_handoff", "ticket_created", "escalate"].includes(action);
    const isRefusal = ["refuse", "refused", "restricted"].includes(action);
    const isManualRequired = action === "manual_required";

    if (!isHandoff && !isRefusal && !isManualRequired) {
      return;
    }

    const block = document.createElement("div");
    block.className = `action-state${isHandoff ? " action-state--handoff" : ""}`;

    const title = document.createElement("strong");
    const detail = document.createElement("p");

    if (isManualRequired) {
      setText(title, "需要业务人员确认");
      setText(detail, "公开站点不会创建真实工单，请通过公司的正式联系方式继续处理。 ");
    } else if (isHandoff) {
      setText(title, hasTicket ? "已创建人工服务工单" : "正在转交人工客服");
      setText(detail, "人工客服将根据本次对话继续处理您的问题。");
    } else {
      setText(title, "该事项需要人工处理");
      setText(detail, "自动客服不会执行退款审批、账号解封、赔偿或法律承诺等操作。");
    }

    block.append(title, detail);

    if (hasTicket) {
      const ticket = document.createElement("p");
      ticket.className = "action-ticket";
      setText(ticket, `工单编号：${responseData.ticketId}`);
      block.appendChild(ticket);
    } else if (isRefusal) {
      const handoffButton = document.createElement("button");
      handoffButton.type = "button";
      handoffButton.className = "action-button";
      setText(handoffButton, "联系人工客服");
      handoffButton.addEventListener("click", function () {
        sendMessage("请帮我转接人工客服。");
      });
      block.appendChild(handoffButton);
    }

    container.appendChild(block);
  }

  function citationParts(citation, index) {
    if (typeof citation === "string") {
      return { title: citation, snippet: "" };
    }

    if (!citation || typeof citation !== "object") {
      return { title: `知识库来源 ${index + 1}`, snippet: "" };
    }

    const label = citation.title || citation.filename;
    const title =
      (citation.title && citation.filename ? `${citation.title} · ${citation.filename}` : label) ||
      citation.fileName ||
      citation.name ||
      citation.source ||
      `知识库来源 ${index + 1}`;
    const sourceLocation = citation.source
      ? `${citation.source}${citation.sourcePages ? ` · 页码/章节 ${citation.sourcePages}` : ""}`
      : "";
    const snippet = sourceLocation || citation.snippet || citation.quote || citation.text || citation.content || "";
    return { title: String(title), snippet: String(snippet) };
  }

  function appendCitations(container, citations) {
    const items = Array.isArray(citations) ? citations.filter(Boolean).slice(0, 6) : [];
    if (!items.length) {
      return;
    }

    const details = document.createElement("details");
    details.className = "citations";
    const summary = document.createElement("summary");
    setText(summary, `参考依据（${items.length}）`);
    const list = document.createElement("ol");
    list.className = "citation-list";

    items.forEach(function (citation, index) {
      const parts = citationParts(citation, index);
      const item = document.createElement("li");
      item.className = "citation-item";
      const title = document.createElement("span");
      title.className = "citation-title";
      setText(title, parts.title);
      item.appendChild(title);

      if (parts.snippet && parts.snippet !== parts.title) {
        const snippet = document.createElement("span");
        snippet.className = "citation-snippet";
        setText(snippet, parts.snippet);
        item.appendChild(snippet);
      }

      list.appendChild(item);
    });

    details.append(summary, list);
    container.appendChild(details);
  }

  function appendUserMessage(message) {
    elements.emptyState.hidden = true;
    elements.messages.appendChild(createMessage("user", message));
    scrollToLatest();
  }

  function appendAssistantMessage(answer, responseData) {
    elements.emptyState.hidden = true;
    elements.messages.appendChild(createMessage("assistant", answer, responseData));
    scrollToLatest();
  }

  function showTyping() {
    const article = document.createElement("article");
    article.id = "typingIndicator";
    article.className = "message message--assistant typing-indicator";

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    setText(avatar, "客服");

    const content = document.createElement("div");
    content.className = "message-content";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    setText(meta, "智能客服");
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.setAttribute("aria-label", "智能客服正在查询知识库");
    const label = document.createElement("span");
    setText(label, "正在查询知识库");
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.setAttribute("aria-hidden", "true");
    dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    bubble.append(label, dots);
    content.append(meta, bubble);
    article.append(avatar, content);
    elements.messages.appendChild(article);
    elements.messages.setAttribute("aria-busy", "true");
    scrollToLatest();
  }

  function hideTyping() {
    const indicator = document.getElementById("typingIndicator");
    if (indicator) {
      indicator.remove();
    }
    elements.messages.removeAttribute("aria-busy");
  }

  function showError(title, message, retryable) {
    setText(elements.errorTitle, title);
    setText(elements.errorMessage, message);
    elements.retryButton.hidden = !retryable;
    elements.errorBanner.hidden = false;
  }

  function hideError() {
    elements.errorBanner.hidden = true;
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    setText(elements.toast, message);
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(function () {
      elements.toast.hidden = true;
    }, 4000);
  }

  function setPending(pending) {
    state.pending = pending;
    elements.newConversationButton.disabled = false;
    updateSendButton();
  }

  async function readResponse(response) {
    const body = await response.text();
    if (!body) {
      return {};
    }
    try {
      return JSON.parse(body);
    } catch (_error) {
      return { error: body };
    }
  }

  function fallbackAnswer(responseData) {
    const action = normalizeAction(responseData.action);
    if (responseData.ticketId || ["handoff", "human_handoff", "ticket_created", "escalate"].includes(action)) {
      return "已记录您的诉求，正在为您转接人工客服。";
    }
    if (action === "refuse") {
      return "抱歉，该事项超出自动客服的处理范围。";
    }
    return "暂未收到有效答复，请稍后再试。";
  }

  async function sendMessage(rawMessage, options) {
    const settings = options || {};
    const message = String(rawMessage || "").trim();
    if (!message || state.pending) {
      return;
    }

    hideError();
    state.lastFailedMessage = null;
    if (settings.appendUser !== false) {
      appendUserMessage(message);
    }

    elements.messageInput.value = "";
    resizeComposer();
    setPending(true);
    showTyping();

    const controller = new AbortController();
    state.controller = controller;
    let timedOut = false;
    const timeout = window.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const payload = { message: message };
      if (state.sessionId) {
        payload.sessionId = state.sessionId;
      }

      const response = await fetch(apiUrl("/api/support/chat"), {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const responseData = await readResponse(response);

      if (!response.ok) {
        const serverMessage = responseData.error || responseData.message || "服务暂时无法处理这条消息。";
        const error = new Error(String(serverMessage));
        error.requestId = responseData.requestId;
        throw error;
      }

      if (responseData.sessionId) {
        state.sessionId = String(responseData.sessionId);
        storageWrite(window.sessionStorage, "qinyi-support-session-id", state.sessionId);
        setText(elements.sessionState, "进行中");
      }

      const answer = responseData.answer == null ? fallbackAnswer(responseData) : String(responseData.answer);
      hideTyping();
      appendAssistantMessage(answer, responseData);
    } catch (error) {
      hideTyping();
      if (error.name === "AbortError" && !timedOut) {
        return;
      }

      state.lastFailedMessage = message;
      let messageText = timedOut ? "等待回复时间过长，请重新发送。" : error.message || "网络连接异常，请稍后重试。";
      if (error.requestId) {
        messageText += ` 请求编号：${error.requestId}`;
      }
      showError("消息发送失败", messageText, true);
    } finally {
      window.clearTimeout(timeout);
      if (state.controller === controller) {
        state.controller = null;
        setPending(false);
        elements.messageInput.focus();
      }
    }
  }

  function clearConversationView() {
    const conversationItems = elements.messages.querySelectorAll(".message");
    conversationItems.forEach(function (item) {
      item.remove();
    });
    elements.emptyState.hidden = false;
    hideTyping();
    hideError();
    state.lastFailedMessage = null;
    setText(elements.sessionState, "尚未开始");
    elements.messageInput.value = "";
    resizeComposer();
    updateSendButton();
    elements.messages.scrollTop = 0;
  }

  async function resetConversation() {
    if (state.controller) {
      state.controller.abort();
      state.controller = null;
    }

    const sessionId = state.sessionId;
    state.sessionId = null;
    storageWrite(window.sessionStorage, "qinyi-support-session-id", null);
    setPending(false);
    clearConversationView();
    elements.messageInput.focus();

    if (!sessionId) {
      showToast("已开启新对话");
      return;
    }
    if (sessionId.startsWith("v1.")) {
      showToast("已开启新对话");
      return;
    }

    try {
      const response = await fetch(apiUrl(`/api/support/sessions/${encodeURIComponent(sessionId)}`), {
        method: "DELETE",
        headers: {
          "X-Client-Id": API_HEADERS["X-Client-Id"],
          "X-Demo-User-Id": API_HEADERS["X-Demo-User-Id"],
          "X-Tenant-Id": API_HEADERS["X-Tenant-Id"],
        },
      });
      if (!response.ok) {
        throw new Error("会话重置失败");
      }
      showToast("已开启新对话");
    } catch (_error) {
      showError("对话已在页面中清空", "服务端会话未能重置，新消息仍会开启独立对话。", false);
    }
  }

  function setServiceStatus(tone, label, title, detail, mode) {
    elements.headerStatus.dataset.tone = tone;
    elements.sidebarStatusBadge.dataset.tone = tone;
    const mobileStatus = elements.mobileStatusText.parentElement;
    mobileStatus.dataset.tone = tone;
    setText(elements.headerStatusText, label);
    setText(elements.mobileStatusText, label);
    setText(elements.sidebarStatusBadge, label);
    setText(elements.serviceStatusTitle, title);
    setText(elements.serviceStatusDetail, detail);
    setText(elements.serviceMode, mode);
  }

  async function loadServiceStatus() {
    const controller = new AbortController();
    const timeout = window.setTimeout(function () {
      controller.abort();
    }, 6000);

    try {
      const response = await fetch(apiUrl("/api/support/status"), {
        method: "GET",
        headers: {
          "X-Client-Id": API_HEADERS["X-Client-Id"],
          "X-Demo-User-Id": API_HEADERS["X-Demo-User-Id"],
          "X-Tenant-Id": API_HEADERS["X-Tenant-Id"],
        },
        signal: controller.signal,
      });
      const data = await readResponse(response);
      if (!response.ok) {
        throw new Error("status unavailable");
      }

      if (data.aiEnabled === false) {
        setServiceStatus(
          "warning",
          "人工支持模式",
          "人工客服模式",
          "智能答复暂时停用，消息会按服务端策略转交人工处理。",
          "人工优先",
        );
      } else {
        setServiceStatus(
          "online",
          "服务在线",
          "智能客服在线",
          "知识库与会话服务已连接，可以开始咨询。",
          "智能答复",
        );
      }
    } catch (_error) {
      setServiceStatus(
        "offline",
        "状态待确认",
        "服务状态待确认",
        "暂时无法读取服务状态，您仍可以尝试发送消息。",
        "等待连接",
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  elements.chatForm.addEventListener("submit", function (event) {
    event.preventDefault();
    sendMessage(elements.messageInput.value);
  });

  elements.messageInput.addEventListener("input", function () {
    resizeComposer();
    updateSendButton();
  });

  elements.messageInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.chatForm.requestSubmit();
    }
  });

  elements.newConversationButton.addEventListener("click", resetConversation);

  elements.retryButton.addEventListener("click", function () {
    if (state.lastFailedMessage) {
      sendMessage(state.lastFailedMessage, { appendUser: false });
    }
  });

  elements.dismissErrorButton.addEventListener("click", hideError);

  document.querySelectorAll("[data-question]").forEach(function (button) {
    button.addEventListener("click", function () {
      sendMessage(button.dataset.question);
    });
  });

  resizeComposer();
  updateSendButton();
  if (state.sessionId) setText(elements.sessionState, "进行中");
  loadServiceStatus();
  window.setInterval(loadServiceStatus, 60_000);
})();
