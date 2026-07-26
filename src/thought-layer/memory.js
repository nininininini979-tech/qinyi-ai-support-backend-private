import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { maskPii } from "../security.js";

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

function decrypt(value, key) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
}

function maskDeep(value) {
  if (typeof value === "string") {
    return maskPii(value)
      .replace(/\bORD-[A-Za-z0-9-]+\b/gi, "[ORDER_ID]")
      .replace(/(?<!\w)\+\d(?:[\s()-]?\d){7,14}(?!\w)/g, "[PHONE]")
      .replace(/(?<!\d)0\d{2,3}[\s-]?\d{7,8}(?!\d)/g, "[PHONE]")
      .replace(/((?:姓名|联系人|收件人|公司名称|企业名称)\s*[:：]?\s*)[^,，;；\n]{2,60}/g, "$1[REDACTED]")
      .replace(/((?:收货地址|联系地址|地址)\s*[:：]?\s*)[^,，;；\n]{4,120}/g, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item)]));
  return value;
}

async function appendLine(filename, value) {
  await fs.appendFile(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function readLines(filename) {
  try {
    const content = await fs.readFile(filename, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export class NullThoughtMemory {
  async initialize() {}
  async appendEvent() {}
  async appendCrystal() {}
  async readSessionRaw() { return []; }
  async deleteSession() { return false; }
  async close() {}
}

export class LocalThoughtMemory {
  constructor({ directory, secret }) {
    if (!secret || String(secret).length < 32) throw new Error("THOUGHT_MEMORY_SECRET must contain at least 32 characters");
    this.directory = directory;
    this.key = deriveKey(secret);
    this.eventsFile = path.join(directory, "total-events.jsonl");
    this.crystalsFile = path.join(directory, "instant-crystals.jsonl");
    this.accessFile = path.join(directory, "access-audit.jsonl");
  }

  sessionFingerprint(sessionId) {
    return crypto.createHmac("sha256", this.key).update(String(sessionId)).digest("hex");
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async appendEvent({ sessionId, type, payload, at = new Date().toISOString() }) {
    const session = this.sessionFingerprint(sessionId);
    await appendLine(this.eventsFile, { id: crypto.randomUUID(), session, type, at, encrypted: encrypt(payload, this.key) });
  }

  async appendCrystal({ sessionId, type, payload, sourceEventIds = [], at = new Date().toISOString() }) {
    await appendLine(this.crystalsFile, {
      id: crypto.randomUUID(),
      session: this.sessionFingerprint(sessionId),
      type,
      at,
      status: "active",
      sourceEventIds,
      payload: maskDeep(payload)
    });
  }

  async readSessionRaw({ sessionId, reason }) {
    const allowed = new Set(["complaint", "handoff", "evidence_conflict", "audit"]);
    if (!allowed.has(reason)) throw new Error("Raw memory access requires an approved single-session reason");
    const session = this.sessionFingerprint(sessionId);
    const records = (await readLines(this.eventsFile)).filter((item) => item.session === session);
    await appendLine(this.accessFile, { id: crypto.randomUUID(), session, reason, at: new Date().toISOString(), count: records.length });
    return records.map((item) => ({ id: item.id, type: item.type, at: item.at, payload: decrypt(item.encrypted, this.key) }));
  }

  async deleteSession(sessionId) {
    const session = this.sessionFingerprint(sessionId);
    let removed = false;
    for (const filename of [this.eventsFile, this.crystalsFile]) {
      const rows = await readLines(filename);
      const kept = rows.filter((item) => item.session !== session);
      if (kept.length !== rows.length) removed = true;
      const temp = `${filename}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, kept.map((item) => JSON.stringify(item)).join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
      await fs.rename(temp, filename);
    }
    await appendLine(this.accessFile, { id: crypto.randomUUID(), session, reason: "deletion_or_revocation", at: new Date().toISOString() });
    return removed;
  }

  async close() {}
}

export async function createThoughtMemory(config, rootDir) {
  if (!config.THOUGHT_MEMORY_ENABLED) return new NullThoughtMemory();
  const directory = path.resolve(rootDir, config.THOUGHT_MEMORY_DIR || "data/runtime/thought-layer");
  const memory = new LocalThoughtMemory({ directory, secret: config.THOUGHT_MEMORY_SECRET });
  await memory.initialize();
  return memory;
}
