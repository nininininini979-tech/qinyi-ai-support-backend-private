import crypto from "node:crypto";
import argon2 from "argon2";

const PASSWORD_HASH_VERSION = "scrypt-v1";
const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function asyncScrypt(value, salt, length = 32, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(value), salt, length, options || SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
}

function iso(now) {
  return new Date(now).toISOString();
}

function sanitizedAccount(account) {
  return {
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    displayNameMutable: Boolean(account.displayNameMutable),
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function authState(state) {
  if (!state.operationsAccounts || typeof state.operationsAccounts !== "object") state.operationsAccounts = {};
  if (!state.authSessions || typeof state.authSessions !== "object") state.authSessions = {};
  return state;
}

export async function hashPassword(value) {
  try {
    return await argon2.hash(String(value), { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  } catch (_error) {
    // Native Argon2 can be unavailable on an unsupported deployment target; scrypt remains a secure fallback.
  }
  const salt = crypto.randomBytes(16);
  const derived = await asyncScrypt(String(value), salt);
  return [PASSWORD_HASH_VERSION, SCRYPT_OPTIONS.N, SCRYPT_OPTIONS.r, SCRYPT_OPTIONS.p, salt.toString("base64url"), derived.toString("base64url")].join("$");
}

export async function verifyPasswordHash(encoded, supplied) {
  if (String(encoded || "").startsWith("$argon2id$")) {
    try { return await argon2.verify(String(encoded), String(supplied || "")); }
    catch (_error) { return false; }
  }
  const [version, rawN, rawR, rawP, rawSalt, rawHash] = String(encoded || "").split("$");
  if (version !== PASSWORD_HASH_VERSION || !rawSalt || !rawHash) return false;
  const options = { N: Number(rawN), r: Number(rawR), p: Number(rawP), maxmem: 64 * 1024 * 1024 };
  if (options.N !== SCRYPT_OPTIONS.N || options.r !== SCRYPT_OPTIONS.r || options.p !== SCRYPT_OPTIONS.p) return false;
  const expected = Buffer.from(rawHash, "base64url");
  const actual = await asyncScrypt(String(supplied || ""), Buffer.from(rawSalt, "base64url"), expected.length, options);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Kept for existing callers that compare two configured plaintext values without persisting them.
export async function verifyPassword(expected, supplied, salt) {
  if (String(expected || "").startsWith(`${PASSWORD_HASH_VERSION}$`)) return verifyPasswordHash(expected, supplied);
  const [left, right] = await Promise.all([asyncScrypt(String(expected), salt), asyncScrypt(String(supplied || ""), salt)]);
  return crypto.timingSafeEqual(left, right);
}

export function validateNewPassword(password, username = "") {
  const value = String(password || "");
  const categories = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(Boolean).length;
  if (value.length < 14 || value.length > 256) return { valid: false, error: "新密码需为 14 至 256 个字符。" };
  if (categories < 3) return { valid: false, error: "新密码需包含大小写字母、数字或符号中的至少三类。" };
  if (username && value.toLowerCase().includes(String(username).toLowerCase())) return { valid: false, error: "新密码不能包含账号名。" };
  if (/(.)\1{5,}/.test(value) || /password|qinyi|123456|管理员/i.test(value)) return { valid: false, error: "新密码过于常见，请使用不相关的随机密码或长密码短语。" };
  return { valid: true };
}

export function tokenHash(secret, token) {
  return crypto.createHmac("sha256", secret).update(String(token || "")).digest("hex");
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || ""));
  return match?.[1] || "";
}

export class OperationsAuthService {
  constructor({ store, accounts, password, sessionSecret, ttlSeconds = 28_800, clock = () => Date.now() } = {}) {
    if (!store) throw new Error("OperationsAuthService requires a store");
    if (!sessionSecret || String(sessionSecret).length < 32) throw new Error("OperationsAuthService requires a session secret of at least 32 characters");
    this.store = store;
    this.configuredAccounts = Array.isArray(accounts) && accounts.length
      ? accounts
      : (password ? [{ username: "admin", displayName: "勤益系统负责人", role: "system_owner", password }] : []);
    this.sessionSecret = String(sessionSecret);
    this.ttlMs = Math.max(300, Number(ttlSeconds) || 28_800) * 1000;
    this.clock = clock;
    this.initializing = null;
    this.dummyPasswordHash = null;
  }

  async initialize() {
    if (!this.initializing) {
      this.initializing = this.#initializeAccounts().catch((error) => {
        this.initializing = null;
        throw error;
      });
    }
    return this.initializing;
  }

  async #initializeAccounts() {
    const existing = await this.store.read((state) => ({
      count: Object.keys(state.operationsAccounts || {}).length,
      hasLegacyState: Boolean(state.authChallenges || state.authLoginAttempts) || Object.values(state.operationsAccounts || {}).some((account) => (
        Object.hasOwn(account, "mustChangePassword") || Object.hasOwn(account, "totp") || Object.hasOwn(account, "recoveryCodeHashes")
      ))
    }));
    if (existing.count) {
      if (!existing.hasLegacyState) return;
      await this.store.transact((state) => {
        authState(state);
        for (const account of Object.values(state.operationsAccounts)) {
          delete account.mustChangePassword;
          delete account.totp;
          delete account.recoveryCodeHashes;
        }
        delete state.authChallenges;
        delete state.authLoginAttempts;
        return Object.keys(state.operationsAccounts).length;
      }, { kind: "audit", action: "auth.password_only_migrated", actor: "system" });
      return;
    }
    if (!this.configuredAccounts.length) return;
    const now = this.clock();
    const records = {};
    for (const configured of this.configuredAccounts) {
      const username = normalizeUsername(configured.username || "admin");
      if (!username || records[username]) continue;
      const passwordHash = configured.passwordHash || await hashPassword(configured.password || crypto.randomBytes(32).toString("base64url"));
      records[username] = {
        username,
        displayName: String(configured.displayName || username),
        role: configured.role || "administrator",
        displayNameMutable: configured.displayNameMutable ?? configured.role === "administrator",
        status: configured.status || "active",
        passwordHash,
        createdAt: configured.createdAt || iso(now),
        updatedAt: iso(now)
      };
    }
    await this.store.transact((state) => {
      authState(state);
      if (!Object.keys(state.operationsAccounts).length) state.operationsAccounts = records;
      return Object.keys(state.operationsAccounts).length;
    }, { kind: "audit", action: "auth.accounts_migrated", actor: "system", count: Object.keys(records).length });
  }

  async provisionManagedAccounts({ accounts, replace = false, actor = "system" } = {}) {
    if (!Array.isArray(accounts) || accounts.length !== 24) throw Object.assign(new Error("必须一次提供 20 个管理员和 4 个开发者账号。"), { statusCode: 400 });
    const expected = new Map([
      ...Array.from({ length: 20 }, (_, index) => [`admin${String(index + 1).padStart(2, "0")}`, "administrator"]),
      ...Array.from({ length: 4 }, (_, index) => [`developer${String(index + 1).padStart(2, "0")}`, "developer"])
    ]);
    const now = this.clock();
    const records = {};
    const temporaryPasswords = new Set();
    for (const input of accounts) {
      const username = normalizeUsername(input.username);
      if (!expected.has(username) || expected.get(username) !== input.role || records[username]) {
        throw Object.assign(new Error("账号清单必须严格匹配 admin01-admin20 与 developer01-developer04。"), { statusCode: 400 });
      }
      const temporaryPassword = String(input.temporaryPassword || "");
      const passwordValidation = validateNewPassword(temporaryPassword, username);
      if (!passwordValidation.valid || temporaryPassword.length < 16) throw Object.assign(new Error(`临时密码不符合安全要求：${passwordValidation.error || "至少需要 16 个字符。"}`), { statusCode: 400 });
      if (temporaryPasswords.has(temporaryPassword)) throw Object.assign(new Error("每个账号必须使用不同的临时密码。"), { statusCode: 400 });
      temporaryPasswords.add(temporaryPassword);
      const ordinal = Number(username.match(/\d+$/)?.[0]);
      records[username] = {
        username,
        displayName: input.role === "administrator" ? `管理员${ordinal}` : `开发者${ordinal}`,
        role: input.role,
        displayNameMutable: input.role === "administrator",
        status: "active",
        passwordHash: await hashPassword(temporaryPassword),
        createdAt: iso(now),
        updatedAt: iso(now)
      };
    }
    await this.store.transact((state) => {
      authState(state);
      if (!replace && Object.keys(state.operationsAccounts).length) throw Object.assign(new Error("账号库已经存在，拒绝重复初始化。"), { statusCode: 409 });
      state.operationsAccounts = records;
      state.authSessions = {};
      return Object.values(records).map(sanitizedAccount);
    }, { kind: "audit", action: "auth.managed_accounts_provisioned", actor, count: 24, replaced: replace });
    this.initializing = Promise.resolve();
    return Object.values(records).map(sanitizedAccount);
  }

  async login(input) {
    const result = await this.loginDetailed(input);
    if (!result.ok) return null;
    const { ok: _ok, ...payload } = result;
    return payload;
  }

  async loginDetailed({ username = "admin", password, ip = "unknown" } = {}) {
    await this.initialize();
    const normalizedUsername = normalizeUsername(username);
    const now = this.clock();
    const sourceHash = this.#sourceHash(ip);

    const account = await this.store.read((state) => state.operationsAccounts?.[normalizedUsername] || null);
    if (!this.dummyPasswordHash) this.dummyPasswordHash = await hashPassword(crypto.randomBytes(32).toString("base64url"));
    const validPassword = await verifyPasswordHash(account?.passwordHash || this.dummyPasswordHash, password);
    if (!account || account.status !== "active" || !validPassword) {
      await this.#audit("auth.password_login_failed", "anonymous", { username: normalizedUsername, sourceHash });
      return { ok: false, errorCode: "INVALID_CREDENTIALS", error: "账号或密码无效。" };
    }

    await this.#audit("auth.password_login_succeeded", account.username, { sourceHash });
    return { ok: true, ...(await this.#createSession(account.username, sourceHash, now)) };
  }

  async authenticate(token) {
    if (!token) return null;
    await this.initialize();
    const hash = tokenHash(this.sessionSecret, token);
    const now = this.clock();
    return this.store.read((state) => {
      const session = state.authSessions?.[hash];
      if (!session || Date.parse(session.expiresAt) <= now) return null;
      const account = state.operationsAccounts?.[session.username];
      if (!account || account.status !== "active") return null;
      return { ...session, displayName: account.displayName, role: account.role };
    });
  }

  async logout(token) {
    const hash = tokenHash(this.sessionSecret, token);
    const session = await this.store.read((state) => state.authSessions?.[hash] || null);
    return this.store.transact((state) => Boolean(delete state.authSessions?.[hash]), {
      kind: "audit", action: "admin.logout", actor: session?.username || "anonymous"
    });
  }

  async listAccounts() {
    await this.initialize();
    return this.store.read((state) => Object.values(state.operationsAccounts || {}).map(sanitizedAccount).sort((a, b) => a.username.localeCompare(b.username)));
  }

  async updateOwnDisplayName({ session, displayName } = {}) {
    if (!session?.username) throw Object.assign(new Error("管理员会话无效。"), { statusCode: 401 });
    const name = String(displayName || "").trim();
    if (name.length < 1 || name.length > 40) throw Object.assign(new Error("名称需为 1 至 40 个字符。"), { statusCode: 400 });
    if (/[<>\u0000-\u001f]/.test(name)) throw Object.assign(new Error("名称含有不允许的字符。"), { statusCode: 400 });
    return this.store.transact((state) => {
      const account = state.operationsAccounts?.[session.username];
      if (!account || account.role !== "administrator" || !account.displayNameMutable) {
        throw Object.assign(new Error("开发者名称固定，且管理员只能修改自己的名称。"), { statusCode: 403 });
      }
      const previousDisplayName = account.displayName;
      account.displayName = name;
      account.updatedAt = iso(this.clock());
      return { ...sanitizedAccount(account), previousDisplayName };
    }, { kind: "audit", action: "auth.display_name_changed", actor: session.username });
  }

  async #createSession(username, sourceHash, now) {
    const token = newSessionToken();
    const hash = tokenHash(this.sessionSecret, token);
    const result = await this.store.transact((state) => {
      authState(state);
      const account = state.operationsAccounts[username];
      if (!account || account.status !== "active") throw Object.assign(new Error("账号不可用。"), { statusCode: 401 });
      for (const [key, value] of Object.entries(state.authSessions)) if (Date.parse(value.expiresAt) <= now) delete state.authSessions[key];
      const session = {
        id: crypto.randomUUID(), hash, username: account.username,
        displayName: account.displayName, role: account.role,
        createdAt: iso(now), expiresAt: iso(now + this.ttlMs)
      };
      state.authSessions[hash] = session;
      return { expiresAt: session.expiresAt, user: { username: account.username, name: account.displayName, role: account.role } };
    }, { kind: "audit", action: "admin.login", actor: username, sourceHash });
    return { token, ...result };
  }

  async #audit(action, actor, details = {}) {
    return this.store.appendEvent({ kind: "audit", action, actor, ...details });
  }

  #sourceHash(ip) {
    return tokenHash(this.sessionSecret, `source:${String(ip || "unknown")}`).slice(0, 24);
  }

}
