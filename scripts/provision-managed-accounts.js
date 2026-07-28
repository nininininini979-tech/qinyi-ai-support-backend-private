import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OperationsAuthService } from "../src/operations/auth.js";
import { exportManagedCredentialArtifacts, generateManagedCredentialSet } from "../src/operations/credentials-export.js";
import { FileOperationsStore } from "../src/operations/store.js";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const PASSPHRASE_ENV = "QINYI_CREDENTIAL_BUNDLE_PASSPHRASE";

function usage() {
  return [
    "用法：npm run accounts:provision -- --output /仓库外/凭据目录 --data-dir /绝对路径/operations-data",
    `执行前通过环境变量 ${PASSPHRASE_ENV} 提供至少 16 个字符的加密口令。`,
    "命令创建 20 个管理员和 4 个开发者账号；不会在终端输出临时密码、恢复信息或加密口令。"
  ].join("\n");
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function overlaps(left, right) {
  return isInside(left, right) || isInside(right, left);
}

export function parseProvisioningArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--output" && flag !== "--data-dir") throw new Error(`未知参数：${flag}\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 ${flag} 缺少路径。\n${usage()}`);
    const key = flag === "--output" ? "outputDirectory" : "dataDirectory";
    if (options[key]) throw new Error(`参数 ${flag} 不能重复。`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export async function validateProvisioningInputs({ outputDirectory, dataDirectory, passphrase, root = repositoryRoot, fsApi = fs } = {}) {
  if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new Error("--output 必须是明确的绝对路径。");
  if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error("--data-dir 必须是明确的绝对路径。");
  if (isInside(root, outputDirectory)) throw new Error("凭据目录必须位于 Git 仓库之外。");
  if (overlaps(outputDirectory, dataDirectory)) throw new Error("凭据目录和运行数据目录不得互相包含。");
  if (String(passphrase || "").length < 16) throw new Error(`${PASSPHRASE_ENV} 必须包含至少 16 个字符。`);
  try {
    await fsApi.lstat(outputDirectory);
    throw new Error("凭据目录已经存在。为防止覆盖或混入旧凭据，必须指定一个全新的目录。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    outputDirectory: path.resolve(outputDirectory),
    dataDirectory: path.resolve(dataDirectory),
    repositoryRoot: path.resolve(root)
  };
}

export async function provisionManagedAccounts(options, dependencies = {}) {
  const {
    passphrase,
    generateCredentials = generateManagedCredentialSet,
    exportCredentials = exportManagedCredentialArtifacts,
    Store = FileOperationsStore,
    AuthService = OperationsAuthService
  } = dependencies;
  const paths = await validateProvisioningInputs({ ...options, passphrase, root: options.repositoryRoot || repositoryRoot });
  const store = await new Store({ directory: paths.dataDirectory }).init();
  try {
    const existingAccountCount = await store.read((state) => Object.keys(state.operationsAccounts || {}).length);
    if (existingAccountCount > 0) throw Object.assign(new Error("账号库已经存在，安全初始化命令拒绝覆盖。"), { statusCode: 409 });

    const credentials = generateCredentials();
    const exported = await exportCredentials({
      directory: paths.outputDirectory,
      passphrase,
      repositoryRoot: paths.repositoryRoot,
      credentials
    });
    const auth = new AuthService({
      store,
      accounts: [],
      sessionSecret: crypto.randomBytes(32).toString("base64url")
    });
    const accounts = await auth.provisionManagedAccounts({ accounts: exported.provisioningAccounts, actor: "managed-account-provisioning-cli" });
    return {
      accountCount: accounts.length,
      administrators: accounts.filter((item) => item.role === "administrator").length,
      developers: accounts.filter((item) => item.role === "developer").length,
      masterBundle: exported.masterPath,
      oneTimeCardsDirectory: exported.cardsDirectory,
      operationsDataDirectory: paths.dataDirectory
    };
  } finally {
    await store.close();
  }
}

async function main() {
  const options = parseProvisioningArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await provisionManagedAccounts(options, { passphrase: process.env[PASSPHRASE_ENV] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`账号初始化失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
