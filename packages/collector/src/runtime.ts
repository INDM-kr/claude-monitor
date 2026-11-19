import { randomUUID } from "node:crypto";
import { RUNTIME_EVENTS, deriveRuntimeState } from "@claude-monitor/core";
import type { RuntimeEvent, RuntimeEventName, RuntimeProcessProbe, RuntimeReport, RuntimeRun } from "@claude-monitor/core";
import type { Storage } from "./storage.js";
import { RUNTIME_DEFAULTS, runtimeStaleAfterMs } from "./runtime-config.js";
import { CollectorError } from "./config.js";
import { probeProcess } from "./runtime-process.js";
import { resolveRuntimeHookToken } from "./runtime-token.js";
import { hookAgentId, isHookOnlyAgentId } from "./run-identity.js";

const identifier = /^[a-zA-Z0-9_.:-]{1,200}$/;
const fields = new Set(["eventId", "sessionId", "agentId", "eventName", "observedAt", "toolName", "notificationType", "processPid", "processIdentity"]);
export function validateRuntimeEvent(input: unknown, now = Date.now()): RuntimeEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CollectorError("invalid_runtime_event");
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some(key => !fields.has(key))) throw new CollectorError("invalid_runtime_event");
  for (const key of ["eventId", "sessionId"]) if (typeof v[key] !== "string" || !identifier.test(v[key] as string)) throw new CollectorError("invalid_runtime_event");
  for (const key of ["agentId", "toolName", "notificationType"]) if (v[key] != null && (typeof v[key] !== "string" || !identifier.test(v[key] as string))) throw new CollectorError("invalid_runtime_event");
  if (!RUNTIME_EVENTS.includes(v.eventName as RuntimeEventName)) throw new CollectorError("unsupported_runtime_event");
  if (!Number.isSafeInteger(v.observedAt) || Number(v.observedAt) <= 0 || Number(v.observedAt) > now + 1_000) throw new CollectorError("invalid_runtime_event_time");
  const pid = v.processPid ?? null, identity = v.processIdentity ?? null;
  if ((pid === null) !== (identity === null) || (pid !== null && (!Number.isSafeInteger(pid) || Number(pid) <= 0 || typeof identity !== "string" || !/^[a-f0-9]{64}$/.test(identity)))) throw new CollectorError("invalid_runtime_process");
  return { eventId: String(v.eventId), sessionId: String(v.sessionId), agentId: (v.agentId ?? null) as string | null,
    eventName: v.eventName as RuntimeEventName, observedAt: Number(v.observedAt), toolName: (v.toolName ?? null) as string | null,
    notificationType: (v.notificationType ?? null) as string | null, processPid: pid as number | null, processIdentity: identity as string | null };
}
function ensureRun(store: Storage, event: RuntimeEvent): string {
  let root = store.db.prepare("SELECT id FROM run WHERE device_id=? AND provider_id='claude-code' AND native_session_id=? AND parent_run_id IS NULL").get(store.deviceId, event.sessionId) as {id: string} | undefined;
  if (!root) {
    root = { id: randomUUID() };
    store.db.prepare("INSERT INTO run(id,device_id,provider_id,native_session_id) VALUES(?,?,'claude-code',?)").run(root.id, store.deviceId, event.sessionId);
  }
  if (!event.agentId) return root.id;
  // Hooks send the bare agent id; a transcript-derived child (agent-<id>, <wf>/agent-<id>) is the same run.
  const agent = hookAgentId(event.agentId);
  const children = (store.db.prepare("SELECT id,native_agent_id FROM run WHERE device_id=? AND provider_id='claude-code' AND native_session_id=? AND parent_run_id=?")
    .all(store.deviceId, event.sessionId, root.id) as { id: string; native_agent_id: string }[]).filter(row => hookAgentId(row.native_agent_id) === agent);
  const transcript = children.filter(row => !isHookOnlyAgentId(row.native_agent_id));
  const child = transcript.length === 1 ? transcript[0] : children.find(row => row.native_agent_id === event.agentId);
  if (child) return child.id;
  const id = randomUUID();
  store.db.prepare("INSERT INTO run(id,device_id,provider_id,native_session_id,native_agent_id,parent_run_id) VALUES(?,?,'claude-code',?,?,?)").run(id, store.deviceId, event.sessionId, event.agentId, root.id);
  return id;
}
export function recordRuntimeEvent(store: Storage, input: unknown, now = Date.now()): { accepted: boolean; runId: string } {
  const event = validateRuntimeEvent(input, now);
  return store.transaction(() => {
    const duplicate = store.db.prepare("SELECT run_id FROM runtime_observation WHERE id=?").get(event.eventId) as {run_id: string} | undefined;
    if (duplicate) return { accepted: false, runId: duplicate.run_id };
    const runId = ensureRun(store, event);
    store.db.prepare(`INSERT INTO runtime_observation(id,run_id,event_name,observed_at,tool_name,notification_type,process_pid,process_identity) VALUES(?,?,?,?,?,?,?,?)`).run(event.eventId, runId, event.eventName, event.observedAt, event.toolName, event.notificationType, event.processPid, event.processIdentity);
    if (event.processPid !== null) {
      // A later resumed session may legitimately acquire a new process identity.
      store.db.prepare(`INSERT INTO runtime_process(run_id,pid,identity,identity_event_at,state,observed_at,reason) VALUES(?,?,?,?,'unknown',?,'unavailable')
        ON CONFLICT(run_id) DO UPDATE SET pid=excluded.pid,identity=excluded.identity,identity_event_at=excluded.identity_event_at,state='unknown',observed_at=excluded.observed_at,reason='unavailable'
        WHERE excluded.identity_event_at >= runtime_process.identity_event_at`).run(runId, event.processPid, event.processIdentity, event.observedAt, event.observedAt);
    }
    return { accepted: true, runId };
  });
}
interface RunRow { id: string; provider_id: string; native_session_id: string; native_agent_id: string | null; parent_run_id: string | null; project_id: string | null; project_label: string | null }
interface EventRow { id: string; event_name: RuntimeEventName; observed_at: bigint; tool_name: string | null; notification_type: string | null; process_pid: bigint | null; process_identity: string | null }
interface ProcessRow { run_id: string; pid: bigint; identity: string; state: RuntimeProcessProbe["state"]; observed_at: bigint; reason: RuntimeProcessProbe["reason"] }
export async function listRuntimeRuns(store: Storage, options: { now?: number; probe?: typeof probeProcess; staleAfterMs?: number; hookConfigured?: boolean } = {}): Promise<RuntimeReport> {
  const now = options.now ?? Date.now();
  const limit = RUNTIME_DEFAULTS.listLimit;
  const rows = store.db.prepare(`SELECT r.id,r.provider_id,r.native_session_id,r.native_agent_id,r.parent_run_id,w.project_id,p.label AS project_label
    FROM run r LEFT JOIN workspace w ON w.id=r.workspace_id LEFT JOIN project p ON p.id=w.project_id
    LEFT JOIN (SELECT run_id,MAX(observed_at) observed FROM runtime_observation GROUP BY run_id) o ON o.run_id=r.id
    LEFT JOIN (SELECT run_id,MAX(snapshot_at) snapshot FROM usage_record WHERE run_id IS NOT NULL GROUP BY run_id) u ON u.run_id=r.id
    ORDER BY MAX(COALESCE(o.observed,0),COALESCE(u.snapshot,0)) DESC,r.rowid DESC,r.id LIMIT ?`).all(limit) as RunRow[];
  const processes = store.db.prepare("SELECT * FROM runtime_process").all() as ProcessRow[];
  const selected = new Set(rows.flatMap(row => [row.id, row.parent_run_id].filter(Boolean)));
  const probes = new Map<string, RuntimeProcessProbe>();
  const probeCache = new Map<string, Promise<RuntimeProcessProbe>>();
  // Same CLI process may own many subagents; probe each identity just once per read.
  await Promise.all(processes.filter(row => selected.has(row.run_id)).map(async row => {
    const key = `${row.pid}:${row.identity}`;
    let pending = probeCache.get(key);
    if (!pending) { pending = (options.probe ?? probeProcess)(Number(row.pid), row.identity, now); probeCache.set(key, pending); }
    probes.set(row.run_id, await pending);
  }));
  store.transaction(() => {
    for (const [runId, probe] of probes) store.db.prepare("UPDATE runtime_process SET state=?,observed_at=?,reason=? WHERE run_id=?").run(probe.state, probe.observedAt, probe.reason, runId);
  });
  const staleAfterMs = options.staleAfterMs ?? runtimeStaleAfterMs();
  // L2 remains readable on its schema; L3 adds explicit user-created work names.
  const workNames = new Map<string, { id: string; title: string }[]>();
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_run_link'").get()) {
    const links = store.db.prepare("SELECT l.run_id,w.id,w.title FROM work_run_link l JOIN work_item w ON w.id=l.work_id ORDER BY l.linked_at,w.id").all() as { run_id: string; id: string; title: string }[];
    for (const link of links) if (selected.has(link.run_id)) { const names = workNames.get(link.run_id) ?? []; names.push({ id: link.id, title: link.title }); workNames.set(link.run_id, names); }
  }
  const runs: RuntimeRun[] = rows.map(row => {
    const observation = store.db.prepare("SELECT * FROM runtime_observation WHERE run_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1").get(row.id) as EventRow | undefined;
    // A permission_prompt Notification carries no tool name; the pending tool is the run's latest PermissionRequest.
    const pendingTool = observation?.event_name === "Notification" && observation.notification_type === "permission_prompt" && observation.tool_name === null
      ? (store.db.prepare("SELECT tool_name FROM runtime_observation WHERE run_id=? AND event_name='PermissionRequest' AND observed_at<=? ORDER BY observed_at DESC,rowid DESC LIMIT 1").get(row.id, observation.observed_at) as { tool_name: string | null } | undefined)?.tool_name ?? null
      : observation?.tool_name ?? null;
    const event: RuntimeEvent | null = observation ? { eventId: observation.id, sessionId: row.native_session_id, agentId: row.native_agent_id,
      eventName: observation.event_name, observedAt: Number(observation.observed_at), toolName: pendingTool, notificationType: observation.notification_type,
      processPid: observation.process_pid === null ? null : Number(observation.process_pid), processIdentity: observation.process_identity } : null;
    const state = deriveRuntimeState(event, probes.get(row.id) ?? (row.parent_run_id ? probes.get(row.parent_run_id) : undefined) ?? null, now, staleAfterMs);
    // Codex activity is read from its rollout log by the ingestor, not received from a hook.
    if (row.provider_id !== "claude-code") state.evidence = state.evidence.map(item => item.replace(/^hook:/, "rollout:"));
    return { runId: row.id, providerId: row.provider_id, sessionId: row.native_session_id, agentId: row.native_agent_id, parentRunId: row.parent_run_id,
      projectId: row.project_id, projectLabel: row.project_label, workItems: workNames.get(row.id) ?? [], ...state };
  });
  const total = Number((store.db.prepare("SELECT COUNT(*) count FROM run").get() as { count: bigint }).count);
  return { asOf: now, hookConfigured: options.hookConfigured ?? resolveRuntimeHookToken().token !== null, staleAfterMs, runs, total, truncated: total > limit, interventionCount: runs.filter(run => run.interventionRequired).length };
}
export function handleRuntimeRequest(store: Storage, method: string, payload: unknown): unknown | Promise<unknown> {
  if (method === "runtime.record") return recordRuntimeEvent(store, payload);
  if (method === "runtime.list") return listRuntimeRuns(store);
  throw new CollectorError("unknown_runtime_method");
}
