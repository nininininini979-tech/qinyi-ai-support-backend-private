import test from "node:test";
import assert from "node:assert/strict";
import { reviewProductAnswer } from "../src/support/answer-guard.js";

test("product answer guard rejects unsupported performance and feasibility claims", () => {
  const issues = reviewProductAnswer("15岁用户观察力和耐心更好，300片有适度挑战感并能保持完成率；500套满足常规起订量，数量上没有问题。", 600);
  assert.ok(issues.includes("未经依据的年龄或体验表现"));
  assert.ok(issues.includes("未经确认的生产可行性"));
});

test("product answer guard rejects unsupported print and presentation effects", () => {
  const issues = reviewProductAnswer("白卡的色彩还原度更好，礼品比较体面，低片数包装体积更小。", 600);
  assert.deepEqual(issues, ["未经依据的质量或展示效果"]);
});

test("product answer guard accepts conditional recommendations with human confirmation", () => {
  assert.deepEqual(
    reviewProductAnswer("可优先评估300片、38×26厘米的标准规格。精确价格、交期、起订量和生产可行性需由业务确认。"),
    []
  );
});

test("product answer guard enforces the response length budget", () => {
  assert.deepEqual(reviewProductAnswer("建议".repeat(301)), ["超过600字符"]);
});
