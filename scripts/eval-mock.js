import path from "node:path";
import { MockSupportProvider } from "../src/providers/mock-provider.js";

const provider = new MockSupportProvider({ knowledgeDir: path.resolve("knowledge/prepared") });
const cases = [
  { question: "你们公司有哪些产品？", expected: /拼图|纸质玩具/, grounded: true },
  { question: "1000片拼图有哪些尺寸？", expected: /1000|75|73\.5/, grounded: true },
  { question: "设计文件有什么要求？", expected: /AI|PDF|300/, grounded: true },
  { question: "你们董事长的生日是哪天？", expected: /不会猜测|没有找到/, grounded: false }
];

let passed = 0;
for (const item of cases) {
  const result = await provider.answer({ message: item.question, identity: { tenantId: "demo-tenant", userId: "demo-user-1" } });
  const ok = result.grounded === item.grounded && item.expected.test(result.answer);
  if (ok) passed += 1;
  console.log(JSON.stringify({ question: item.question, ok, grounded: result.grounded, citations: result.citations.map((citation) => citation.filename) }));
}
console.log(JSON.stringify({ passed, total: cases.length, score: passed / cases.length }));
if (passed !== cases.length) process.exitCode = 1;
