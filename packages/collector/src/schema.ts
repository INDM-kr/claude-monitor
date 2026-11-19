import type Database from "better-sqlite3";
import { runtimeMigration } from "./runtime-schema.js";
import { installLocalWorkSchema } from "./local-work-migration.js";
import { installLedgerSchema } from "./ledger-migration.js";
import { mergeSplitChildRuns } from "./run-identity.js";

export interface Migration { version: number; up: (db: Database.Database) => void }

/** L1 entities only. Raw transcript text and runtime/work outcome are excluded. */
export const migrations: readonly Migration[] = [{ version: 1, up: db => db.exec(`
CREATE TABLE device (id TEXT PRIMARY KEY, display_name TEXT NOT NULL) STRICT;
CREATE TABLE provider (
  id TEXT PRIMARY KEY, adapter_version TEXT NOT NULL, source_kind TEXT NOT NULL,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities))
) STRICT;
CREATE TABLE metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
  device_id TEXT NOT NULL REFERENCES device(id), timezone TEXT NOT NULL,
  parser_version TEXT NOT NULL, mapping_revision INTEGER NOT NULL DEFAULT 0 CHECK (mapping_revision >= 0),
  ingestion_epoch INTEGER NOT NULL DEFAULT 0 CHECK (ingestion_epoch >= 0)
) STRICT;
CREATE TABLE project (id TEXT PRIMARY KEY, label TEXT NOT NULL, archived_at INTEGER) STRICT;
CREATE TABLE workspace (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id), canonical_cwd TEXT NOT NULL,
  repository_identity TEXT, project_id TEXT REFERENCES project(id),
  mapping_source TEXT NOT NULL CHECK (mapping_source IN ('manual','automatic','unassigned')),
  UNIQUE(device_id, canonical_cwd)
) STRICT;
CREATE TABLE run (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  provider_id TEXT NOT NULL REFERENCES provider(id), native_session_id TEXT NOT NULL,
  native_agent_id TEXT, parent_run_id TEXT REFERENCES run(id), workspace_id TEXT REFERENCES workspace(id),
  CHECK ((native_agent_id IS NULL AND parent_run_id IS NULL) OR (native_agent_id IS NOT NULL AND parent_run_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX run_root_identity ON run(device_id, provider_id, native_session_id)
  WHERE parent_run_id IS NULL AND native_agent_id IS NULL;
CREATE UNIQUE INDEX run_child_identity ON run(device_id, provider_id, native_session_id, parent_run_id, native_agent_id)
  WHERE parent_run_id IS NOT NULL AND native_agent_id IS NOT NULL;
CREATE TABLE source (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  provider_id TEXT NOT NULL REFERENCES provider(id), local_path TEXT NOT NULL,
  UNIQUE(device_id, provider_id, local_path)
) STRICT;
CREATE TABLE source_generation (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source(id), generation INTEGER NOT NULL CHECK (generation >= 0),
  file_identity TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ms INTEGER NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(source_id, generation)
) STRICT;
CREATE TABLE checkpoint (
  generation_id TEXT PRIMARY KEY REFERENCES source_generation(id),
  complete_byte_offset INTEGER NOT NULL CHECK (complete_byte_offset >= 0),
  verified_prefix_hash TEXT NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE usage_observation (
  id TEXT PRIMARY KEY, source_generation_id TEXT NOT NULL REFERENCES source_generation(id),
  byte_start INTEGER NOT NULL CHECK (byte_start >= 0), byte_end INTEGER NOT NULL CHECK (byte_end > byte_start),
  record_id TEXT, response_id TEXT, request_id TEXT, event_at INTEGER, observed_at INTEGER NOT NULL,
  model TEXT, input_tokens INTEGER CHECK (input_tokens >= 0), output_tokens INTEGER CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens >= 0), cache_write_tokens INTEGER CHECK (cache_write_tokens >= 0),
  cache_write_5m INTEGER CHECK (cache_write_5m >= 0), cache_write_1h INTEGER CHECK (cache_write_1h >= 0),
  service_tier TEXT, inference_geo TEXT, speed TEXT, parser_version TEXT NOT NULL, digest TEXT NOT NULL,
  UNIQUE(source_generation_id, byte_start)
) STRICT;
CREATE TABLE usage_record (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id), provider_id TEXT NOT NULL REFERENCES provider(id),
  response_id TEXT NOT NULL, request_id TEXT, run_id TEXT REFERENCES run(id), workspace_id TEXT REFERENCES workspace(id),
  model TEXT NOT NULL, first_event_at INTEGER NOT NULL, snapshot_at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0), output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0), cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  cache_write_5m INTEGER CHECK (cache_write_5m >= 0), cache_write_1h INTEGER CHECK (cache_write_1h >= 0),
  validity TEXT NOT NULL CHECK (validity IN ('valid','conflict')),
  cost_eligibility TEXT NOT NULL CHECK (cost_eligibility IN ('eligible','unknown_cache_split','invalid_cache_split')),
  parser_version TEXT NOT NULL, snapshot_observation_id TEXT REFERENCES usage_observation(id),
  UNIQUE(device_id, provider_id, response_id), CHECK (snapshot_at >= first_event_at)
) STRICT;
CREATE INDEX usage_event ON usage_record(first_event_at);
CREATE INDEX usage_workspace_event ON usage_record(workspace_id, first_event_at);
CREATE INDEX usage_model_event ON usage_record(model, first_event_at);
CREATE TABLE usage_source_link (
  usage_id TEXT NOT NULL REFERENCES usage_record(id), observation_id TEXT NOT NULL REFERENCES usage_observation(id),
  PRIMARY KEY(usage_id, observation_id), UNIQUE(observation_id)
) STRICT;
CREATE TABLE pricing_version (
  id TEXT PRIMARY KEY, source_url TEXT NOT NULL, retrieved_at INTEGER NOT NULL,
  basis TEXT NOT NULL CHECK (basis = 'standard_equivalent'), currency TEXT NOT NULL CHECK (currency = 'USD')
) STRICT;
CREATE TABLE pricing_rate (
  version_id TEXT NOT NULL REFERENCES pricing_version(id), model TEXT NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('input','output','cache_read','cache_write_5m','cache_write_1h')),
  numerator INTEGER NOT NULL CHECK (numerator >= 0), denominator INTEGER NOT NULL CHECK (denominator > 0),
  PRIMARY KEY(version_id, model, component)
) STRICT;
CREATE TRIGGER pricing_version_immutable BEFORE UPDATE ON pricing_version BEGIN SELECT RAISE(ABORT, 'immutable_pricing'); END;
CREATE TRIGGER pricing_rate_immutable BEFORE UPDATE ON pricing_rate BEGIN SELECT RAISE(ABORT, 'immutable_pricing'); END;
CREATE TRIGGER pricing_version_no_delete BEFORE DELETE ON pricing_version BEGIN SELECT RAISE(ABORT, 'immutable_pricing'); END;
CREATE TRIGGER pricing_rate_no_delete BEFORE DELETE ON pricing_rate BEGIN SELECT RAISE(ABORT, 'immutable_pricing'); END;
CREATE TABLE ingestion_diagnostic (
  id TEXT PRIMARY KEY, source_id TEXT REFERENCES source(id), generation_id TEXT REFERENCES source_generation(id),
  byte_offset INTEGER CHECK (byte_offset >= 0), code TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, count INTEGER NOT NULL CHECK (count > 0)
) STRICT;
`) }, {version: 2, up: installLedgerSchema}, runtimeMigration, {version: 4, up: installLocalWorkSchema},
  {version: 5, up: db => { mergeSplitChildRuns(db); }},
  // Codex usage: a second provider, plus per-generation reading state (its usage lines carry no cwd or model).
  {version: 6, up: db => db.exec(`
INSERT OR IGNORE INTO provider VALUES ('codex','not_started','jsonl','[]');
CREATE TABLE source_context (
  generation_id TEXT PRIMARY KEY REFERENCES source_generation(id),
  context_json TEXT NOT NULL CHECK (json_valid(context_json))
) STRICT;
`) },
  // Project management: merge suggestions the person chose to ignore.
  {version: 7, up: db => db.exec(`
CREATE TABLE project_candidate_dismissal (candidate_key TEXT PRIMARY KEY, dismissed_at INTEGER NOT NULL) STRICT;
`) }];
