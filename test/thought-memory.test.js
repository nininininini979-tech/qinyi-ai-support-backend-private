import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalThoughtMemory } from "../src/thought-layer/memory.js";

test("local total memory encrypts raw events, supports audited rehydration, and cascades deletion", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-thought-memory-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const memory = new LocalThoughtMemory({ directory, secret: "0123456789abcdef0123456789abcdef" });
  await memory.initialize();
  await memory.appendEvent({ sessionId: "session-a", type: "customer_input", agentId: "agent-b", runId: "run-1", payload: { message: "电话13800138000" } });
  await memory.appendCrystal({ sessionId: "session-a", type: "summary", payload: { message: "联系人：张三，电话13800138000，座机021-12345678，订单ORD-SECRET-9，地址：上海市测试路1号" } });

  const disk = await fs.readFile(path.join(directory, "total-events.jsonl"), "utf8");
  assert.doesNotMatch(disk, /13800138000/);
  assert.match(disk, /"agentId":"agent-b"/);
  assert.match(disk, /"runId":"run-1"/);
  const crystal = await fs.readFile(path.join(directory, "instant-crystals.jsonl"), "utf8");
  assert.doesNotMatch(crystal, /张三|021-12345678|ORD-SECRET-9|上海市测试路1号/);
  await assert.rejects(() => memory.readSessionRaw({ sessionId: "session-a", reason: "marketing" }));
  const raw = await memory.readSessionRaw({ sessionId: "session-a", reason: "handoff" });
  assert.equal(raw[0].payload.message, "电话13800138000");
  assert.equal(await memory.deleteSession("session-a"), true);
  assert.deepEqual(await memory.readSessionRaw({ sessionId: "session-a", reason: "audit" }), []);
});
