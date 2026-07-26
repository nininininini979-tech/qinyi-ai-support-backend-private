import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminSource = readFileSync(new URL("../public/admin.js", import.meta.url), "utf8");

test("admin polling uses the intended session and alert intervals", () => {
  assert.match(adminSource, /const SESSION_POLL_INTERVAL_MS = 6_000;/);
  assert.match(adminSource, /const ALERT_POLL_INTERVAL_MS = 15_000;/);
  assert.match(adminSource, /setInterval\(\(\) => loadSessions\(true\), SESSION_POLL_INTERVAL_MS\)/);
});

test("handoff alert polling starts only after alerts are explicitly enabled", () => {
  const startPolling = adminSource.match(
    /function startAlertPolling\(\) \{([\s\S]*?)\n  \}\n\n  async function enableAlerts/,
  )?.[1];
  assert.ok(startPolling, "startAlertPolling function should be present");
  assert.match(startPolling, /if \(!alertsEnabled\) return;/);
  assert.match(startPolling, /setInterval\(\(\) => pollHandoffAlerts\(false\), ALERT_POLL_INTERVAL_MS\)/);
  assert.doesNotMatch(startPolling, /void pollHandoffAlerts\(false\)/);

  const enableAlerts = adminSource.match(
    /async function enableAlerts\(\) \{([\s\S]*?)\n  \}\n\n  function metricCard/,
  )?.[1];
  assert.ok(enableAlerts, "enableAlerts function should be present");
  assert.match(enableAlerts, /alertsEnabled = true;[\s\S]*await pollHandoffAlerts\(true\);[\s\S]*startAlertPolling\(\);/);
});

test("enabling alerts retains sound and browser notification behavior", () => {
  assert.match(adminSource, /function playAlertSound\(\)[\s\S]*window\.AudioContext[\s\S]*createOscillator\(\)/);
  assert.match(adminSource, /Notification\.requestPermission\(\)/);
  assert.match(adminSource, /new Notification\("勤益：新的人工服务请求"/);
});

test("resolved sessions are not counted as active and show their terminal state", () => {
  assert.match(adminSource, /activeCount = sessions\.filter\(\(item\) => !\["resolved", "closed"\]\.includes\(item\.status\)\)\.length/);
  const actionBlock = adminSource.match(/let actions = "";([\s\S]*?)setHtml\("conversationHead"/)?.[1];
  assert.ok(actionBlock, "session action block should be present");
  assert.ok(actionBlock.indexOf('["resolved", "closed"]') < actionBlock.indexOf("claimedBySomeone"));
});
