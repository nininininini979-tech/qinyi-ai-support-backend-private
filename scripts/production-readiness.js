import fs from "node:fs/promises";
import path from "node:path";

const env = process.env;
const checks = [];
const evidencePath = process.argv.find((item) => item.startsWith("--evidence="))?.slice(11);

function check(id, ok, detail) {
  checks.push({ id, status: ok ? "ready" : "blocked", detail });
}

function validUrl(value, { protocols, disallowLocal = false } = {}) {
  try {
    const parsed = new URL(String(value || ""));
    if (protocols && !protocols.includes(parsed.protocol)) return false;
    if (disallowLocal && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return false;
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function strongSecret(value, minimum) {
  const text = String(value || "");
  return text.length >= minimum && !/(?:replace|placeholder|change[-_ ]?me|development|example)/i.test(text);
}

function operationsAccounts(value) {
  try {
    const users = JSON.parse(String(value || ""));
    if (!Array.isArray(users) || users.length !== 24) return null;
    const usernames = new Set(users.map((item) => item?.username));
    const passwords = new Set(users.map((item) => item?.password));
    const administrators = users.filter((item) => item?.role === "administrator");
    const developers = users.filter((item) => item?.role === "developer");
    if (usernames.size !== 24 || passwords.size !== 24 || administrators.length !== 20 || developers.length !== 4) return null;
    if (users.some((item) => !/^[A-Za-z0-9_.-]{2,40}$/.test(String(item?.username || "")) || !strongSecret(item?.password, 12))) return null;
    return { total: users.length, administrators: administrators.length, developers: developers.length };
  } catch {
    return null;
  }
}

function exactHttpsOrigins(value) {
  const origins = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  return origins.length > 0 && origins.every((origin) => {
    if (origin.includes("*") || origin.endsWith("/")) return false;
    return validUrl(origin, { protocols: ["https:"], disallowLocal: true });
  });
}

async function loadEvidence(filename) {
  if (!filename) return null;
  try {
    const value = JSON.parse(await fs.readFile(path.resolve(filename), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const accounts = operationsAccounts(env.OPERATIONS_USERS_JSON);
const databaseUrlOk = validUrl(env.DATABASE_URL, { protocols: ["postgres:", "postgresql:"], disallowLocal: true });
const s3EndpointOk = !env.S3_ENDPOINT || validUrl(env.S3_ENDPOINT, { protocols: ["https:"], disallowLocal: true });
const redisOk = env.SESSION_BACKEND === "stateless"
  || (env.SESSION_BACKEND === "redis" && validUrl(env.REDIS_URL, { protocols: ["rediss:"], disallowLocal: true }));

check("node", Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.versions.node}; requires 22+`);
check("production_mode", env.NODE_ENV === "production" && env.OPERATIONS_ENABLED === "true", "NODE_ENV=production and OPERATIONS_ENABLED=true");
check("support_provider", ["deepseek", "openai"].includes(env.SUPPORT_PROVIDER)
  && (env.SUPPORT_PROVIDER === "deepseek" ? strongSecret(env.DEEPSEEK_API_KEY, 20) : strongSecret(env.OPENAI_API_KEY, 20) && Boolean(env.OPENAI_VECTOR_STORE_ID)), "Real AI provider and provider credentials");
check("operations_store", env.OPERATIONS_STORE === "postgres" && databaseUrlOk && ["require", "verify-full"].includes(env.DATABASE_SSL_MODE), "Remote PostgreSQL URL with TLS enabled");
check("upload_store", env.UPLOAD_STORE === "s3" && Boolean(env.S3_BUCKET) && s3EndpointOk && ["AES256", "aws:kms"].includes(env.S3_SERVER_SIDE_ENCRYPTION), "Private S3-compatible bucket with HTTPS endpoint and server-side encryption");
check("sms", env.ORDER_SMS_PROVIDER === "http" && validUrl(env.ORDER_SMS_HTTP_URL, { protocols: ["https:"], disallowLocal: true }) && strongSecret(env.ORDER_SMS_HTTP_TOKEN, 16) && Boolean(env.ORDER_SMS_TEMPLATE_ID), "HTTPS SMS gateway, token and approved template ID");
check("visitor_auth", ["public", "trusted-header"].includes(env.AUTH_MODE), "Non-demo visitor identity mode");
check("sessions", redisOk, "Encrypted stateless sessions or remote TLS Redis");
check("origins", exactHttpsOrigins(env.ALLOWED_ORIGINS), "Exact non-local HTTPS origins only");
check("public_urls", validUrl(env.PUBLIC_SITE_URL, { protocols: ["https:"], disallowLocal: true }) && validUrl(env.PUBLIC_API_URL, { protocols: ["https:"], disallowLocal: true }), "Public site and API use non-local HTTPS URLs");
check("proxy", env.TRUST_PROXY === "true", "TRUST_PROXY=true behind the production ingress");
check("accounts", Boolean(accounts) || env.OPERATIONS_ACCOUNTS_PROVISIONED === "true", "Exactly 20 administrator and four developer accounts are configured or already provisioned in the operations store");

const userSecret = String(env.USER_HASH_SECRET || "");
const operationsSecret = String(env.OPERATIONS_SESSION_SECRET || "");
const developerToken = String(env.OPERATIONS_DEVELOPER_TOKEN || "");
check("secrets", strongSecret(userSecret, 32) && strongSecret(operationsSecret, 32) && strongSecret(developerToken, 24)
  && new Set([userSecret, operationsSecret, developerToken]).size === 3, "Independent non-placeholder user, operations and developer secrets");

const migration = path.resolve("migrations/001_operations_state.sql");
check("migration", await fs.stat(migration).then(() => true, () => false), "Database migration present");

const evidence = await loadEvidence(evidencePath);
const requiredEvidence = ["postgres", "objectStorage", "sms", "aiProvider", "accounts", "backupRestore"];
const externalChecks = requiredEvidence.map((id) => {
  const item = evidence?.checks?.[id];
  const verifiedAt = item?.verifiedAt && !Number.isNaN(Date.parse(item.verifiedAt)) ? item.verifiedAt : null;
  const passed = item?.status === "passed" && verifiedAt && String(item?.verifiedBy || "").trim().length > 0;
  return {
    id,
    status: passed ? "verified" : "pending_verification",
    detail: passed ? `Verified at ${verifiedAt}` : "待补充：在预发布环境完成真实联机验收并提供仓库外证据文件"
  };
});

const configurationReady = checks.every((item) => item.status === "ready");
const externalReady = externalChecks.every((item) => item.status === "verified");
const report = {
  ready: configurationReady && externalReady,
  configurationReady,
  externalReady,
  generatedAt: new Date().toISOString(),
  checks,
  externalChecks,
  note: "静态配置检查不能替代 PostgreSQL、对象存储、短信、模型和备份恢复的真实预发布验收。"
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ready) process.exitCode = 1;
