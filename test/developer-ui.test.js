import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const developerSource = readFileSync(new URL("../public/developer.js", import.meta.url), "utf8");
const developerHtml = readFileSync(new URL("../public/developer.html", import.meta.url), "utf8");

test("developer dashboard renders the live operations contract", () => {
  assert.match(developerSource, /item\.primaryValue \|\| item\.value \|\| item\.latencyMs/);
  for (const field of ["activeSessions", "humanQueue", "conversations", "pendingNotifications"]) {
    assert.match(developerSource, new RegExp(`metrics\\.${field}`));
  }
  assert.match(developerHtml, /<p>当前运营数据<\/p>/);
});

test("developer UI labels unavailable telemetry and filters completed traces", () => {
  assert.match(developerSource, /metrics\.errorRate == null \? "监控未接入"/);
  assert.match(developerSource, /metrics\.p95LatencyMs == null \? "监控未接入"/);
  assert.match(developerHtml, /<option value="complete">成功<\/option>/);
});
