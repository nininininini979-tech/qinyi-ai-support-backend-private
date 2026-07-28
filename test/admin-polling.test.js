import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminSource = readFileSync(new URL("../public/admin.js", import.meta.url), "utf8");
const adminHtml = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const commonSource = readFileSync(new URL("../public/operations-common.js", import.meta.url), "utf8");

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
  assert.match(adminSource, /new Notification\("勤益：待确认的会话转交"/);
  assert.match(adminSource, /\/api\/admin\/notifications\?status=pending&limit=100/);
});

test("session detail renders authenticated attachment downloads", () => {
  assert.match(adminSource, /<h3>客户附件<\/h3>/);
  assert.match(adminSource, /data-attachment-download/);
  assert.match(adminSource, /Ops\.download\(button\.dataset\.attachmentDownload, button\.dataset\.attachmentFilename\)/);
});

test("resolved sessions are not counted as active and show their terminal state", () => {
  assert.match(adminSource, /activeCount = sessions\.filter\(\(item\) => !\["resolved", "closed"\]\.includes\(item\.status\)\)\.length/);
  const actionBlock = adminSource.match(/let actions = "";([\s\S]*?)setHtml\("conversationHead"/)?.[1];
  assert.ok(actionBlock, "session action block should be present");
  assert.ok(actionBlock.indexOf('["resolved", "closed"]') < actionBlock.indexOf("claimedBySomeone"));
});

test("CMS and SEO publish controls submit Agent candidates with explicit approve and reject actions", () => {
  assert.match(adminHtml, /id="publishWorkspaceButton">提交 Agent 审核/);
  assert.match(adminHtml, /id="publishSeoButton">提交 Agent 审核/);
  assert.match(adminSource, /\/api\/ops\/agent-changes/);
  assert.match(adminSource, /data-agent-approve/);
  assert.match(adminSource, /data-agent-reject/);
  assert.match(adminSource, /\/api\/ops\/seo-geo\/agent-changes/);
  assert.match(adminSource, /data-seo-agent-approve/);
  assert.match(adminSource, /data-seo-agent-reject/);
});

test("CMS editor clears pending markers only after managed copy changes", () => {
  assert.match(adminSource, /previousHero\.titleStatus === "pending_input"/);
  assert.match(adminSource, /previousHero\.bodyStatus === "pending_input"/);
});

test("CMS page preview is authenticated and opens the rendered draft", () => {
  assert.match(adminHtml, /id="previewWorkspaceButton"/);
  assert.match(adminSource, /\/api\/ops\/content\/pages\/\$\{endpointId\(selectedPage\(\)\.slug\)\}\/preview\?locale=zh-CN/);
  assert.match(commonSource, /async function openHtml\(path\)/);
  assert.match(commonSource, /Authorization: `Bearer \$\{sessionToken\(\)\}`/);
});

test("runtime rule history is visible and supports audited restoration", () => {
  assert.match(adminHtml, /id="rulesHistory"/);
  assert.match(adminSource, /\/api\/ops\/rules\/revisions\?limit=50/);
  assert.match(adminSource, /data-rules-restore/);
  assert.match(adminSource, /\/api\/ops\/rules\/revisions\/\$\{endpointId\(revision\)\}\/restore/);
});

test("AI draft review is visible in the session detail and requires explicit approval", () => {
  assert.match(adminSource, /AI 草稿审核/);
  assert.match(adminSource, /data-ai-draft-content/);
  assert.match(adminSource, /data-ai-draft-action="approve"/);
  assert.match(adminSource, /\/api\/ops\/ai-drafts\/\$\{endpointId\(draftId\)\}\/\$\{action\}/);
  assert.match(adminSource, /value: "observe"/);
});

test("session actions refresh the selected detail only once", () => {
  assert.doesNotMatch(adminSource, /Promise\.all\(\[loadSessions\(true\), loadSessionDetail\(activeSessionId\)\]\)/);
  assert.match(adminSource, /await loadSessions\(true\);/);
});
