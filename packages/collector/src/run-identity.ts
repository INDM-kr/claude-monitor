import type Database from "better-sqlite3";

const AGENT_PREFIX = "agent-";

/**
 * Claude hooks report a subagent by its bare agent id, while transcript paths yield
 * `agent-<id>` or `<workflow>/agent-<id>`. All three name the same child run.
 */
export function hookAgentId(nativeAgentId: string): string {
  const stem = nativeAgentId.slice(nativeAgentId.lastIndexOf("/") + 1);
  return stem.startsWith(AGENT_PREFIX) ? stem.slice(AGENT_PREFIX.length) : stem;
}

/** A child created from a hook event before (or without) its transcript being ingested. */
export function isHookOnlyAgentId(nativeAgentId: string): boolean {
  return hookAgentId(nativeAgentId) === nativeAgentId;
}

interface ChildRow { id: string; parent_run_id: string; native_agent_id: string }

/**
 * Schema 5 (data only): merge child runs split before hooks and transcripts shared one identity.
 * Only unambiguous pairs (one hook-only child, one transcript child) are merged.
 */
export function mergeSplitChildRuns(db: Database.Database): number {
  const groups = new Map<string, ChildRow[]>();
  const rows = db.prepare("SELECT id,parent_run_id,native_agent_id FROM run WHERE parent_run_id IS NOT NULL").all() as ChildRow[];
  for (const row of rows) {
    const key = `${row.parent_run_id}\u0000${hookAgentId(row.native_agent_id)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  let merged = 0;
  for (const group of groups.values()) {
    const hook = group.filter(row => isHookOnlyAgentId(row.native_agent_id));
    const transcript = group.filter(row => !isHookOnlyAgentId(row.native_agent_id));
    if (hook.length !== 1 || transcript.length !== 1) continue;
    moveRun(db, hook[0]!.id, transcript[0]!.id);
    merged++;
  }
  return merged;
}

function moveRun(db: Database.Database, from: string, to: string): void {
  db.prepare("UPDATE runtime_observation SET run_id=? WHERE run_id=?").run(to, from);
  const process = (id: string) => db.prepare("SELECT identity_event_at FROM runtime_process WHERE run_id=?").get(id) as { identity_event_at: number | bigint } | undefined;
  const source = process(from), target = process(to);
  if (source && target) {
    // Keep the newer process identity; the older one describes an earlier signal.
    if (BigInt(source.identity_event_at) > BigInt(target.identity_event_at)) db.prepare("DELETE FROM runtime_process WHERE run_id=?").run(to);
    else db.prepare("DELETE FROM runtime_process WHERE run_id=?").run(from);
  }
  db.prepare("UPDATE runtime_process SET run_id=? WHERE run_id=?").run(to, from);
  db.prepare("INSERT OR IGNORE INTO work_run_link SELECT work_id,?,linked_at FROM work_run_link WHERE run_id=?").run(to, from);
  db.prepare("DELETE FROM work_run_link WHERE run_id=?").run(from);
  db.prepare("UPDATE usage_record SET run_id=? WHERE run_id=?").run(to, from);
  db.prepare("DELETE FROM run WHERE id=?").run(from);
}
