import test from "node:test";
import assert from "node:assert/strict";
import { toPlainText } from "../src/support/plain-text.js";

test("model Markdown decorations are normalized for safe plain-text rendering", () => {
  assert.equal(toPlainText("## 尺寸\n- **75 x 52 cm**\n> 以业务确认结果为准"), "尺寸\n- 75 x 52 cm\n以业务确认结果为准");
});

test("model tables, separators, heading decorations, and emoji are removed", () => {
  const markdown = "### 推荐方案 🎁\n\n| 方案 | 规格 |\n| --- | --- |\n| 主方案 | 300片 |\n\n---\n✅ 需业务确认";
  assert.equal(toPlainText(markdown), "推荐方案\n\n方案；规格\n主方案；300片\n\n需业务确认");
});
