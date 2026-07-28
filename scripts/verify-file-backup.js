import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const directory = path.resolve(process.argv.find((item) => item.startsWith("--backup="))?.slice(9) || "");
if (!directory || directory === path.parse(directory).root) throw new Error("--backup=/path/to/backup is required");
const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
for (const expected of manifest.files || []) {
  const data = await fs.readFile(path.join(directory, expected.name));
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  if (sha256 !== expected.sha256 || data.length !== expected.bytes) throw new Error(`backup verification failed: ${expected.name}`);
}
const snapshot = JSON.parse(await fs.readFile(path.join(directory, "operations.json"), "utf8"));
if (!snapshot || typeof snapshot !== "object" || !Number.isInteger(Number(snapshot.version))) throw new Error("operations snapshot is invalid");
process.stdout.write(`${JSON.stringify({ ok: true, backup: directory, snapshotVersion: snapshot.version, files: manifest.files.length })}\n`);
