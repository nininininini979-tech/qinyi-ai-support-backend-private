BEGIN;

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

COMMIT;
