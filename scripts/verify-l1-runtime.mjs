#!/usr/bin/env node
// Build first. Exercises owned local servers and temporary data only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { checkRuntime } from "./check-runtime.mjs";
import { migrations } from "../packages/collector/dist/schema.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "cm-runtime-test-"));
const reportFile = resolve(process.argv[2] || "docs/specs/evidence/local-runtime-integration.json");
const checks = [], servers = [];
const requireCollector = createRequire(new URL("../packages/collector/package.json", import.meta.url));
const Database = requireCollector("better-sqlite3");
const testProjects = join(scratch, "projects"), testBin = join(scratch, "bin");
mkdirSync(testProjects); mkdirSync(testBin);
// Existing usage UI stays local during smoke testing; do not read a real Keychain token.
const keychainMarker = join(scratch, "unexpected-keychain-call");
writeFileSync(join(testBin, "security"), '#!/bin/sh\nprintf x >> "$CM_TEST_SECURITY_CALLS"\nexit 1\n', { mode: 0o700 });
const modulePath = join(root, "packages/web/lib/collector.ts");
const originalModule = readFileSync(modulePath, "utf8");
let touchedModule = false;

async function until(fn, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; }
    catch (error) { if (error.fatal) throw error; last = error; }
    await delay(100);
  }
  throw new Error(`runtime verification timeout${last ? ` (${last.message})` : ""}`);
}

async function freePort() {
  const probe = createServer();
  await new Promise((done, fail) => { probe.once("error", fail); probe.listen(0, "127.0.0.1", done); });
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  return port;
}

async function start(mode, dataDir, extra = {}) {
  const port = await freePort();
  const child = spawn("pnpm", [mode], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", CM_DATA_DIR: dataDir,
    CLAUDE_PROJECTS_DIR: testProjects, CM_ENABLE_CODEX: "0", CM_COLLECTOR_ENABLED: "true", CM_BEARER_TOKEN: "",
    CM_REMOTE_USAGE_ENABLED: "false", CM_RUNTIME_HOOK_TOKEN: "", CM_TEST_SECURITY_CALLS: keychainMarker,
    PATH: `${testBin}:${process.env.PATH}`, ...extra,
  } });
  const server = { child, logs: "", closed: false, base: `http://127.0.0.1:${port}` };
  servers.push(server);
  child.stdout.on("data", d => { server.logs += d.toString(); });
  child.stderr.on("data", d => { server.logs += d.toString(); });
  child.on("error", error => { server.logs += error.message; });
  server.close = new Promise(done => child.once("close", () => { server.closed = true; done(); }));
  await until(() => {
    if (server.closed) throw Object.assign(new Error(`owned server stopped before readiness: ${server.logs}`), { fatal: true });
    return server.logs.includes(`[web] ${mode} listening`);
  });
  return server;
}

async function get(server, path, headers) {
  const response = await fetch(server.base + path, { headers, signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
}

async function stop(server) {
  if (server.closed) return;
  process.kill(-server.child.pid, "SIGTERM");
  await until(() => server.closed, 15000);
  assert(server.logs.includes("[collector] stopped") || server.logs.includes("[collector] disabled") || server.logs.includes("[collector] error writer_busy"), `owned server shutdown log missing: ${server.logs}`);
  assert(!server.logs.includes("shutdown_timeout"), "shutdown deadline not exceeded");
}

try {
  checkRuntime("24.11.0", "10.28.2");
  for (const version of ["18.20.0", "22.1.0", "24.10.9", "25.0.0"]) assert.throws(() => checkRuntime(version, "10.28.2"), /Node/);
  assert.throws(() => checkRuntime("24.11.0", "9.0.0"), /pnpm/);
  checks.push("runtime guard accepts the declared versions and rejects unsupported Node/pnpm");

  const data = join(scratch, "data");
  const first = await start("start", data);
  assert(existsSync(join(data, "usage.sqlite")), "DB opens before first HTTP request");
  const status = await until(async () => { const value = (await get(first, "/api/collector")).body; return value.state === "ready" && value.ingestionState === "watching" && value; });
  assert.equal(status.state, "ready"); assert.equal(status.ingestionState, "watching");
  assert.equal(status.schemaVersion, migrations.at(-1).version); assert(status.workerId > 0);
  assert(!JSON.stringify(status).includes(scratch));
  const db = new Database(join(data, "usage.sqlite"), { readonly: true });
  assert.equal(db.prepare("SELECT count(*) n FROM usage_record").get().n, 0); db.close();
  checks.push("pnpm start opens latest schema and compiled worker; empty isolated source reaches watching");
  const health = await get(first, "/api/health"); assert.equal(health.status, 200); assert.equal(health.body.collector.state, "ready");
  assert.equal((await fetch(first.base)).status, 200);
  assert.equal((await fetch(first.base + "/overview")).status, 200);
  const legacy = await fetch(first.base + "/sessions?status=live", { redirect: "manual" });
  assert.equal(legacy.status, 307); assert.equal(new URL(legacy.headers.get("location"), first.base).pathname + new URL(legacy.headers.get("location"), first.base).search, "/?status=live");
  assert.equal((await get(first, "/api/usage")).body.source, "estimate");
  assert(!existsSync(keychainMarker), "remote-off never invokes Keychain");
  const report = (await get(first, "/api/reports/usage?period=7")).body;
  assert.equal(report.total.total, "0"); assert.equal(report.quality.state, "watching");
  assert.equal((await get(first, "/api/runs")).body.runs.length, 0);
  assert.equal((await get(first, "/api/sessions")).status, 200);
  checks.push("live monitor at /, overview/report/run pages and legacy /sessions redirect coexist; remote-off skips Keychain");

  const second = await start("start", data);
  assert.equal((await get(second, "/api/collector")).body.diagnostic, "writer_busy");
  assert.equal((await get(second, "/api/sessions")).status, 200);
  await stop(second); await stop(first);
  checks.push("two application instances expose writer conflict while existing session API remains usable");
  const reopened = await start("start", data, { CM_BEARER_TOKEN: "runtime-fixture-token" });
  assert.equal((await get(reopened, "/api/collector")).status, 401);
  const again = (await get(reopened, "/api/collector", { Authorization: "Bearer runtime-fixture-token" })).body;
  assert.equal(again.deviceId, status.deviceId); assert.equal(again.state, "ready");
  await stop(reopened);
  checks.push("SIGTERM releases storage; restart retains device and schema; status API applies Bearer policy");

  const unused = join(scratch, "disabled");
  const disabled = await start("start", unused, { CM_COLLECTOR_ENABLED: "false" });
  assert.equal((await get(disabled, "/api/collector")).body.state, "disabled");
  assert.equal((await fetch(disabled.base + "/")).status, 200); assert(!existsSync(unused));
  await stop(disabled);
  checks.push("collector-off rollback starts the existing app without creating a database");

  const development = await start("dev", join(scratch, "dev-data"));
  const before = (await get(development, "/api/collector")).body; assert.equal(before.state, "ready");
  const hotSocket = new WebSocket(development.base.replace("http:", "ws:") + "/_next/webpack-hmr");
  try {
    await new Promise((done, fail) => {
      const deadline = setTimeout(() => fail(new Error("HMR websocket timeout")), 10000);
      hotSocket.addEventListener("open", () => { clearTimeout(deadline); done(); }, { once: true });
      hotSocket.addEventListener("error", () => { clearTimeout(deadline); fail(new Error("HMR websocket failed")); }, { once: true });
    });
    checks.push("development HMR WebSocket opens through Next's own upgrade handler");
  } finally { hotSocket.close(); }
  touchedModule = true;
  assert(originalModule.includes("return getProcessCollector().status();"));
  writeFileSync(modulePath, originalModule.replace("return getProcessCollector().status();", "return Object.assign(getProcessCollector().status(), { reloadProbe: true });"));
  const after = await until(async () => {
    const r = await get(development, "/api/collector");
    return r.status === 200 && r.body.reloadProbe === true && r.body;
  });
  assert.equal(after.workerId, before.workerId); assert.equal(after.deviceId, before.deviceId);
  assert.equal(after.state, "ready");
  writeFileSync(modulePath, originalModule); touchedModule = false;
  await until(async () => {
    const r = await get(development, "/api/collector");
    return r.status === 200 && !r.body.reloadProbe && r.body.state === "ready";
  });
  await stop(development);
  checks.push("development route recompilation retains one worker and cleanly shuts down");

  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version,
    arch: process.arch, next: createRequire(new URL("../packages/web/package.json", import.meta.url))("next/package.json").version,
    driver: requireCollector("better-sqlite3/package.json").version, status: "pass", checks,
    scope: "Owned pnpm start/dev processes, temporary empty source and isolated DB; latest schema, empty-source scan, legacy local-only usage, native worker and HMR. No real-log performance or 14-day stability claim." }, null, 2) + "\n");
  console.log(`PASS: ${checks.length} runtime checks; ${reportFile}`);
} finally {
  if (touchedModule) writeFileSync(modulePath, originalModule);
  for (const server of servers) if (!server.closed) {
    try { process.kill(-server.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await server.close;
  }
  rmSync(scratch, { recursive: true, force: true });
}
