import fs from "node:fs/promises";
import path from "node:path";
import { PostgresOperationsStore } from "../src/operations/postgres-store.js";

function sourceDirectory() {
  const argument = process.argv.find((item) => item.startsWith("--source="));
  return path.resolve(argument ? argument.slice("--source=".length) : "data/runtime/operations");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const directory = sourceDirectory();
const state = JSON.parse(await fs.readFile(path.join(directory, "operations.json"), "utf8"));
let events = [];
try {
  events = (await fs.readFile(path.join(directory, "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const store = await new PostgresOperationsStore({
  connectionString,
  sslMode: process.env.DATABASE_SSL_MODE || "require"
}).init();

try {
  const result = await store.importFromFile({ state, events });
  process.stdout.write(`${JSON.stringify({ ok: true, source: directory, ...result })}\n`);
} finally {
  await store.close();
}
