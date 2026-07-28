import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const source = path.resolve(argument("source", process.env.OPERATIONS_DATA_DIR || "data/runtime/operations"));
const destinationRoot = path.resolve(argument("destination", "backups/operations"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = path.join(destinationRoot, stamp);
await fs.mkdir(destination, { recursive: true, mode: 0o700 });

const files = [];
for (const name of ["operations.json", "events.ndjson"]) {
  const input = path.join(source, name);
  try {
    const data = await fs.readFile(input);
    await fs.writeFile(path.join(destination, name), data, { mode: 0o600 });
    files.push({ name, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (!files.some((item) => item.name === "operations.json")) throw new Error("operations.json was not found; backup aborted");
const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), source, files };
await fs.writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ok: true, destination, files: files.length })}\n`);
