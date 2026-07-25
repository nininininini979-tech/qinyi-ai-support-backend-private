import "dotenv/config";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const knowledgeDir = path.join(root, "knowledge", "prepared");
const names = (await fsp.readdir(knowledgeDir)).filter((name) => name.endsWith(".md")).sort();
if (!names.length) throw new Error("Run npm run kb:prepare first");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1, timeout: 60000 });
const vectorStore = await client.vectorStores.create({
  name: `Qinyi_Support_Project_Dev_${new Date().toISOString().slice(0, 10)}`,
  expires_after: { anchor: "last_active_at", days: 30 }
});
const files = names.map((name) => fs.createReadStream(path.join(knowledgeDir, name)));
const batch = await client.vectorStores.fileBatches.uploadAndPoll(vectorStore.id, { files }, { maxConcurrency: 3, pollIntervalMs: 2000 });

if (batch.status !== "completed" || batch.file_counts.failed > 0) {
  throw new Error(`Vector Store indexing failed: ${JSON.stringify(batch.file_counts)}`);
}
console.log(JSON.stringify({ vectorStoreId: vectorStore.id, status: batch.status, files: batch.file_counts }, null, 2));
