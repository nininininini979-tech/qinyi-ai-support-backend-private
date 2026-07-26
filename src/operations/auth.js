import crypto from "node:crypto";

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid TOTP secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secret, now = Date.now(), stepSeconds = 30) {
  const counter = Math.floor(now / 1000 / stepSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}

export function verifyTotp(secret, code, now = Date.now()) {
  const supplied = Buffer.from(String(code || "").padStart(6, "0"));
  if (supplied.length !== 6) return false;
  return [-1, 0, 1].some((offset) => {
    const expected = Buffer.from(totpCode(secret, now + offset * 30_000));
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  });
}

function scrypt(value, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(value, salt, 32, (error, key) => error ? reject(error) : resolve(key)));
}

export async function verifyPassword(expected, supplied, salt) {
  const [left, right] = await Promise.all([scrypt(String(expected), salt), scrypt(String(supplied || ""), salt)]);
  return crypto.timingSafeEqual(left, right);
}

export function tokenHash(secret, token) {
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || ""));
  return match?.[1] || "";
}

export class OperationsAuthService {
  constructor({ store, accounts, password, totpSecret, sessionSecret, ttlSeconds }) {
    this.store = store;
    this.accounts = Array.isArray(accounts) && accounts.length
      ? accounts
      : [{ username: "admin", displayName: "勤益系统负责人", role: "system_owner", password, totpSecret }];
    this.sessionSecret = sessionSecret;
    this.ttlMs = ttlSeconds * 1000;
  }

  async login({ username = "admin", password, totp, ip }) {
    const normalizedUsername = String(username || "").trim();
    const account = this.accounts.find((item) => item.username === normalizedUsername);
    const expectedPassword = account?.password || "invalid-account-password";
    const expectedTotpSecret = account?.totpSecret || "JBSWY3DPEHPK3PXP";
    const validPassword = await verifyPassword(expectedPassword, password, `${this.sessionSecret}:${normalizedUsername}`);
    if (!account || !validPassword || !verifyTotp(expectedTotpSecret, totp)) {
      await this.store.appendEvent({ kind: "audit", action: "admin.login_failed", actor: "anonymous", ip });
      return null;
    }
    const token = newSessionToken();
    const hash = tokenHash(this.sessionSecret, token);
    const now = Date.now();
    const session = {
      id: crypto.randomUUID(), hash, username: account.username,
      displayName: account.displayName || account.username, role: account.role,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString()
    };
    await this.store.transact((state) => {
      for (const [key, value] of Object.entries(state.authSessions)) if (Date.parse(value.expiresAt) <= now) delete state.authSessions[key];
      state.authSessions[hash] = session;
      return session;
    }, { kind: "audit", action: "admin.login", actor: session.displayName, role: session.role, ip });
    return { token, expiresAt: session.expiresAt, user: { username: session.username, name: session.displayName, role: session.role } };
  }

  async authenticate(token) {
    if (!token) return null;
    const hash = tokenHash(this.sessionSecret, token);
    const session = await this.store.read((state) => state.authSessions[hash] || null);
    return session && Date.parse(session.expiresAt) > Date.now() ? session : null;
  }

  async logout(token) {
    const hash = tokenHash(this.sessionSecret, token);
    return this.store.transact((state) => Boolean(delete state.authSessions[hash]), { kind: "audit", action: "admin.logout", actor: "admin" });
  }
}
