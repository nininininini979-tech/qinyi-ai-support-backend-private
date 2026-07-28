import pg from "pg";

const { Pool } = pg;

const EMPTY_STATE = Object.freeze({
  version: 1,
  sequence: 0,
  conversations: {},
  messages: {},
  aiDrafts: {},
  handoffs: {},
  contacts: {},
  notifications: {},
  quotes: {},
  orders: {},
  customerAuthChallenges: {},
  customerSessions: {},
  orderSystemConfig: {},
  contentRevisions: {},
  runtimeRuleRevisions: {},
  systemConfig: {},
  authSessions: {}
});

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS qinyi_operations_state (
  singleton_id SMALLINT PRIMARY KEY CHECK (singleton_id = 1),
  snapshot_version BIGINT NOT NULL,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qinyi_operations_events (
  sequence BIGSERIAL PRIMARY KEY,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS qinyi_operations_events_at_idx
  ON qinyi_operations_events ((event->>'at'));
CREATE INDEX IF NOT EXISTS qinyi_operations_events_kind_idx
  ON qinyi_operations_events ((event->>'kind'));
`;

function clone(value) {
  return structuredClone(value);
}

function normalizedState(value) {
  return { ...clone(EMPTY_STATE), ...(value && typeof value === "object" ? clone(value) : {}) };
}

function postgresSsl(mode) {
  if (mode === "disable") return false;
  if (mode === "verify-full") return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

export class PostgresOperationsStore {
  constructor({ connectionString, sslMode = "require", pool } = {}) {
    if (!pool && !connectionString) throw new Error("PostgresOperationsStore requires DATABASE_URL");
    this.pool = pool || new Pool({
      connectionString,
      ssl: postgresSsl(sslMode),
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      application_name: "qinyi-operations"
    });
    this.ownsPool = !pool;
  }

  async init() {
    await this.pool.query(MIGRATION_SQL);
    await this.pool.query(
      `INSERT INTO qinyi_operations_state (singleton_id, snapshot_version, state)
       VALUES (1, $1, $2::jsonb)
       ON CONFLICT (singleton_id) DO NOTHING`,
      [EMPTY_STATE.version, JSON.stringify(EMPTY_STATE)]
    );
    return this;
  }

  async read(reader = (state) => state) {
    const result = await this.pool.query(
      "SELECT state FROM qinyi_operations_state WHERE singleton_id = 1"
    );
    const state = normalizedState(result.rows[0]?.state);
    return clone(reader(state));
  }

  async transact(mutator, event) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(
        "SELECT snapshot_version, state FROM qinyi_operations_state WHERE singleton_id = 1 FOR UPDATE"
      );
      const current = normalizedState(currentResult.rows[0]?.state);
      const next = clone(current);
      const value = await mutator(next);
      next.version = Number(current.version || currentResult.rows[0]?.snapshot_version || 0) + 1;
      await client.query(
        `UPDATE qinyi_operations_state
         SET snapshot_version = $1, state = $2::jsonb, updated_at = NOW()
         WHERE singleton_id = 1`,
        [next.version, JSON.stringify(next)]
      );
      if (event) {
        const record = {
          ...event,
          at: event.at || new Date().toISOString(),
          snapshotVersion: next.version
        };
        await client.query(
          "INSERT INTO qinyi_operations_events (event) VALUES ($1::jsonb)",
          [JSON.stringify(record)]
        );
      }
      await client.query("COMMIT");
      return clone(value);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async appendEvent(event) {
    const record = { ...event, at: event.at || new Date().toISOString() };
    await this.pool.query(
      "INSERT INTO qinyi_operations_events (event) VALUES ($1::jsonb)",
      [JSON.stringify(record)]
    );
    return clone(record);
  }

  async listEvents({ after, limit = 100, kind } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const result = await this.pool.query(
      `SELECT event FROM (
         SELECT sequence, event
         FROM qinyi_operations_events
         WHERE ($1::text IS NULL OR event->>'at' > $1)
           AND ($2::text IS NULL OR event->>'kind' = $2)
         ORDER BY sequence DESC
         LIMIT $3
       ) recent
       ORDER BY sequence ASC`,
      [after || null, kind || null, boundedLimit]
    );
    return result.rows.map((row) => clone(row.event));
  }

  async importFromFile({ state, events = [] }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT snapshot_version, state FROM qinyi_operations_state WHERE singleton_id = 1 FOR UPDATE"
      );
      const eventCount = await client.query("SELECT COUNT(*)::int AS count FROM qinyi_operations_events");
      const currentState = normalizedState(current.rows[0]?.state);
      const hasBusinessData = Object.entries(currentState).some(([key, value]) =>
        !["version", "sequence"].includes(key) && value && typeof value === "object" && Object.keys(value).length > 0
      );
      if (hasBusinessData || Number(eventCount.rows[0]?.count || 0) > 0) {
        throw Object.assign(new Error("PostgreSQL target is not empty; import refused."), { code: "TARGET_NOT_EMPTY" });
      }
      const imported = normalizedState(state);
      await client.query(
        `UPDATE qinyi_operations_state
         SET snapshot_version = $1, state = $2::jsonb, updated_at = NOW()
         WHERE singleton_id = 1`,
        [Number(imported.version || 1), JSON.stringify(imported)]
      );
      for (const event of events) {
        await client.query(
          "INSERT INTO qinyi_operations_events (event) VALUES ($1::jsonb)",
          [JSON.stringify(event)]
        );
      }
      await client.query("COMMIT");
      return { snapshotVersion: Number(imported.version || 1), eventCount: events.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

export { EMPTY_STATE as POSTGRES_EMPTY_STATE, MIGRATION_SQL };
