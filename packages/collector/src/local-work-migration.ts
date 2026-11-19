import type Database from "better-sqlite3";

/** Installed by schema migration 4. Transcript content is never copied here. */
export function installLocalWorkSchema(db: Database.Database): void {
  db.exec(`
CREATE TABLE work_item (
  id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  purpose TEXT NOT NULL DEFAULT '' CHECK(length(purpose) <= 4000),
  project_id TEXT REFERENCES project(id),
  status TEXT NOT NULL CHECK(status IN ('open','verified')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, verified_at INTEGER
) STRICT;
CREATE TABLE work_run_link (
  work_id TEXT NOT NULL REFERENCES work_item(id), run_id TEXT NOT NULL REFERENCES run(id),
  linked_at INTEGER NOT NULL, PRIMARY KEY(work_id, run_id)
) STRICT;
CREATE TABLE work_artifact (
  id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work_item(id),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
  reference TEXT NOT NULL CHECK(length(reference) BETWEEN 1 AND 2048),
  kind TEXT NOT NULL CHECK(kind IN ('link','local_reference')), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX work_artifact_by_work ON work_artifact(work_id,created_at);
CREATE INDEX usage_run_event ON usage_record(run_id,first_event_at);
CREATE TABLE work_event (
  id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work_item(id),
  kind TEXT NOT NULL CHECK(kind IN ('created','edited','run_linked','run_unlinked','artifact_added','verified','reopened')),
  note TEXT NOT NULL CHECK(length(note) <= 4000), actor TEXT NOT NULL CHECK(actor = 'local_user'),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX work_event_history ON work_event(work_id, created_at);
CREATE TABLE local_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1), retention_days INTEGER CHECK(retention_days BETWEEN 1 AND 3650),
  auto_delete INTEGER NOT NULL DEFAULT 0 CHECK(auto_delete = 0), updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO local_settings VALUES (1,NULL,0,0);
CREATE TABLE usage_exclusion (
  id TEXT PRIMARY KEY, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL CHECK(to_at > from_at),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX usage_exclusion_range ON usage_exclusion(from_at, to_at);
CREATE TABLE usage_excluded_response (
  device_id TEXT NOT NULL REFERENCES device(id), provider_id TEXT NOT NULL REFERENCES provider(id),
  response_id TEXT NOT NULL, excluded_at INTEGER NOT NULL,
  PRIMARY KEY(device_id,provider_id,response_id)
) STRICT;
`);
}
