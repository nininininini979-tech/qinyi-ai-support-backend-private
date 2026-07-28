const SMS_PURPOSE = "customer_order_login";

function fail(message, errorCode = "SMS_DELIVERY_FAILED") {
  throw Object.assign(new Error(message), { statusCode: 502, errorCode, safeToExpose: true });
}

export class HttpSmsProvider {
  constructor({ endpoint, token, templateId = "", signName = "勤益", timeoutMs = 5000, fetchImpl = fetch } = {}) {
    if (!endpoint) throw new Error("HttpSmsProvider requires an endpoint");
    if (!token) throw new Error("HttpSmsProvider requires an authentication token");
    if (typeof fetchImpl !== "function") throw new Error("HttpSmsProvider requires fetch");
    this.name = "http-gateway";
    this.exposeCode = false;
    this.endpoint = endpoint;
    this.token = token;
    this.templateId = templateId;
    this.signName = signName;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async sendCode({ phone, code, expiresAt, challengeId }) {
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          recipient: phone,
          code,
          expiresAt,
          challengeId,
          purpose: SMS_PURPOSE,
          ...(this.templateId ? { templateId: this.templateId } : {}),
          ...(this.signName ? { signName: this.signName } : {})
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (_error) {
      fail("短信服务暂时不可用，请稍后重试。");
    }
    if (!response.ok) fail("短信发送失败，请稍后重试。");
  }
}

export class DevelopmentSmsProvider {
  constructor() {
    this.name = "development-mock";
    this.exposeCode = true;
  }

  async sendCode() {}
}

export function createSmsProvider(config, { fetchImpl = fetch } = {}) {
  if (!config || config.ORDER_SMS_PROVIDER === "disabled") return null;
  if (config.ORDER_SMS_PROVIDER === "mock") {
    if (config.NODE_ENV === "production") throw new Error("ORDER_SMS_PROVIDER=mock is forbidden in production");
    return new DevelopmentSmsProvider();
  }
  if (config.ORDER_SMS_PROVIDER === "http") {
    return new HttpSmsProvider({
      endpoint: config.ORDER_SMS_HTTP_URL,
      token: config.ORDER_SMS_HTTP_TOKEN,
      templateId: config.ORDER_SMS_TEMPLATE_ID,
      signName: config.ORDER_SMS_SIGN_NAME,
      timeoutMs: config.ORDER_SMS_TIMEOUT_MS,
      fetchImpl
    });
  }
  throw new Error(`Unsupported SMS provider: ${config.ORDER_SMS_PROVIDER}`);
}
