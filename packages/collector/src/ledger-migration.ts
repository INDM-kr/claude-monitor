import type Database from 'better-sqlite3';
export function installLedgerSchema(db: Database.Database): void {
  db.exec(`ALTER TABLE usage_observation ADD COLUMN normalized_json TEXT CHECK(normalized_json IS NULL OR json_valid(normalized_json));
    CREATE INDEX observation_response ON usage_observation(response_id);
    ALTER TABLE source ADD COLUMN stat_signature TEXT;
    ALTER TABLE source ADD COLUMN last_seen_at INTEGER;
    CREATE TABLE collector_scan(id INTEGER PRIMARY KEY CHECK(id=1), last_scan_at INTEGER, source_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, diagnostic_count INTEGER NOT NULL DEFAULT 0) STRICT;
    INSERT INTO collector_scan VALUES(1,NULL,0,'not_started',0);`);
}
