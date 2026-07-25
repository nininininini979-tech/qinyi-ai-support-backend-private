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
  USER_HASH_SECRET: z.string().default("development-only-secret-change-me"),
  TRUST_PROXY: bool,
  ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:3000,http://localhost:3000"),
  MAX_MESSAGE_CHARS: z.coerce.number().int().min(100).max(10000).default(2000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(30),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(25000)
});

export function loadConfig(env = process.env) {
  const config = schema.parse(env);
  config.allowedOrigins = config.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean);

  if (config.SUPPORT_PROVIDER === "openai" && (!config.OPENAI_API_KEY || !config.OPENAI_VECTOR_STORE_ID)) {
    throw new Error("SUPPORT_PROVIDER=openai requires OPENAI_API_KEY and OPENAI_VECTOR_STORE_ID");
  }
  if (config.SUPPORT_PROVIDER === "deepseek" && !config.DEEPSEEK_API_KEY) {
    throw new Error("SUPPORT_PROVIDER=deepseek requires DEEPSEEK_API_KEY");
  }
  if (config.NODE_ENV === "production") {
    if (config.AUTH_MODE === "demo") throw new Error("AUTH_MODE=demo is forbidden in production");
    if (config.SESSION_BACKEND === "memory") throw new Error("SESSION_BACKEND=memory is forbidden in production");
    if (config.USER_HASH_SECRET.length < 32) throw new Error("USER_HASH_SECRET must be at least 32 characters in production");
  }
  return config;
}
