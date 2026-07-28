import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MockSupportProvider } from "../src/providers/mock-provider.js";

const provider = new MockSupportProvider({ knowledgeDir: path.resolve("knowledge/prepared") });

test("mock provider retrieves curated product information with a citation", async () => {
  const result = await provider.answer({ message: "拼图有哪些尺寸？", identity: { tenantId: "demo-tenant", userId: "demo-user-1" } });
  assert.equal(result.grounded, true);
  assert.ok(result.citations.length > 0);
  assert.match(result.answer, /拼图|片/);
});

test("mock provider routes a common product discovery question to the approved catalog", async () => {
  const result = await provider.answer({ message: "你们有哪些产品？", identity: { tenantId: "demo-tenant", userId: "demo-user-1" } });
  assert.equal(result.grounded, true);
  assert.equal(result.citations[0]?.filename, "02-product-catalog-and-use-cases.md");
  assert.match(result.answer, /常规平面拼图|桌游与棋盘游戏/);
});

test("mock provider does not invent an unsupported fact", async () => {
  const result = await provider.answer({ message: "你们董事长的生日是哪天？", identity: { tenantId: "demo-tenant", userId: "demo-user-1" } });
  assert.equal(result.grounded, false);
  assert.match(result.answer, /不会猜测|没有找到/);
});

test("mock order lookup denies another user's order", async () => {
  const result = await provider.answer({ message: "查询 ORD-998", identity: { tenantId: "demo-tenant", userId: "demo-user-1" } });
  assert.match(result.answer, /无权|未找到/);
});
