import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileOperationsStore } from "../src/operations/store.js";
import { OperationsAuthService } from "../src/operations/auth.js";
import {
  exportManagedCredentialArtifacts,
  generateManagedCredentialSet,
  MANAGED_ACCOUNT_SPECS
} from "../src/operations/credentials-export.js";

const SESSION_SECRET = "managed-auth-test-secret-0123456789abcdef";

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("managed account provisioning creates 20 self-named administrators and four fixed-name developers", async (t) => {
  const directory = await temporaryDirectory(t, "qinyi-managed-auth-");
  const store = await new FileOperationsStore({ directory }).init();
  const now = Date.parse("2026-07-27T08:00:00.000Z");
  const auth = new OperationsAuthService({ store, sessionSecret: SESSION_SECRET, ttlSeconds: 600, clock: () => now });
  const credentials = generateManagedCredentialSet();

  await auth.provisionManagedAccounts({ accounts: credentials.accounts, actor: "test-provisioner" });
  const accounts = await auth.listAccounts();
  assert.equal(accounts.length, 24);
  assert.deepEqual(accounts.filter((item) => item.role === "administrator").map((item) => item.username), MANAGED_ACCOUNT_SPECS.slice(0, 20).map((item) => item.username));
  assert.equal(accounts.find((item) => item.username === "admin20").displayName, "管理员20");
  assert.equal(accounts.find((item) => item.username === "developer04").displayName, "开发者4");
  assert.equal(accounts.find((item) => item.username === "admin01").displayNameMutable, true);
  assert.equal(accounts.find((item) => item.username === "developer01").displayNameMutable, false);

  const adminCredential = credentials.accounts.find((item) => item.username === "admin01");
  const login = await auth.loginDetailed({ username: adminCredential.username, password: adminCredential.temporaryPassword, ip: "192.0.2.10" });
  assert.equal(login.ok, true);
  assert.equal((await auth.authenticate(login.token)).username, "admin01");

  const renamed = await auth.updateOwnDisplayName({ session: await auth.authenticate(login.token), displayName: "华东值班管理员" });
  assert.equal(renamed.displayName, "华东值班管理员");
  await assert.rejects(
    auth.updateOwnDisplayName({ session: { username: "developer01" }, displayName: "不可修改" }),
    (error) => error.statusCode === 403
  );

  const snapshot = await fs.readFile(path.join(directory, "operations.json"), "utf8");
  assert.doesNotMatch(snapshot, new RegExp(adminCredential.temporaryPassword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(snapshot, /192\.0\.2\.10/);
  assert.match(snapshot, /argon2id/);
  await store.close();
});

test("password login never exposes a visual CAPTCHA and still audits failed attempts", async (t) => {
  const directory = await temporaryDirectory(t, "qinyi-auth-password-only-");
  const store = await new FileOperationsStore({ directory }).init();
  let now = Date.parse("2026-07-27T09:00:00.000Z");
  const password = "Legacy-Admin-Password-123!";
  const auth = new OperationsAuthService({
    store,
    accounts: [{ username: "administrator", displayName: "管理员", role: "administrator", password }],
    sessionSecret: SESSION_SECRET,
    ttlSeconds: 3600,
    clock: () => now
  });

  let failure;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    failure = await auth.loginDetailed({ username: "administrator", password: "incorrect-password", ip: "198.51.100.8" });
  }
  assert.equal(failure.errorCode, "INVALID_CREDENTIALS");
  assert.equal(failure.captcha, undefined);
  assert.equal((await store.listEvents()).filter((event) => event.action === "auth.password_login_failed").length, 5);

  const successful = await auth.loginDetailed({ username: "administrator", password, ip: "198.51.100.8" });
  assert.equal(successful.ok, true);

  now += 16 * 60_000;
  assert.equal((await auth.authenticate(successful.token)).username, "administrator");
  const snapshot = await fs.readFile(path.join(directory, "operations.json"), "utf8");
  assert.doesNotMatch(snapshot, /198\.51\.100\.8/);
  await store.close();
});

test("initialization removes obsolete second-factor state from an existing account store", async (t) => {
  const directory = await temporaryDirectory(t, "qinyi-auth-migration-");
  const store = await new FileOperationsStore({ directory }).init();
  await store.transact((state) => {
    state.operationsAccounts = {
      admin01: {
        username: "admin01",
        displayName: "管理员1",
        role: "administrator",
        displayNameMutable: true,
        status: "active",
        passwordHash: "legacy-hash-placeholder",
        mustChangePassword: false,
        totp: { secretCipher: "legacy-secret" },
        recoveryCodeHashes: ["legacy-recovery-hash"],
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z"
      }
    };
    state.authChallenges = { legacy: { type: "totp_enrollment" } };
    state.authLoginAttempts = { legacy: { attempts: [] } };
  });

  const auth = new OperationsAuthService({ store, sessionSecret: SESSION_SECRET });
  await auth.initialize();
  const state = await store.read();
  assert.equal(state.operationsAccounts.admin01.mustChangePassword, undefined);
  assert.equal(state.operationsAccounts.admin01.totp, undefined);
  assert.equal(state.operationsAccounts.admin01.recoveryCodeHashes, undefined);
  assert.equal(state.authChallenges, undefined);
  assert.equal(state.authLoginAttempts, undefined);
  assert.equal((await auth.listAccounts())[0].totpEnrolled, undefined);
  await store.close();
});

test("credential exporter keeps the encrypted master bundle and 24 one-time cards outside the repository", async (t) => {
  const parent = await temporaryDirectory(t, "qinyi-credential-export-");
  const repositoryRoot = path.join(parent, "repository");
  const destination = path.join(parent, "external-secure-delivery");
  await fs.mkdir(repositoryRoot);
  const credentials = generateManagedCredentialSet();
  const result = await exportManagedCredentialArtifacts({
    directory: destination,
    passphrase: "Test-only-master-passphrase-2026!",
    repositoryRoot,
    credentials
  });
  assert.equal(result.cardPaths.length, 24);
  assert.equal(result.provisioningAccounts.length, 24);
  const encrypted = await fs.readFile(result.masterPath, "utf8");
  assert.doesNotMatch(encrypted, new RegExp(credentials.accounts[0].temporaryPassword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((await fs.stat(result.masterPath)).mode & 0o777, 0o600);
  await assert.rejects(exportManagedCredentialArtifacts({
    directory: path.join(repositoryRoot, "credentials"),
    passphrase: "Test-only-master-passphrase-2026!",
    repositoryRoot,
    credentials
  }), /outside the repository/);
});
