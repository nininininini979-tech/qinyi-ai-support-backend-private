import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "knowledge", "curated");
const outputDir = path.join(root, "knowledge", "prepared");
const forbiddenNames = /(客户咨询|询盘分析|客户分类|销售话术|跟单|成交|个人|隐私)/i;
const requiredMetadata = ["category:", "source:", "reviewed_date:", "approval_status:"];

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });
const names = (await fs.readdir(sourceDir)).filter((name) => name.endsWith(".md")).sort();
if (!names.length) throw new Error("No curated Markdown files found");

for (const name of names) {
  if (forbiddenNames.test(name)) throw new Error(`Forbidden knowledge filename: ${name}`);
  const content = await fs.readFile(path.join(sourceDir, name), "utf8");
  if (!content.startsWith("---\n")) throw new Error(`${name}: missing YAML frontmatter`);
  for (const field of requiredMetadata) if (!content.includes(`\n${field}`)) throw new Error(`${name}: missing ${field}`);
  if (/客户咨询记录|总询盘[:：]|询盘占比|A类\d+个/.test(content)) throw new Error(`${name}: contains excluded customer analytics`);
  await fs.copyFile(path.join(sourceDir, name), path.join(outputDir, name));
}

console.log(JSON.stringify({ prepared: names.length, outputDir }, null, 2));
