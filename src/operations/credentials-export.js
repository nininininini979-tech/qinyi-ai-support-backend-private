import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MANAGED_ACCOUNT_SPECS = Object.freeze([
  ...Array.from({ length: 20 }, (_, index) => Object.freeze({
    username: `admin${String(index + 1).padStart(2, "0")}`,
    displayName: `管理员${index + 1}`,
    role: "administrator",
    displayNameMutable: true
  })),
  ...Array.from({ length: 4 }, (_, index) => Object.freeze({
    username: `developer${String(index + 1).padStart(2, "0")}`,
    displayName: `开发者${index + 1}`,
    role: "developer",
    displayNameMutable: false
  }))
]);

const PASSWORD_SYMBOLS = "!@#$%*-_=+";

function shuffled(value) {
  const result = [...value];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = crypto.randomInt(index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result.join("");
}

export function generateTemporaryPassword() {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = `${lower}${upper}${digits}${PASSWORD_SYMBOLS}`;
  const mandatory = [
    lower[crypto.randomInt(lower.length)], upper[crypto.randomInt(upper.length)],
    digits[crypto.randomInt(digits.length)], PASSWORD_SYMBOLS[crypto.randomInt(PASSWORD_SYMBOLS.length)]
  ];
  while (mandatory.length < 20) mandatory.push(all[crypto.randomInt(all.length)]);
  return shuffled(mandatory);
}

export function generateManagedCredentialSet() {
  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt,
    accounts: MANAGED_ACCOUNT_SPECS.map((account) => ({ ...account, temporaryPassword: generateTemporaryPassword() }))
  };
}

function scryptKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(passphrase), salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}

async function encryptedEnvelope(value, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await scryptKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    schemaVersion: 1,
    kdf: { name: "scrypt", N: 32_768, r: 8, p: 1, salt: salt.toString("base64url") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") },
    data: encrypted.toString("base64url")
  };
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Writes sensitive artifacts only to an explicitly supplied directory outside the repository.
 * The returned `provisioningAccounts` is intended for `auth.provisionManagedAccounts()` and
 * remains in memory; callers must not log or serialize it inside the repository.
 */
export async function exportManagedCredentialArtifacts({ directory, passphrase, repositoryRoot, credentials = generateManagedCredentialSet() } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("Credential export directory must be an absolute path");
  if (!repositoryRoot) throw new Error("repositoryRoot is required to prevent accidental credential commits");
  if (isInside(repositoryRoot, directory)) throw new Error("Credential artifacts must be written outside the repository");
  if (String(passphrase || "").length < 16) throw new Error("Credential bundle passphrase must contain at least 16 characters");
  if (!Array.isArray(credentials.accounts) || credentials.accounts.length !== 24) throw new Error("Credential set must contain exactly 24 accounts");

  const target = path.resolve(directory);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const [realTarget, realRepositoryRoot] = await Promise.all([fs.realpath(target), fs.realpath(repositoryRoot)]);
  if (isInside(realRepositoryRoot, realTarget)) throw new Error("Credential artifacts must be written outside the repository");
  const cardsDirectory = path.join(target, "one-time-account-cards");
  await fs.mkdir(cardsDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(target, 0o700);
  await fs.chmod(cardsDirectory, 0o700);

  const stamp = credentials.generatedAt.replace(/[:.]/g, "-");
  const masterPath = path.join(target, `qinyi-manager-credentials-${stamp}.json.enc`);
  const envelope = await encryptedEnvelope(credentials, passphrase);
  await fs.writeFile(masterPath, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

  const cardPaths = [];
  for (const account of credentials.accounts) {
    const cardPath = path.join(cardsDirectory, `${account.username}.txt`);
    const lines = [
      "勤益后台账号卡",
      `账号：${account.username}`,
      `登录密码：${account.temporaryPassword}`,
      `初始名称：${account.displayName}`,
      "登录方式：使用个人账号和密码直接登录。",
      "请妥善保管；请勿通过网站客服附件传递。",
      ""
    ];
    await fs.writeFile(cardPath, lines.join("\n"), { encoding: "utf8", mode: 0o600, flag: "wx" });
    cardPaths.push(cardPath);
  }

  return {
    masterPath,
    cardsDirectory,
    cardPaths,
    provisioningAccounts: credentials.accounts.map(({ username, role, temporaryPassword }) => ({ username, role, temporaryPassword }))
  };
}
