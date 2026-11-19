import type { Migration } from "./schema.js";
export const runtimeMigration: Migration = { version: 3, up: db => db.exec(`
CREATE TABLE runtime_observation (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id),
  event_name TEXT NOT NULL, observed_at INTEGER NOT NULL,
  tool_name TEXT, notification_type TEXT,
  process_pid INTEGER CHECK(process_pid > 0), process_identity TEXT,
  CHECK ((process_pid IS NULL AND process_identity IS NULL) OR (process_pid IS NOT NULL AND process_identity IS NOT NULL))
) STRICT;
CREATE INDEX runtime_run_event ON runtime_observation(run_id, observed_at DESC, id DESC);
CREATE TABLE runtime_process (
  run_id TEXT PRIMARY KEY REFERENCES run(id), pid INTEGER NOT NULL CHECK(pid > 0),
  identity TEXT NOT NULL, identity_event_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('alive','exited','unknown')),
  observed_at INTEGER NOT NULL, reason TEXT NOT NULL
) STRICT;
`) };
