import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadKnowledge, retrieveKnowledge } from "../src/retrieval/local-knowledge.js";
import { buildRetrievalQuery, enrichProductContext, isProductDiscoveryIntent } from "../src/support/product-advisor.js";

test("product discovery intent receives proactive catalog and solution context", async () => {
  const chunks = await loadKnowledge(path.resolve("knowledge/prepared"));
  const message = "我想做500套适合15岁左右用户的礼品拼图，请帮我推荐方案";
  const context = enrichProductContext(chunks, retrieveKnowledge(chunks, message, 5), message, 5);
  assert.equal(isProductDiscoveryIntent(message), true);
  assert.ok(context.some((chunk) => chunk.filename === "02-product-catalog-and-use-cases.md"));
  assert.ok(context.some((chunk) => chunk.filename === "03-puzzle-mould-sizes.md" && chunk.title === "24-300 片"));
  assert.ok(!context.some((chunk) => chunk.filename === "03-puzzle-mould-sizes.md" && chunk.title === "500 片"));
  assert.ok(context.some((chunk) => chunk.filename === "04-materials-process-and-packaging.md"));
  const catalog = context.filter((chunk) => chunk.category === "product_catalog");
  assert.ok(catalog.length > 0);
  assert.ok(catalog.every((chunk) => chunk.approvalStatus === "source_verified"));
});

test("order quantity in sets is never retrieved as a puzzle piece count", async () => {
  const chunks = await loadKnowledge(path.resolve("knowledge/prepared"));
  const message = "我需要500套礼品拼图";
  const context = enrichProductContext(chunks, retrieveKnowledge(chunks, message, 5), message, 5);
  assert.ok(context.some((chunk) => chunk.title === "24-300 片"));
  assert.ok(!context.some((chunk) => chunk.title === "500 片"));
});

test("an explicit puzzle piece count retrieves only its matching size section", async () => {
  const chunks = await loadKnowledge(path.resolve("knowledge/prepared"));
  const message = "我想做500片拼图，有哪些尺寸";
  const context = enrichProductContext(chunks, retrieveKnowledge(chunks, message, 5), message, 5);
  assert.ok(context.some((chunk) => chunk.title === "500 片"));
  assert.ok(!context.some((chunk) => chunk.title === "1000 片"));

  const rangeMessage = "请推荐300片拼图的尺寸";
  const rangeContext = enrichProductContext(chunks, retrieveKnowledge(chunks, rangeMessage, 5), rangeMessage, 5);
  assert.ok(rangeContext.some((chunk) => chunk.title === "24-300 片"));
});

test("common vague discovery questions all receive approved catalog context", async () => {
  const chunks = await loadKnowledge(path.resolve("knowledge/prepared"));
  const questions = ["介绍一下你们的产品", "给我推荐一款", "我不知道选什么", "适合景区的产品", "想做儿童礼物"];
  for (const message of questions) {
    const context = enrichProductContext(chunks, retrieveKnowledge(chunks, message, 5), message, 5);
    assert.ok(context.some((chunk) => chunk.category === "product_catalog" && chunk.approvalStatus === "source_verified"), message);
  }
});

test("short follow-up reuses the previous customer question for retrieval", () => {
  assert.equal(
    buildRetrievalQuery("便宜一点", [{ user: "给15岁左右用户推荐一个礼品拼图方案" }]),
    "给15岁左右用户推荐一个礼品拼图方案\n便宜一点"
  );
});

test("unrelated out-of-scope question does not gain product context", async () => {
  const chunks = await loadKnowledge(path.resolve("knowledge/prepared"));
  const message = "董事长生日是哪天";
  const context = enrichProductContext(chunks, retrieveKnowledge(chunks, message, 5), message, 5);
  assert.equal(isProductDiscoveryIntent(message), false);
  assert.equal(context.length, 0);
});
