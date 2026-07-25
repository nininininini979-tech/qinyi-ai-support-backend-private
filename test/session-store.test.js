import test from "node:test";
import assert from "node:assert/strict";
import { MemorySessionStore, StatelessSessionStore } from "../src/stores/session-store.js";

test("sessions are bound to tenant and user", async () => {
  const store = new MemorySessionStore(1800);
  await store.save("tenant-a", "user-a", "session", { value: 1 });
  assert.deepEqual(await store.get("tenant-a", "user-a", "session"), { value: 1 });
  assert.equal(await store.get("tenant-a", "user-b", "session"), null);
  assert.equal(await store.get("tenant-b", "user-a", "session"), null);
});

test("memory store returns clones", async () => {
  const store = new MemorySessionStore(1800);
  await store.save("tenant", "user", "session", { nested: { value: 1 } });
  const value = await store.get("tenant", "user", "session");
  value.nested.value = 9;
  assert.equal((await store.get("tenant", "user", "session")).nested.value, 1);
});

test("stateless sessions are encrypted, owner-bound, and tamper-evident", async () => {
  const store = new StatelessSessionStore("0123456789abcdef0123456789abcdef", 1800);
  const token = await store.save("tenant-a", "user-a", "unused", { history: [{ user: "secret question" }] });
  assert.match(token, /^v1(?:\.[A-Za-z0-9_-]+){3}$/);
  assert.doesNotMatch(token, /secret|question/);
  assert.deepEqual(await store.get("tenant-a", "user-a", token), { history: [{ user: "secret question" }] });
  assert.equal(await store.get("tenant-a", "user-b", token), null);
  assert.equal(await store.get("tenant-b", "user-a", token), null);

  const last = token.at(-1) === "a" ? "b" : "a";
  assert.equal(await store.get("tenant-a", "user-a", `${token.slice(0, -1)}${last}`), null);
});
