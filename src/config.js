import "dotenv/config";
import { z } from "zod";

const bool = z.string().default("false").transform((value) => value.toLowerCase() === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SUPPORT_PROVIDER: z.enum(["mock", "openai", "deepseek"]).default("mock"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.6-luna"),
  OPENAI_VECTOR_STORE_ID: z.string().optional(),
  OPENAI_STORE: bool,
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("low"),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().default("deepseek-v4-flash"),
  SESSION_BACKEND: z.enum(["memory", "redis", "stateless"]).default("memory"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
  AI_SERVICE_ENABLED: bool.default("true"),
  AUTH_MODE: z.enum(["demo", "public", "trusted-header"]).default("demo"),
  DEMO_USER_ID: z.string().default("demo-user-1"),
  DEMO_TENANT_ID: z.string().default("demo-tenant"),
  PUBLIC_TENANT_ID: z.string().default("public-web"),
  PUBLIC_SITE_URL: z.string().url().default("https://nininininini979-tech.github.io/qinyi-printing-website"),
  PUBLIC_API_URL: z.string().url().optional(),
  USER_HASH_SECRET: z.string().default("development-only-secret-change-me"),
  TRUST_PROXY: bool,
  ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:3000,http://localhost:3000"),
  MAX_MESSAGE_CHARS: z.coerce.number().int().min(100).max(10000).default(2000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(30),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(25000),
  THOUGHT_REVIEW_MAX_FAILURES: z.coerce.number().int().min(1).max(3).default(3),
  THOUGHT_MEMORY_ENABLED: bool,
  THOUGHT_MEMORY_DIR: z.string().default("data/runtime/thought-layer"),
  THOUGHT_MEMORY_SECRET: z.string().optional(),
  THOUGHT_STAGE_CONVERSATIONS: z.coerce.number().int().min(10).max(10000).default(100),
  THOUGHT_STAGE_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  THOUGHT_NORMAL_DEADLINE_MS: z.coerce.number().int().min(30000).max(44000).default(40000),
  THOUGHT_PROFESSIONAL_DEADLINE_MS: z.coerce.number().int().min(45000).max(55000).default(55000),
  OPERATIONS_ENABLED: bool,
  OPERATIONS_STORE: z.enum(["file", "postgres"]).default("file"),
  OPERATIONS_DATA_DIR: z.string().default("data/runtime/operations"),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("require"),
  UPLOAD_STORE: z.enum(["file", "s3"]).default("file"),
  UPLOAD_DATA_DIR: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_KEY_PREFIX: z.string().default("qinyi"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  S3_SERVER_SIDE_ENCRYPTION: z.enum(["none", "AES256", "aws:kms"]).default("AES256"),
  S3_KMS_KEY_ID: z.string().optional(),
  OPERATIONS_ADMIN_PASSWORD: z.string().optional(),
  OPERATIONS_USERS_JSON: z.string().optional(),
  OPERATIONS_ACCOUNTS_PROVISIONED: bool,
  OPERATIONS_SESSION_SECRET: z.string().optional(),
  OPERATIONS_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(28800),
  OPERATIONS_DEVELOPER_TOKEN: z.string().optional(),
  ORDER_SMS_PROVIDER: z.enum(["disabled", "mock", "http"]).default("disabled"),
  ORDER_SMS_HTTP_URL: z.string().url().optional(),
  ORDER_SMS_HTTP_TOKEN: z.string().optional(),
  ORDER_SMS_TEMPLATE_ID: z.string().max(160).default(""),
  ORDER_SMS_SIGN_NAME: z.string().max(80).default("勤益"),
  ORDER_SMS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(15000).default(5000),
  OPERATOR_MODE: z.enum(["observe", "draft", "auto", "paused"]).default("auto"),
  AGENT_A_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
  AGENT_A_API_KEY: z.string().optional(),
  AGENT_A_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AGENT_A_MODEL: z.string().default("a-local-placeholder"),
  AGENT_A_CHARTER_VERSION: z.string().default("a-charter-v1"),
  AGENT_B_PROVIDER: z.enum(["inherit", "mock", "openai-compatible"]).default("inherit"),
  AGENT_B_API_KEY: z.string().optional(),
  AGENT_B_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AGENT_B_MODEL: z.string().default("b-local-placeholder"),
  AGENT_B_CHARTER_VERSION: z.string().default("b-charter-v1"),
  AGENT_C_PROVIDER: z.enum(["inherit", "mock", "openai-compatible"]).default("inherit"),
  AGENT_C_API_KEY: z.string().optional(),
  AGENT_C_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AGENT_C_MODEL: z.string().default("c-local-placeholder"),
  AGENT_C_CHARTER_VERSION: z.string().default("c-charter-v1"),
  AGENT_D_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
  AGENT_D_API_KEY: z.string().optional(),
  AGENT_D_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AGENT_D_MODEL: z.string().default("d-local-placeholder"),
  AGENT_D_CHARTER_VERSION: z.string().default("d-charter-v1")
});

export function loadConfig(env = process.env) {
  const config = schema.parse(env);
  config.allowedOrigins = config.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean);
  config.UPLOAD_DATA_DIR ||= `${config.OPERATIONS_DATA_DIR}/uploads`;
  config.PUBLIC_API_URL ||= config.NODE_ENV === "production"
    ? "https://qinyi-ai-support-private-api.vercel.app"
    : `http://${config.HOST === "0.0.0.0" ? "127.0.0.1" : config.HOST}:${config.PORT}`;

  if (config.SUPPORT_PROVIDER === "openai" && (!config.OPENAI_API_KEY || !config.OPENAI_VECTOR_STORE_ID)) {
    throw new Error("SUPPORT_PROVIDER=openai requires OPENAI_API_KEY and OPENAI_VECTOR_STORE_ID");
  }
  if (config.SUPPORT_PROVIDER === "deepseek" && !config.DEEPSEEK_API_KEY) {
    throw new Error("SUPPORT_PROVIDER=deepseek requires DEEPSEEK_API_KEY");
  }
  if (config.THOUGHT_MEMORY_ENABLED && (!config.THOUGHT_MEMORY_SECRET || config.THOUGHT_MEMORY_SECRET.length < 32)) {
    throw new Error("THOUGHT_MEMORY_ENABLED=true requires THOUGHT_MEMORY_SECRET with at least 32 characters");
  }
  for (const role of ["A", "B", "C", "D"]) {
    if (config[`AGENT_${role}_PROVIDER`] === "openai-compatible" && !config[`AGENT_${role}_API_KEY`]) {
      throw new Error(`AGENT_${role}_PROVIDER=openai-compatible requires AGENT_${role}_API_KEY`);
    }
  }
  if (config.OPERATIONS_ENABLED) {
    let users = [];
    if (config.OPERATIONS_USERS_JSON) {
      try { users = JSON.parse(config.OPERATIONS_USERS_JSON); }
      catch (_error) { throw new Error("OPERATIONS_USERS_JSON must be valid JSON"); }
      if (!Array.isArray(users) || users.length < 1 || users.length > 24) throw new Error("OPERATIONS_USERS_JSON must contain 1 to 24 users");
      for (const user of users) {
        if (!/^[A-Za-z0-9_.-]{2,40}$/.test(String(user.username || ""))) throw new Error("Each operations user requires a valid username");
        if (String(user.password || "").length < 12) throw new Error("Each operations user password must contain at least 12 characters");
        if (!["support", "administrator", "developer", "system_owner"].includes(user.role)) throw new Error("Unsupported operations user role");
      }
    } else if (config.OPERATIONS_ADMIN_PASSWORD) {
      if (!config.OPERATIONS_ADMIN_PASSWORD || config.OPERATIONS_ADMIN_PASSWORD.length < 12) throw new Error("OPERATIONS_ENABLED=true requires OPERATIONS_ADMIN_PASSWORD with at least 12 characters");
      users = [{ username: "admin", displayName: "勤益系统负责人", role: "system_owner", password: config.OPERATIONS_ADMIN_PASSWORD }];
    } else if (!config.OPERATIONS_ACCOUNTS_PROVISIONED) {
      throw new Error("OPERATIONS_ENABLED=true requires provisioned accounts or an explicit bootstrap credential");
    }
    config.operationsUsers = users;
    if (!config.OPERATIONS_SESSION_SECRET || config.OPERATIONS_SESSION_SECRET.length < 32) throw new Error("OPERATIONS_ENABLED=true requires OPERATIONS_SESSION_SECRET with at least 32 characters");
    if (!config.OPERATIONS_DEVELOPER_TOKEN || config.OPERATIONS_DEVELOPER_TOKEN.length < 24) throw new Error("OPERATIONS_ENABLED=true requires OPERATIONS_DEVELOPER_TOKEN with at least 24 characters");
    if (config.OPERATIONS_STORE === "postgres" && !config.DATABASE_URL) {
      throw new Error("OPERATIONS_STORE=postgres requires DATABASE_URL");
    }
    if (config.UPLOAD_STORE === "s3") {
      if (!config.S3_BUCKET) throw new Error("UPLOAD_STORE=s3 requires S3_BUCKET");
      if (Boolean(config.S3_ACCESS_KEY_ID) !== Boolean(config.S3_SECRET_ACCESS_KEY)) {
        throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together");
      }
      if (config.S3_SERVER_SIDE_ENCRYPTION === "aws:kms" && !config.S3_KMS_KEY_ID) {
        throw new Error("S3_SERVER_SIDE_ENCRYPTION=aws:kms requires S3_KMS_KEY_ID");
      }
    }
  }
  if (config.ORDER_SMS_PROVIDER === "http") {
    if (!config.ORDER_SMS_HTTP_URL) throw new Error("ORDER_SMS_PROVIDER=http requires ORDER_SMS_HTTP_URL");
    if (!config.ORDER_SMS_HTTP_TOKEN || config.ORDER_SMS_HTTP_TOKEN.length < 16) {
      throw new Error("ORDER_SMS_PROVIDER=http requires ORDER_SMS_HTTP_TOKEN with at least 16 characters");
    }
  }
  if (config.NODE_ENV === "production") {
    if (config.AUTH_MODE === "demo") throw new Error("AUTH_MODE=demo is forbidden in production");
    if (config.SESSION_BACKEND === "memory") throw new Error("SESSION_BACKEND=memory is forbidden in production");
    if (config.USER_HASH_SECRET.length < 32) throw new Error("USER_HASH_SECRET must be at least 32 characters in production");
    if (config.ORDER_SMS_PROVIDER === "mock") throw new Error("ORDER_SMS_PROVIDER=mock is forbidden in production");
  }
  return config;
}
