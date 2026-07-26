import test from "node:test";
import assert from "node:assert/strict";
import { compileTaskContract } from "../src/thought-layer/contract.js";

test("contract hardens explicit requirements and supersedes revised values", () => {
  const first = compileTaskContract({ message: "我们需要500套、300片的礼品拼图", now: new Date("2026-07-26T00:00:00Z") });
  assert.equal(first.demand.requirements.find((item) => item.kind === "procurement_quantity").status, "confirmed");
  assert.equal(first.demand.requirements.find((item) => item.kind === "piece_count").status, "confirmed");

  const second = compileTaskContract({
    message: "数量改为800套",
    session: { thought: { version: first.version, turn: 1, language: first.language, requirements: first.demand.requirements } },
    now: new Date("2026-07-26T00:01:00Z")
  });
  assert.equal(second.demand.requirements.find((item) => item.value.includes("500套")).status, "superseded");
  assert.equal(second.demand.requirements.find((item) => item.value.includes("800套")).status, "confirmed");
});

test("contract keeps ambiguous requirements provisional as unknown instead of inventing values", () => {
  const contract = compileTaskContract({ message: "我们想找一家工厂做一款企业礼品" });
  assert.ok(contract.demand.unknowns.includes("procurement_quantity"));
  assert.ok(contract.demand.unknowns.includes("dimensions"));
  assert.equal(contract.supply.rule, "evidence_only");
});

test("explicit English translation of specifications is high risk", () => {
  const contract = compileTaskContract({
    message: "把500套、300片、30×40cm的规格翻译成英文",
    options: { outputLanguage: "en" }
  });
  assert.equal(contract.language.output, "en");
  assert.equal(contract.risk.level, "high");
  assert.ok(contract.risk.flags.includes("cross_language_specification"));
});

test("language requested in the message overrides automatic input-language routing", () => {
  const contract = compileTaskContract({ message: "把500套、300片的规格翻译成英文" });
  assert.equal(contract.language.output, "en");
  assert.equal(contract.risk.level, "high");
});

test("professional consultation is compiled into B2", () => {
  const contract = compileTaskContract({ message: "请详细分析这个产品方案", options: { professionalConsultation: true } });
  assert.equal(contract.b2.professionalConsultation, true);
});
