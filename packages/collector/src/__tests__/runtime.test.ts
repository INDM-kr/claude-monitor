import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import type { RuntimeEvent, RuntimeProcessProbe } from "@claude-monitor/core";
import { openStorage, type Storage } from "../storage.js";
import { runtimeMigration } from "../runtime-schema.js";
import { listRuntimeRuns, recordRuntimeEvent, validateRuntimeEvent } from "../runtime.js";
import { processIdentity, probeProcess } from "../runtime-process.js";
import { applyLocalMutation } from "../local-work.js";
import { testConfig } from "./helpers.js";
const dirs: string[] = [], stores: Storage[] = [];
async function store() { const c = testConfig(); dirs.push(c.dataDir); const s = await openStorage(c); if (!s.db.prepare("SELECT name FROM sqlite_master WHERE name='runtime_observation'").get()) runtimeMigration.up(s.db); stores.push(s); return s; }
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const now = 1_000_000;
const event = (values: Partial<RuntimeEvent> = {}): RuntimeEvent => ({ eventId: "e1", sessionId: "s1", agentId: null, eventName: "PreToolUse", observedAt: now, toolName: "Bash", notificationType: null, processPid: null, processIdentity: null, ...values });
const alive = async (_pid: number, _id: string, at: number): Promise<RuntimeProcessProbe> => ({ state: "alive", reason: "matched", observedAt: at });
describe("persisted runtime observations", () => {
  it("deduplicates events and rejects raw content or malformed identity/time", async () => {
    const s = await store(); expect(recordRuntimeEvent(s, event(), now).accepted).toBe(true); expect(recordRuntimeEvent(s, event(), now).accepted).toBe(false);
    expect(() => validateRuntimeEvent({ ...event(), prompt: "must never persist" }, now)).toThrow("invalid_runtime_event");
    expect(() => validateRuntimeEvent(event({ observedAt: now + 1001 }), now)).toThrow("invalid_runtime_event_time");
    expect(() => validateRuntimeEvent(event({ processPid: 2 }), now)).toThrow("invalid_runtime_process");
    const report = await listRuntimeRuns(s, { now }); expect(report.runs).toHaveLength(1); expect(report.runs[0].processState).toBe("unknown");
  });
  it("keeps parent/child separate and ignores late old event for current activity", async () => {
    const s = await store(); const parent = recordRuntimeEvent(s, event(), now);
    recordRuntimeEvent(s, event({ eventId: "e2", agentId: "child", eventName: "Notification", notificationType: "permission_prompt" }), now);
    recordRuntimeEvent(s, event({ eventId: "late", eventName: "Stop", observedAt: now - 1 }), now);
    const report = await listRuntimeRuns(s, { now }); const child = report.runs.find(r => r.agentId)!;
    expect(child.parentRunId).toBe(parent.runId); expect(child.interventionRequired).toBe(true);
    expect(report.runs.find(r => !r.agentId)!.lastEventName).toBe("PreToolUse");
  });
  it("shows a question as input wait when its permission prompt carries no tool name (real 2.1.282 order)", async () => {
    const s = await store();
    recordRuntimeEvent(s, event({ eventId: "q1", toolName: "AskUserQuestion", observedAt: now - 3000 }), now);
    recordRuntimeEvent(s, event({ eventId: "q2", eventName: "PermissionRequest", toolName: "AskUserQuestion", observedAt: now - 2900 }), now);
    recordRuntimeEvent(s, event({ eventId: "q3", eventName: "Notification", toolName: null, notificationType: "permission_prompt", observedAt: now - 100 }), now);
    const question = (await listRuntimeRuns(s, { now })).runs[0];
    expect(question).toMatchObject({ activityState: "input_wait", interventionRequired: true, lastEventName: "Notification", lastToolName: "AskUserQuestion" });
    const t = await store();
    recordRuntimeEvent(t, event({ eventId: "b1", eventName: "PermissionRequest", toolName: "Bash", observedAt: now - 2900 }), now);
    recordRuntimeEvent(t, event({ eventId: "b2", eventName: "Notification", toolName: null, notificationType: "permission_prompt", observedAt: now - 100 }), now);
    expect((await listRuntimeRuns(t, { now })).runs[0]).toMatchObject({ activityState: "approval_wait", interventionRequired: true });
  });
  it("joins hook events for a subagent to the transcript child run of the same agent", async () => {
    const s = await store(); const root = recordRuntimeEvent(s, event(), now).runId;
    s.db.prepare("INSERT INTO run VALUES('ledger-plain',?,'claude-code','s1','agent-a1b2','" + root + "',NULL)").run(s.deviceId);
    s.db.prepare("INSERT INTO run VALUES('ledger-flow',?,'claude-code','s1','wf_x/agent-c3d4','" + root + "',NULL)").run(s.deviceId);
    expect(recordRuntimeEvent(s, event({ eventId: "p", agentId: "a1b2", eventName: "SubagentStart" }), now).runId).toBe("ledger-plain");
    expect(recordRuntimeEvent(s, event({ eventId: "f", agentId: "c3d4", eventName: "SubagentStart" }), now).runId).toBe("ledger-flow");
    const fresh = recordRuntimeEvent(s, event({ eventId: "n", agentId: "e5f6", eventName: "SubagentStart" }), now).runId;
    expect(recordRuntimeEvent(s, event({ eventId: "n2", agentId: "e5f6", eventName: "SubagentStop" }), now).runId).toBe(fresh);
    expect((s.db.prepare("SELECT count(*) n FROM run").get() as { n: bigint }).n).toBe(4n);
  });
  it("keeps an ambiguous agent id separate instead of guessing between workflow runs", async () => {
    const s = await store(); const root = recordRuntimeEvent(s, event(), now).runId;
    for (const [id, agent] of [["wf-a", "wf_a/agent-dup"], ["wf-b", "wf_b/agent-dup"]]) s.db.prepare("INSERT INTO run VALUES(?,?,'claude-code','s1',?,?,NULL)").run(id, s.deviceId, agent, root);
    const runId = recordRuntimeEvent(s, event({ eventId: "d", agentId: "dup", eventName: "SubagentStart" }), now).runId;
    expect(["wf-a", "wf-b"]).not.toContain(runId);
  });
  it("orders hookless runs by latest usage snapshot even when the newest run has an older rowid", async () => {
    const s=await store();
    for (const [runId,at] of [["zzz-newer",now],["aaa-older",now-1000]] as const) {
      s.db.prepare("INSERT INTO run(id,device_id,provider_id,native_session_id) VALUES(?,?,'claude-code',?)").run(runId,s.deviceId,runId);
      s.db.prepare(`INSERT INTO usage_record(id,device_id,provider_id,response_id,run_id,model,first_event_at,snapshot_at,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,validity,cost_eligibility,parser_version)
        VALUES(?,?,'claude-code',?,?,'fixture-model',?,?,0,0,0,0,'valid','eligible','fixture')`).run(runId,s.deviceId,runId,runId,at,at);
    }
    const report=await listRuntimeRuns(s,{now});
    expect(report.runs.map(run=>run.runId)).toEqual(["zzz-newer","aaa-older"]);
    expect(report.runs.every(run=>run.freshness==="unsupported" && run.activityState==="unknown")).toBe(true);
  });
  it("shows a manually linked stable work title without inventing it from log text", async () => {
    const s=await store(); const recorded=recordRuntimeEvent(s,event(),now);
    const work=applyLocalMutation(s.db,"work.create",{title:"검증된 프로젝트 보고서"},now) as {id:string};
    applyLocalMutation(s.db,"work.linkRun",{id:work.id,runId:recorded.runId},now);
    const result=await listRuntimeRuns(s,{now}); expect(result.runs[0].workItems).toEqual([{id:work.id,title:"검증된 프로젝트 보고서"}]);
    expect(result.runs[0].outcome).toBe("unknown");
  });
  it("survives reopen and separates liveness from stale activity", async () => {
    const s = await store(); recordRuntimeEvent(s, event({ processPid: 42, processIdentity: "a".repeat(64) }), now);
    const fresh = await listRuntimeRuns(s, { now, probe: alive }); expect(fresh.runs[0].processState).toBe("alive");
    const c = testConfig(); // reuse the original DB while discarding the helper's unused directory
    rmSync(c.dataDir, { recursive: true, force: true }); c.dataDir = dirs[0]; s.close();
    const reopened = await openStorage(c); stores.push(reopened);
    const stale = await listRuntimeRuns(reopened, { now: now + 120_001, probe: alive });
    expect(stale.runs[0]).toMatchObject({ freshness: "stale", processState: "alive", activityState: "unknown", outcome: "unknown" });
  });
  it("accepts resumed process identity even after a newer observation probe", async () => {
    const s = await store(); recordRuntimeEvent(s, event({ processPid: 42, processIdentity: "a".repeat(64) }), now);
    await listRuntimeRuns(s, { now: now + 100, probe: alive });
    recordRuntimeEvent(s, event({ eventId: "resume", eventName: "SessionStart", observedAt: now + 50, processPid: 43, processIdentity: "b".repeat(64) }), now + 100);
    expect(s.db.prepare("SELECT pid FROM runtime_process").get()).toEqual({ pid: 43n });
  });
  it("maps an unavailable process probe to unknown rather than exit", async () => {
    const path = process.env.PATH;
    try { process.env.PATH = "/nonexistent-runtime-test-bin";
      expect(await probeProcess(process.pid, "0".repeat(64), now)).toMatchObject({ state: "unknown", reason: "probe_failed" });
    } finally { process.env.PATH = path; }
  });
  it("probes an owned OS process and distinguishes alive, PID reuse, forced exit", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); await once(child, "spawn");
    try {
      const raw = execFileSync("ps", ["-p", String(child.pid), "-o", "lstart=", "-o", "comm="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
      expect(await probeProcess(child.pid!, processIdentity(raw), now)).toMatchObject({ state: "alive", reason: "matched" });
      expect(await probeProcess(child.pid!, "0".repeat(64), now)).toMatchObject({ state: "exited", reason: "identity_changed" });
      const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
      expect(await probeProcess(child.pid!, processIdentity(raw), now)).toMatchObject({ state: "exited", reason: "missing" });
    } finally { child.kill("SIGKILL"); }
  });
});
