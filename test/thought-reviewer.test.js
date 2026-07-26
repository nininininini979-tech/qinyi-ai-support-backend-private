import test from "node:test";
import assert from "node:assert/strict";
import { compileTaskContract } from "../src/thought-layer/contract.js";
import { reviewDeterministically } from "../src/thought-layer/reviewer.js";

test("reviewer rejects answers that drop confirmed numbers and units", () => {
  const contract = compileTaskContract({ message: "需要500套、300片的拼图" });
  const review = reviewDeterministically({ candidate: "建议先评估标准礼品拼图方案。", contract, citations: [{ filename: "catalog.md" }] });
  assert.equal(review.decision, "fail");
  assert.ok(review.issues.some((item) => item.code === "missing_confirmed_requirement"));
});

test("reviewer rejects unsupported high-risk answers without evidence", () => {
  const contract = compileTaskContract({ message: "这批货准确交期是什么时候" });
  const review = reviewDeterministically({ candidate: "可以在两周内交货。", contract, citations: [] });
  assert.ok(review.issues.some((item) => item.code === "missing_evidence" && item.severity === "fatal"));
});

test("reviewer rejects an ungrounded ordinary company claim", () => {
  const contract = compileTaskContract({ message: "介绍一下你们的工厂" });
  const review = reviewDeterministically({ candidate: "我们年产一千万件。", contract, citations: [], grounded: false });
  assert.ok(review.issues.some((item) => item.code === "ungrounded_response" && item.severity === "fatal"));
});

test("reviewer allows an evidence-bounded no-answer fallback", () => {
  const contract = compileTaskContract({ message: "你们董事长生日是哪天" });
  const review = reviewDeterministically({ candidate: "现有知识库中没有找到依据，我不会猜测，可以由人工确认。", contract, citations: [], grounded: false });
  assert.equal(review.decision, "pass");
});

test("reviewer preserves confirmed quantities across spacing and English unit translation", () => {
  const contract = compileTaskContract({ message: "把500套、300片的规格翻译成英文" });
  const review = reviewDeterministically({
    candidate: "The current requirement is 500 sets of 300-piece puzzles. Final feasibility still requires business confirmation.",
    contract,
    citations: [{ filename: "catalog.md" }]
  });
  assert.equal(review.issues.some((item) => item.code === "missing_confirmed_requirement"), false);
});
