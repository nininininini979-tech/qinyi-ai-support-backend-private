import crypto from "node:crypto";
import { sessionOwnerKey } from "../security.js";

export class MemorySessionStore {
  constructor(ttlSeconds) {
    this.ttlMs = ttlSeconds * 1000;
    this.sessions = new Map();
  }

  async get(tenantId, userId, sessionId) {
    const key = sessionOwnerKey(tenantId, userId, sessionId);
    const entry = this.sessions.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return structuredClone(entry.value);
  }

  async save(tenantId, userId, sessionId, value) {
    const key = sessionOwnerKey(tenantId, userId, sessionId);
    this.sessions.set(key, { value: structuredClone(value), expiresAt: Date.now() + this.ttlMs });
  }

  async delete(tenantId, userId, sessionId) {
    return this.sessions.delete(sessionOwnerKey(tenantId, userId, sessionId));
  }

  async close() {}
}

export class RedisSessionStore {
  constructor(client, ttlSeconds) {
    this.client = client;
    this.ttlSeconds = ttlSeconds;
  }

  async get(tenantId, userId, sessionId) {
    const raw = await this.client.get(sessionOwnerKey(tenantId, userId, sessionId));
    return raw ? JSON.parse(raw) : null;
  }

  async save(tenantId, userId, sessionId, value) {
    await this.client.set(sessionOwnerKey(tenantId, userId, sessionId), JSON.stringify(value), { EX: this.ttlSeconds });
  }

  async delete(tenantId, userId, sessionId) {
    return (await this.client.del(sessionOwnerKey(tenantId, userId, sessionId))) > 0;
  }

  async close() {
    await this.client.quit();
  }
}

function decodePart(value) {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("Non-canonical session token encoding");
  return decoded;
}

export class StatelessSessionStore {
  constructor(secret, ttlSeconds) {
    this.key = crypto.createHash("sha256").update(secret).digest();
    this.ttlMs = ttlSeconds * 1000;
  }

  async get(tenantId, userId, token) {
    try {
      const [version, ivPart, tagPart, dataPart] = String(token).split(".");
      if (version !== "v1" || !ivPart || !tagPart || !dataPart) return null;
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, decodePart(ivPart));
      decipher.setAuthTag(decodePart(tagPart));
      const plaintext = Buffer.concat([decipher.update(decodePart(dataPart)), decipher.final()]);
      const payload = JSON.parse(plaintext.toString("utf8"));
      if (payload.tenantId !== tenantId || payload.userId !== userId || payload.expiresAt <= Date.now()) return null;
      return structuredClone(payload.value);
    } catch {
      return null;
    }
  }

  async save(tenantId, userId, _sessionId, value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify({
      tenantId,
      userId,
      expiresAt: Date.now() + this.ttlMs,
      value
    }));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  async delete(tenantId, userId, token) {
    return Boolean(await this.get(tenantId, userId, token));
  }

  async close() {}
}

export async function createSessionStore(config) {
  if (config.SESSION_BACKEND === "memory") return new MemorySessionStore(config.SESSION_TTL_SECONDS);
  if (config.SESSION_BACKEND === "stateless") return new StatelessSessionStore(config.USER_HASH_SECRET, config.SESSION_TTL_SECONDS);
  const { createClient } = await import("redis");
  const client = createClient({ url: config.REDIS_URL });
  client.on("error", (error) => console.error(JSON.stringify({ event: "redis_error", message: error.message })));
  await client.connect();
  return new RedisSessionStore(client, config.SESSION_TTL_SECONDS);
}

export function newSessionId() {
  return crypto.randomUUID();
}
