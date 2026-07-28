import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.js";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "production-readiness.js");

async function readiness(env, args = []) {
  try {
    const result = await exec(process.execPath, [script, ...args], { cwd: root, env: { PATH: process.env.PATH, ...env } });
    return { code: 0, report: JSON.parse(result.stdout) };
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout) };
  }
}

function secret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

test("production readiness rejects the former development and placeholder false-positive", async () => {
  const value = secret();
  const result = await readiness({
    NODE_ENV: "development",
    OPERATIONS_ENABLED: "false",
    SUPPORT_PROVIDER: "mock",
    OPERATIONS_STORE: "postgres",
    DATABASE_URL: "postgres://localhost/not-production",
    DATABASE_SSL_MODE: "disable",
    UPLOAD_STORE: "s3",
    S3_BUCKET: "bucket",
    S3_ENDPOINT: "http://localhost:9000",
    S3_SERVER_SIDE_ENCRYPTION: "none",
    ORDER_SMS_PROVIDER: "http",
    ORDER_SMS_HTTP_URL: "http://localhost/sms",
    ORDER_SMS_HTTP_TOKEN: "placeholder-token-value",
    AUTH_MODE: "public",
    SESSION_BACKEND: "stateless",
    ALLOWED_ORIGINS: "http://localhost:4174",
    USER_HASH_SECRET: value,
    OPERATIONS_SESSION_SECRET: value,
    OPERATIONS_DEVELOPER_TOKEN: value
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.report.ready, false);
  assert.equal(result.report.configurationReady, false);
  assert.ok(result.report.checks.some((item) => item.id === "production_mode" && item.status === "blocked"));
});

test("readiness keeps external services pending until a complete out-of-repository attestation is supplied", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-readiness-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const baseEnv = {
    NODE_ENV: "production",
    OPERATIONS_ENABLED: "true",
    SUPPORT_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: secret(),
    OPERATIONS_STORE: "postgres",
    DATABASE_URL: "postgresql://service@database.internal/qinyi",
    DATABASE_SSL_MODE: "verify-full",
    UPLOAD_STORE: "s3",
    S3_BUCKET: "qinyi-private",
    S3_ENDPOINT: "https://objects.internal.company",
    S3_SERVER_SIDE_ENCRYPTION: "AES256",
    ORDER_SMS_PROVIDER: "http",
    ORDER_SMS_HTTP_URL: "https://sms.internal.company/send-code",
    ORDER_SMS_HTTP_TOKEN: secret(20),
    ORDER_SMS_TEMPLATE_ID: "approved-template",
    AUTH_MODE: "public",
    SESSION_BACKEND: "stateless",
    ALLOWED_ORIGINS: "https://www.qinyi.example.cn",
    PUBLIC_SITE_URL: "https://www.qinyi.example.cn",
    PUBLIC_API_URL: "https://api.qinyi.example.cn",
    TRUST_PROXY: "true",
    OPERATIONS_ACCOUNTS_PROVISIONED: "true",
    USER_HASH_SECRET: secret(),
    OPERATIONS_SESSION_SECRET: secret(),
    OPERATIONS_DEVELOPER_TOKEN: secret(24)
  };
  const nodeReady = Number(process.versions.node.split(".")[0]) >= 22;
  const pending = await readiness(baseEnv);
  assert.notEqual(pending.code, 0);
  assert.equal(pending.report.configurationReady, nodeReady);
  assert.equal(pending.report.checks.find((item) => item.id === "node")?.status, nodeReady ? "ready" : "blocked");
  assert.equal(pending.report.externalReady, false);

  const verifiedAt = new Date().toISOString();
  const evidence = {
    checks: Object.fromEntries(["postgres", "objectStorage", "sms", "aiProvider", "accounts", "backupRestore"]
      .map((id) => [id, { status: "passed", verifiedAt, verifiedBy: "release-owner" }]))
  };
  const evidencePath = path.join(directory, "evidence.json");
  await fs.writeFile(evidencePath, JSON.stringify(evidence));
  const ready = await readiness(baseEnv, [`--evidence=${evidencePath}`]);
  assert.equal(ready.report.externalReady, true);
  assert.equal(ready.code, nodeReady ? 0 : 1);
  assert.equal(ready.report.ready, nodeReady);
});

test("a pre-provisioned account store can start without retaining plaintext account passwords", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    SUPPORT_PROVIDER: "mock",
    OPERATIONS_ENABLED: "true",
    OPERATIONS_ACCOUNTS_PROVISIONED: "true",
    OPERATIONS_SESSION_SECRET: secret(),
    OPERATIONS_DEVELOPER_TOKEN: secret(24)
  });
  assert.deepEqual(config.operationsUsers, []);
});
