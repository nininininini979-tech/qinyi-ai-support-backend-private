import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseProvisioningArgs, provisionManagedAccounts, validateProvisioningInputs } from "../scripts/provision-managed-accounts.js";

test("provisioning CLI requires explicit paths and refuses credential output inside the repository", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-provision-paths-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const repositoryRoot = path.join(parent, "repository");
  await fs.mkdir(repositoryRoot);
  const passphrase = "Test-only-passphrase-2026!";

  assert.deepEqual(parseProvisioningArgs(["--output", "/secure/credentials", "--data-dir", "/runtime/data"]), {
    outputDirectory: "/secure/credentials",
    dataDirectory: "/runtime/data"
  });
  assert.throws(() => parseProvisioningArgs(["--output", "/secure/credentials", "--replace"]), /未知参数/);
  await assert.rejects(validateProvisioningInputs({
    outputDirectory: path.join(repositoryRoot, "credentials"),
    dataDirectory: path.join(parent, "runtime"),
    passphrase,
    root: repositoryRoot
  }), /Git 仓库之外/);
  await assert.rejects(validateProvisioningInputs({
    outputDirectory: "relative-output",
    dataDirectory: path.join(parent, "runtime"),
    passphrase,
    root: repositoryRoot
  }), /绝对路径/);
  await assert.rejects(validateProvisioningInputs({
    outputDirectory: path.join(parent, "secure"),
    dataDirectory: path.join(parent, "secure", "runtime"),
    passphrase,
    root: repositoryRoot
  }), /不得互相包含/);
});

test("provisioning CLI returns only non-secret metadata and refuses a non-empty account store", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-provision-run-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const repositoryRoot = path.join(parent, "repository");
  const outputDirectory = path.join(parent, "secure-output");
  const dataDirectory = path.join(parent, "runtime");
  await fs.mkdir(repositoryRoot);
  const secret = "Never-return-this-temporary-password!";
  const accounts = [
    ...Array.from({ length: 20 }, (_, index) => ({ username: `admin${String(index + 1).padStart(2, "0")}`, role: "administrator" })),
    ...Array.from({ length: 4 }, (_, index) => ({ username: `developer${String(index + 1).padStart(2, "0")}`, role: "developer" }))
  ];
  class FakeStore {
    constructor() { this.state = {}; }
    async init() { return this; }
    async read(reader) { return reader(this.state); }
    async close() {}
  }
  class FakeAuth {
    async provisionManagedAccounts({ accounts: supplied }) {
      return supplied.map((item) => ({ username: item.username, role: item.role }));
    }
  }
  const result = await provisionManagedAccounts({ outputDirectory, dataDirectory, repositoryRoot }, {
    passphrase: "Test-only-passphrase-2026!",
    Store: FakeStore,
    AuthService: FakeAuth,
    generateCredentials: () => ({ accounts: accounts.map((item) => ({ ...item, temporaryPassword: secret })) }),
    exportCredentials: async ({ directory, credentials }) => ({
      masterPath: path.join(directory, "bundle.enc"),
      cardsDirectory: path.join(directory, "cards"),
      provisioningAccounts: credentials.accounts
    })
  });
  assert.deepEqual({ accountCount: result.accountCount, administrators: result.administrators, developers: result.developers }, { accountCount: 24, administrators: 20, developers: 4 });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  class NonEmptyStore extends FakeStore {
    constructor() {
      super();
      this.state.operationsAccounts = { admin01: {} };
    }
  }
  await assert.rejects(provisionManagedAccounts({
    outputDirectory: path.join(parent, "another-output"),
    dataDirectory: path.join(parent, "another-runtime"),
    repositoryRoot
  }, {
    passphrase: "Test-only-passphrase-2026!",
    Store: NonEmptyStore,
    AuthService: FakeAuth,
    generateCredentials: () => { throw new Error("must not generate"); },
    exportCredentials: () => { throw new Error("must not export"); }
  }), /拒绝覆盖/);
});
