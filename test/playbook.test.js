import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadAutonomyPrompt } from "../src/support/playbook.js";

test("runtime compiles the reviewed autonomy policy from service-playbook", async () => {
  const prompt = await loadAutonomyPrompt(path.resolve("service-playbook"));
  assert.match(prompt, /主动介绍相关产品系列/);
  assert.match(prompt, /精确单价、总价、模具费/);
  assert.match(prompt, /给出主推荐及理由/);
});

test("runtime selects the relevant anonymized reply example for the current question", async () => {
  const prompt = await loadAutonomyPrompt(
    path.resolve("service-playbook"),
    "我想做500套适合15岁左右用户的礼品拼图，预算不要太高"
  );
  assert.match(prompt, /teen-audience-selection/);
  assert.match(prompt, /三百片/);
  assert.match(prompt, /不是产品事实来源/);
  assert.doesNotMatch(prompt, /custom-shape-batch/);
});

test("runtime does not force an unrelated playbook example", async () => {
  const prompt = await loadAutonomyPrompt(path.resolve("service-playbook"), "介绍一下你们公司");
  assert.doesNotMatch(prompt, /当前问题匹配的脱敏客服结构范例/);
});
