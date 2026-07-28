import test from "node:test";
import assert from "node:assert/strict";
import { MIGRATION_SQL, POSTGRES_EMPTY_STATE, PostgresOperationsStore } from "../src/operations/postgres-store.js";

test("PostgreSQL store migration defines one locked snapshot and append-only event ledger", () => {
  assert.match(MIGRATION_SQL, /qinyi_operations_state/);
  assert.match(MIGRATION_SQL, /qinyi_operations_events/);
  assert.match(PostgresOperationsStore.prototype.transact.toString(), /FOR UPDATE/);
  assert.match(PostgresOperationsStore.prototype.transact.toString(), /ROLLBACK/);
  assert.deepEqual(Object.keys(POSTGRES_EMPTY_STATE).filter((key) => ["quotes", "orders", "authSessions"].includes(key)).sort(), ["authSessions", "orders", "quotes"]);
});

test("PostgreSQL store refuses initialization without a database target", () => {
  assert.throws(() => new PostgresOperationsStore(), /DATABASE_URL/);
});
