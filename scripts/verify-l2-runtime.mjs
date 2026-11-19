#!/usr/bin/env node
/** Isolated real worker + hook transport + owned process lifecycle. No user settings or logs. */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CollectorController, loadCollectorConfig } from "../packages/collector/dist/index.js";
import { sanitizeHook } from "./runtime-hook.mjs";
const directory = await mkdtemp(join(tmpdir(), "cm-runtime-verify-"));
await mkdir(join(directory, "projects"), { mode: 0o700 });
const previousStale = process.env.CM_RUNTIME_STALE_AFTER_MS;
process.env.CM_RUNTIME_STALE_AFTER_MS = "1000";
const controller = new CollectorController(loadCollectorConfig({ CM_DATA_DIR: join(directory, "db"), CLAUDE_PROJECTS_DIR: join(directory, "projects"), CM_ENABLE_CODEX: "0", CM_TIMEZONE: "Asia/Seoul" }));
const checks = [], samples = [];
const owned = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
let server;
const record = async event => controller.request("runtime.record", event);
const read = async () => controller.request("runtime.list");
try {
  await once(owned, "spawn");
  assert.equal((await controller.start()).state, "ready");
  const identity = createHash("sha256").update(execFileSync("ps", ["-p", String(owned.pid), "-o", "lstart=", "-o", "comm="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim()).digest("hex");
  const make = (eventName, extra = {}) => ({ eventId: randomUUID(), sessionId: "verification-session", agentId: null, eventName, observedAt: Date.now(), toolName: null, notificationType: null, processPid: owned.pid, processIdentity: identity, ...extra });
  const raw = { session_id: "transport-session", hook_event_name: "PreToolUse", tool_name: "Bash", prompt: "PRIVATE-FIXTURE", tool_input: { command: "PRIVATE-FIXTURE" }, transcript_path: "/private/fixture" };
  assert(!JSON.stringify(sanitizeHook(raw)).includes("PRIVATE")); assert(!JSON.stringify(sanitizeHook(raw)).includes("/private"));
  checks.push("hook_allowlist_excludes_prompt_tool_input_and_paths");
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer owned-test-token");
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const event = JSON.parse(Buffer.concat(chunks).toString()); assert(!JSON.stringify(event).includes("PRIVATE"));
      await record(event); response.writeHead(200, { "content-type": "application/json" }); response.end('{"accepted":true}');
    } catch { response.writeHead(500); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const hookResult = await new Promise((resolve, reject) => {
    const hook = execFile(process.execPath, [new URL("./runtime-hook.mjs", import.meta.url).pathname], { env: { ...process.env, CM_RUNTIME_HOOK_TOKEN: "owned-test-token", CM_RUNTIME_ENDPOINT: `http://127.0.0.1:${server.address().port}` } }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    hook.stdin.end(JSON.stringify(raw));
  });
  assert.equal(hookResult.stdout, ""); assert.equal(hookResult.stderr, ""); assert((await read()).runs.some(run => run.sessionId === "transport-session"));
  checks.push("real_hook_process_delivers_whitelisted_event_without_decision_output");
  await record(make("Notification", { notificationType: "permission_prompt" }));
  let report = await read(); let run = report.runs.find(run => run.sessionId === "verification-session");
  assert.equal(run.processState, "alive"); assert.equal(run.interventionRequired, true);
  await delay(1100); run = (await read()).runs.find(run => run.sessionId === "verification-session");
  assert.equal(run.processState, "alive"); assert.equal(run.freshness, "stale"); assert.equal(run.interventionRequired, false);
  checks.push("permission_wait_expires_without_killing_long_running_process");
  await record(make("PreToolUse", { toolName: "AskUserQuestion" })); assert.equal((await read()).runs.find(run => run.sessionId === "verification-session").interventionRequired, true);
  await record(make("PostToolUse", { toolName: "AskUserQuestion" })); assert.equal((await read()).runs.find(run => run.sessionId === "verification-session").interventionRequired, false);
  await record(make("Stop")); assert.equal((await read()).runs.find(run => run.sessionId === "verification-session").outcome, "response_ended");
  await record(make("SessionEnd")); assert.equal((await read()).runs.find(run => run.sessionId === "verification-session").outcome, "session_ended");
  checks.push("input_answer_and_session_end_do_not_claim_work_success");
  for (let i = 0; i < 20; i++) { const event = make("UserPromptSubmit"); const started = performance.now(); await record(event); assert.equal((await read()).runs.find(run => run.sessionId === "verification-session").lastEventAt, event.observedAt); samples.push(performance.now() - started); }
  checks.push("twenty_worker_event_to_query_samples");
  const end = once(owned, "exit"); owned.kill("SIGKILL"); await end;
  run = (await read()).runs.find(run => run.sessionId === "verification-session"); assert.equal(run.processState, "exited"); assert.equal(run.outcome, "unknown"); assert.equal(run.interventionRequired, false);
  checks.push("forced_exit_detected_without_fabricating_outcome");
  const before = (await read()).runs.map(run => run.runId).sort(); await controller.stop(); assert.equal((await controller.start()).state, "ready");
  assert.deepEqual((await read()).runs.map(run => run.runId).sort(), before);
  checks.push("observations_survive_actual_worker_restart");
  const result = { verifiedAt: new Date().toISOString(), passed: true, checks, eventToQuery: { samples: samples.length, p95Ms: Number(samples.sort((a,b)=>a-b)[Math.ceil(samples.length*.95)-1].toFixed(2)), scope: "isolated worker RPC, excludes UI polling and provider delivery" }, limitations: ["User Claude hook settings untouched; live Claude hook enrollment not verified", "14 day operation and sleep/wake not completed", "Browser UI tested separately"] };
  await writeFile(new URL("../docs/specs/evidence/l2-runtime.json", import.meta.url), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2));
} finally {
  await controller.stop(); owned.kill("SIGKILL"); if (server) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  if (previousStale === undefined) delete process.env.CM_RUNTIME_STALE_AFTER_MS; else process.env.CM_RUNTIME_STALE_AFTER_MS = previousStale;
}
