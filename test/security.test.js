import test from "node:test";
import assert from "node:assert/strict";
import { maskPii, safetyIdentifier } from "../src/security.js";

test("PII masking covers Chinese mobile, ID, and email", () => {
  const masked = maskPii("电话 13812345678 身份证 11010519491231002X 邮箱 hello@example.com");
  assert.equal(masked, "电话 138****5678 身份证 ****************** 邮箱 he***@example.com");
});

test("safety identifier is stable, private, and 64 characters", () => {
  const first = safetyIdentifier("a-long-development-secret", "tenant", "user-1");
  const second = safetyIdentifier("a-long-development-secret", "tenant", "user-1");
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.doesNotMatch(first, /user-1|tenant/);
});
