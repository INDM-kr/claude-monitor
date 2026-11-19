import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

export const LOCAL_LIMITS = { title: 160, note: 4000, reference: 2048, items: 500, runs: 1000, retentionDays: 3650, runId: 16_384 } as const;
export const PURGE_CONFIRMATION = "DELETE LOCAL HISTORY";
const FIRST_TIMESTAMP = -8640000000000000;

export class LocalWorkError extends Error {
  constructor(public readonly code: string) { super(code); }
}
type Row = Record<string, string | number | bigint | null>;
type Input = Record<string, unknown>;
function input(value: unknown): Input {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalWorkError("invalid_input");
  return value as Input;
}
function text(value: unknown, max: number, required = true): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new LocalWorkError("invalid_text");
  const trimmed = value.trim();
  if (required && !trimmed) throw new LocalWorkError("required_text");
  return trimmed;
}
function id(value: unknown): string { return text(value, 200); }
function requireWork(db: Database.Database, value: unknown): Row {
  const found = db.prepare("SELECT * FROM work_item WHERE id=?").get(id(value)) as Row | undefined;
  if (!found) throw new LocalWorkError("work_not_found");
  return found;
}
function editable(work: Row): void { if (work.status === "verified") throw new LocalWorkError("reopen_before_editing"); }
function event(db: Database.Database, workId: string, kind: string, note: string, now: number): void {
  db.prepare("INSERT INTO work_event VALUES (?,?,?,?,?,?)").run(randomUUID(), workId, kind, note, "local_user", now);
  db.prepare("UPDATE work_item SET updated_at=? WHERE id=?").run(now, workId);
}
function project(db: Database.Database, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const result = id(value);
  if (!db.prepare("SELECT 1 FROM project WHERE id=?").get(result)) throw new LocalWorkError("project_not_found");
  return result;
}
function serializable<T>(value: T): T { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)); }

export function listWorkItems(db: Database.Database): unknown {
  const items = db.prepare(`SELECT w.*,p.label project_label FROM work_item w LEFT JOIN project p ON p.id=w.project_id
    ORDER BY w.updated_at DESC,w.id LIMIT ?`).all(LOCAL_LIMITS.items) as Row[];
  return serializable({ items: items.map(work => {
    const runs = db.prepare(`SELECT r.id,r.native_session_id,r.native_agent_id,r.parent_run_id FROM work_run_link l
      JOIN run r ON r.id=l.run_id WHERE l.work_id=? ORDER BY l.linked_at,r.id`).all(work.id) as Row[];
    const components = db.prepare(`SELECT u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_write_tokens FROM usage_record u
      WHERE u.validity='valid' AND u.run_id IN (SELECT run_id FROM work_run_link WHERE work_id=?)
      AND NOT EXISTS (SELECT 1 FROM usage_exclusion e WHERE u.first_event_at >= e.from_at AND u.first_event_at < e.to_at)`).all(work.id) as Row[];
    const tokens = components.reduce((sum, r) => sum + BigInt(r.input_tokens!) + BigInt(r.output_tokens!) + BigInt(r.cache_read_tokens!) + BigInt(r.cache_write_tokens!), 0n);
    return { ...work, runs, observed_tokens: tokens.toString(), request_count: components.length,
      artifacts: db.prepare("SELECT * FROM work_artifact WHERE work_id=? ORDER BY created_at,id").all(work.id),
      history: db.prepare("SELECT kind,note,actor,created_at FROM work_event WHERE work_id=? ORDER BY created_at,rowid").all(work.id) };
  }), projects: db.prepare("SELECT id,label FROM project WHERE archived_at IS NULL ORDER BY label,id").all(),
  availableRuns: db.prepare(`SELECT r.id,r.native_session_id,r.native_agent_id,p.label project_label FROM run r
    LEFT JOIN workspace ws ON ws.id=r.workspace_id LEFT JOIN project p ON p.id=ws.project_id ORDER BY r.rowid DESC LIMIT ?`).all(LOCAL_LIMITS.runs),
  limit: LOCAL_LIMITS.items, runsLimit: LOCAL_LIMITS.runs,
  totalItems: Number((db.prepare("SELECT count(*) n FROM work_item").get() as Row).n),
  totalRuns: Number((db.prepare("SELECT count(*) n FROM run").get() as Row).n),
  usageBasis: "linked_runs_only_not_additive_across_work_items" });
}

export function getLocalSettings(db: Database.Database): unknown {
  const settings = db.prepare("SELECT retention_days,auto_delete,updated_at FROM local_settings WHERE id=1").get() as Row;
  const metadata = db.prepare("SELECT schema_version,timezone,parser_version FROM metadata WHERE id=1").get();
  return serializable({ ...settings, metadata, exclusions: db.prepare("SELECT from_at,to_at,created_at FROM usage_exclusion ORDER BY created_at DESC").all(),
    policy: "manual_review_no_automatic_deletion", recovery: "restore_backup_to_new_directory" });
}

export function getLocalDiagnostics(db: Database.Database): unknown {
  return serializable({ diagnostics: db.prepare(`SELECT code,sum(count) count,max(last_seen_at) last_seen_at
    FROM ingestion_diagnostic GROUP BY code ORDER BY last_seen_at DESC LIMIT 100`).all(),
    sources: Number((db.prepare("SELECT count(*) n FROM source").get() as Row).n),
    requests: Number((db.prepare("SELECT count(*) n FROM usage_record").get() as Row).n),
    checkpointUpdatedAt: (db.prepare("SELECT max(updated_at) value FROM checkpoint").get() as Row).value,
    metadata: db.prepare("SELECT schema_version,timezone,parser_version FROM metadata WHERE id=1").get(),
    exportedFields: "diagnostic_codes_and_counts_only" });
}

function cutoff(value: unknown, now: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > now) throw new LocalWorkError("invalid_cutoff");
  return value;
}
export function previewLocalPurge(db: Database.Database, value: unknown, now = Date.now()): { before: number; requests: number; validRequests: number; conflictRequests: number; tokens: string; fingerprint: string } {
  const p = input(value), before = cutoff(p.before, now);
  const rows = db.prepare(`SELECT id,first_event_at,snapshot_at,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,validity
    FROM usage_record WHERE first_event_at < ? ORDER BY id`).all(before) as Row[];
  const valid = rows.filter(row => row.validity === "valid");
  const tokens = valid.reduce((sum, r) => sum + BigInt(r.input_tokens!) + BigInt(r.output_tokens!) + BigInt(r.cache_read_tokens!) + BigInt(r.cache_write_tokens!), 0n).toString();
  const fingerprint = createHash("sha256").update(JSON.stringify(serializable({ before, rows }))).digest("hex");
  return { before, requests: rows.length, validRequests: valid.length, conflictRequests: rows.length - valid.length, tokens, fingerprint };
}

/** Caller owns the one writer connection. Purge must be preceded by storage.backup(). */
export function applyLocalMutation(db: Database.Database, method: string, value: unknown, now = Date.now()): unknown {
  const p = input(value);
  return db.transaction(() => {
    if (method === "work.create") {
      const workId = randomUUID(), title = text(p.title, LOCAL_LIMITS.title), purpose = text(p.purpose ?? "", LOCAL_LIMITS.note, false);
      db.prepare("INSERT INTO work_item VALUES (?,?,?,?,?,?,?,NULL)").run(workId, title, purpose, project(db, p.projectId), "open", now, now);
      event(db, workId, "created", "", now);
      return { id: workId };
    }
    if (method.startsWith("work.")) {
      const work = requireWork(db, p.id), workId = String(work.id);
      if (method === "work.reopen") {
        if (work.status !== "verified") throw new LocalWorkError("work_not_verified");
        const note = text(p.note, LOCAL_LIMITS.note);
        db.prepare("UPDATE work_item SET status='open',verified_at=NULL WHERE id=?").run(workId);
        event(db, workId, "reopened", note, now);
        return { id: workId };
      }
      editable(work);
      if (method === "work.update") {
        const title = text(p.title, LOCAL_LIMITS.title), purpose = text(p.purpose ?? "", LOCAL_LIMITS.note, false);
        db.prepare("UPDATE work_item SET title=?,purpose=?,project_id=? WHERE id=?").run(title, purpose, project(db, p.projectId), workId);
        event(db, workId, "edited", "", now);
      } else if (method === "work.linkRun" || method === "work.unlinkRun") {
        // Canonical run IDs are JSON tuples; valid workflow children can exceed a native ID's length.
        const runId = text(p.runId, LOCAL_LIMITS.runId);
        if (!db.prepare("SELECT 1 FROM run WHERE id=?").get(runId)) throw new LocalWorkError("run_not_found");
        const changed = method === "work.linkRun"
          ? db.prepare("INSERT OR IGNORE INTO work_run_link VALUES (?,?,?)").run(workId, runId, now).changes
          : db.prepare("DELETE FROM work_run_link WHERE work_id=? AND run_id=?").run(workId, runId).changes;
        if (changed) event(db, workId, method === "work.linkRun" ? "run_linked" : "run_unlinked", "", now);
      } else if (method === "work.artifact") {
        const label = text(p.label, LOCAL_LIMITS.title), reference = text(p.reference, LOCAL_LIMITS.reference);
        let kind: "link" | "local_reference";
        if (reference.startsWith("/")) {
          if (reference.startsWith("//") || /(^|\/)\.\.(\/|$)/.test(reference)) throw new LocalWorkError("invalid_artifact_reference");
          kind = "local_reference";
        } else {
          let url: URL;
          try { url = new URL(reference); } catch { throw new LocalWorkError("invalid_artifact_reference"); }
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new LocalWorkError("invalid_artifact_reference");
          kind = "link";
        }
        db.prepare("INSERT INTO work_artifact VALUES (?,?,?,?,?,?)").run(randomUUID(), workId, label, reference, kind, now);
        event(db, workId, "artifact_added", label, now);
      } else if (method === "work.verify") {
        const note = text(p.note, LOCAL_LIMITS.note);
        if (p.confirmed !== true) throw new LocalWorkError("human_confirmation_required");
        if (!db.prepare("SELECT 1 FROM work_artifact WHERE work_id=?").get(workId)) throw new LocalWorkError("artifact_required");
        db.prepare("UPDATE work_item SET status='verified',verified_at=? WHERE id=?").run(now, workId);
        event(db, workId, "verified", note, now);
      } else throw new LocalWorkError("unknown_method");
      return { id: workId };
    }
    if (method === "local.updateSettings") {
      const days = p.retentionDays;
      if (days !== null && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > LOCAL_LIMITS.retentionDays)) throw new LocalWorkError("invalid_retention");
      db.prepare("UPDATE local_settings SET retention_days=?,updated_at=? WHERE id=1").run(days, now);
      return getLocalSettings(db);
    }
    if (method === "local.purge") {
      if (p.confirmation !== PURGE_CONFIRMATION) throw new LocalWorkError("purge_confirmation_required");
      const preview = previewLocalPurge(db, p, now);
      if (p.fingerprint !== preview.fingerprint) throw new LocalWorkError("purge_preview_changed");
      if (typeof p.backupName !== "string" || !/^schema-\d+-[\w.-]+\.sqlite$/.test(p.backupName)) throw new LocalWorkError("purge_backup_required");
      db.prepare("INSERT INTO usage_exclusion VALUES (?,?,?,?)").run(randomUUID(), FIRST_TIMESTAMP, preview.before, now);
      db.prepare(`INSERT OR IGNORE INTO usage_excluded_response SELECT device_id,provider_id,response_id,? FROM usage_record WHERE first_event_at < ?`).run(now, preview.before);
      db.prepare("DELETE FROM usage_source_link WHERE usage_id IN (SELECT id FROM usage_record WHERE first_event_at < ?)").run(preview.before);
      db.prepare("DELETE FROM usage_record WHERE first_event_at < ?").run(preview.before);
      db.prepare(`DELETE FROM usage_observation WHERE (event_at < ? OR EXISTS (
        SELECT 1 FROM usage_excluded_response e JOIN source s ON s.device_id=e.device_id AND s.provider_id=e.provider_id
        JOIN source_generation g ON g.source_id=s.id
        WHERE g.id=usage_observation.source_generation_id AND e.response_id=usage_observation.response_id
      )) AND id NOT IN (SELECT observation_id FROM usage_source_link)
        AND id NOT IN (SELECT snapshot_observation_id FROM usage_record WHERE snapshot_observation_id IS NOT NULL)`).run(preview.before);
      return { ...preview, excluded: true, backupName: p.backupName };
    }
    throw new LocalWorkError("unknown_method");
  })();
}

export function dispatchLocalRequest(db: Database.Database, method: string, payload: unknown): unknown {
  if (method === "work.list") return listWorkItems(db);
  if (method === "local.settings") return getLocalSettings(db);
  if (method === "local.diagnostics") return getLocalDiagnostics(db);
  if (method === "local.purgePreview") return previewLocalPurge(db, payload);
  return applyLocalMutation(db, method, payload);
}
