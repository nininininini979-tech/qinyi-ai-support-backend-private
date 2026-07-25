import crypto from "node:crypto";

export function safetyIdentifier(secret, tenantId, userId) {
  return crypto.createHmac("sha256", secret).update(`${tenantId}:${userId}`).digest("hex");
}

export function maskPii(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`)
    .replace(/(?<!\d)\d{17}[\dXx](?!\w)/g, "******************")
    .replace(/([\w.+-]{2})[\w.+-]*(@[\w.-]+\.[A-Za-z]{2,})/g, "$1***$2");
}

export function sessionOwnerKey(tenantId, userId, sessionId) {
  return `support:${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}:${sessionId}`;
}
