#!/usr/bin/env node
/** Fresh dependencies from an allowlisted source copy on this Mac; never installs home launchers. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await readFile(new URL("./verify-local-clean-install.config.json", import.meta.url), "utf8"));
const prepareOnly = process.argv.includes("--prepare-only");
const reportFile = join(root, "docs/specs/evidence/local-clean-install.json");
const scratch = await mkdtemp(join(tmpdir(), "cm-clean-install-"));
await chmod(scratch, 0o700);
const checkout = join(scratch, "source"), projects = join(scratch, "projects"), dataDir = join(scratch, "data");
const children = new Set(), checks = [], durations = {}, copied = [];
const startedAt = Date.now(); let cancelled = false; let failedStep = "copy_source", result;
const environment = {
  ...process.env, CI: "true", NEXT_TELEMETRY_DISABLED: "1", COREPACK_ENABLE_NETWORK: "0",
  CM_DATA_DIR: dataDir, CLAUDE_PROJECTS_DIR: projects, CM_ENABLE_CODEX: "0", CM_COLLECTOR_ENABLED: "true",
  CM_BEARER_TOKEN: "", CM_RUNTIME_HOOK_TOKEN: "", CM_REMOTE_USAGE_ENABLED: "false", HOSTNAME: config.bindHost,
};
// Deliberately do not change HOME, CODEX_HOME, or any user's installation paths.
function forbidden(name) { return name.startsWith(".") || config.excludedNames.includes(name) || name.endsWith(".tsbuildinfo"); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function copySource(rel, optional = false) {
  const source = resolve(root, rel), target = resolve(checkout, rel);
  if (!source.startsWith(root) || !(target + sep).startsWith(checkout + sep)) throw new Error("source_path_outside_allowlist");
  if (!(await exists(source))) { if (optional) return; throw new Error(`required_source_missing:${rel}`); }
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`source_not_regular:${rel}`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target); await chmod(target, stat.mode & 0o111 ? 0o700 : 0o600);
  const digest = createHash("sha256").update(await readFile(target)).digest("hex");
  copied.push({ path: rel, bytes: stat.size, sha256: digest });
}
async function copyTree(rel, extensions) {
  const source = join(root, rel);
  if (!(await exists(source))) return;
  if ((await lstat(source)).isSymbolicLink()) throw new Error(`source_directory_is_symlink:${rel}`);
  await mkdir(join(checkout, rel), { recursive: true, mode: 0o700 });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (forbidden(entry.name)) continue;
    const path = join(rel, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`source_entry_is_symlink:${path}`);
    if (entry.isDirectory()) await copyTree(path, extensions);
    else if (entry.isFile() && extensions.includes(extname(entry.name))) await copySource(path);
  }
}
function owned(command, args, extraEnv = {}) {
  if (cancelled) throw new Error("verification_cancelled");
  const child = spawn(command, args, { cwd: checkout, env: { ...environment, ...extraEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const record = { child, output: "", done: false, code: null, signal: null, error: null };
  record.closed = new Promise(resolve => {
    child.once("error", error => { record.error = error; });
    child.once("close", (code, signal) => { record.done = true; record.code = code; record.signal = signal; children.delete(record); resolve(); });
  });
  const output = chunk => { record.output = (record.output + chunk.toString()).slice(-config.logLimitBytes); };
  child.stdout.on("data", output); child.stderr.on("data", output); children.add(record); return record;
}
async function terminate(record) {
  if (record.done) return;
  try { process.kill(-record.child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await Promise.race([record.closed, delay(config.shutdownTimeoutMs, undefined, { ref: false })]);
  if (!record.done) { try { process.kill(-record.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } await record.closed; }
}
function cancel() { cancelled = true; void Promise.all([...children].map(terminate)); }
process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
function safeLog(value) {
  return value.replaceAll(scratch, "<temporary>").replaceAll(root, "<source>").replaceAll(homedir(), "<home>")
    .replace(/(authorization\s*[:=]\s*|Bearer\s+)\S+/ig, "$1<redacted>").split("\n").slice(-35).join("\n");
}
async function command(stage, args, timeout) {
  failedStep = stage; console.log(`[clean-install] ${stage}`); const start = Date.now();
  const process = owned("pnpm", args);
  await Promise.race([process.closed, delay(timeout, undefined, { ref: false })]);
  if (!process.done) { await terminate(process); throw new Error(`${stage}_timeout`); }
  durations[stage] = Date.now() - start;
  if (process.code !== 0) { console.error(safeLog(process.output)); throw new Error(`${stage}_failed:${process.error?.code ?? process.code ?? process.signal}`); }
  return process.output;
}
async function freePort() {
  const socket = createServer(); socket.listen(0, config.bindHost); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function waitFor(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(config.pollMs); }
  throw new Error("startup_timeout");
}
try {
  await mkdir(checkout, { mode: 0o700 }); await mkdir(projects, { mode: 0o700 });
  for (const file of config.rootFiles) await copySource(file);
  for (const name of config.packages) {
    for (const file of config.packageFiles) await copySource(`packages/${name}/${file}`);
    for (const directory of config.codeDirectories) await copyTree(`packages/${name}/${directory}`, config.sourceExtensions);
  }
  for (const file of config.webFiles) await copySource(`packages/web/${file}`);
  await copyTree("scripts", config.scriptExtensions);
  for (const path of ["node_modules", ".git", ".scratch", "packages/web/.next", ...config.packages.map(name => `packages/${name}/dist`)]) assert.equal(await exists(join(checkout, path)), false);
  assert(copied.some(file => file.path === "packages/collector/src/runtime.ts"));
  assert(copied.some(file => file.path === "packages/web/app/work/page.tsx"));
  checks.push("allowlisted_working_tree_source_includes_new_files_without_dependencies_build_outputs_or_private_files");
  const sourceDigest = createHash("sha256").update(JSON.stringify(copied.sort((a,b) => a.path.localeCompare(b.path)))).digest("hex");
  if (cancelled) throw new Error("verification_cancelled");
  if (prepareOnly) {
    result = { status: "prepared_only", sourceFiles: copied.length, sourceBytes: copied.reduce((sum,file)=>sum+file.bytes,0), sourceDigest, checks, heavyweightCommandsExecuted: false };
  } else {
    await command("offline_frozen_install", ["install", "--offline", "--frozen-lockfile"], config.installTimeoutMs);
    checks.push("new_checkout_installs_dependencies_offline_with_frozen_lockfile");
    await command("production_build", ["build"], config.buildTimeoutMs);
    checks.push("all_workspace_packages_and_next_production_build_from_fresh_dependencies");
    failedStep = "production_start";
    const schema = await import(pathToFileURL(join(checkout, "packages/collector/dist/schema.js")).href);
    const expectedSchema = schema.migrations.at(-1).version;
    const port = await freePort(), base = `http://${config.bindHost}:${port}`;
    const server = owned(process.execPath, ["scripts/web.mjs", "start"], { PORT: String(port) });
    const startTime = Date.now();
    await waitFor(() => { if (server.done) { console.error(safeLog(server.output)); throw new Error("server_closed_before_ready"); } return server.output.includes("[web] start listening"); }, config.startupTimeoutMs);
    const get = async path => { const response = await fetch(base + path, { signal: AbortSignal.timeout(config.requestTimeoutMs) }); assert.equal(response.status, 200); return response.json(); };
    const status = await waitFor(async () => { const value = await get("/api/collector"); return value.state === "ready" && value.ingestionState === "watching" && value; }, config.startupTimeoutMs);
    assert.equal(status.schemaVersion, expectedSchema); assert(status.workerId > 0); assert.equal(status.sourceCount, 0);
    const report = await get("/api/reports/usage?period=7"); assert.equal(report.total.total, "0"); assert.equal(report.total.requests, 0);
    assert.equal((await get("/api/work-items")).items.length, 0); assert.equal((await get("/api/runs")).runs.length, 0);
    assert.equal((await get("/api/usage")).source, "estimate");
    for (const path of ["/", "/overview", "/usage", "/runs", "/work", "/settings", "/sessions"]) assert.equal((await fetch(base + path, { signal: AbortSignal.timeout(config.requestTimeoutMs) })).status, 200);
    durations.production_start_and_api = Date.now() - startTime;
    checks.push("production_start_loads_native_sqlite_worker_latest_schema_and_empty_local_apis");
    checks.push("overview_usage_runs_work_settings_and_legacy_sessions_render_successfully");
    failedStep = "graceful_shutdown"; await terminate(server);
    assert.equal(server.code, 0); assert(server.output.includes("[collector] stopped")); assert(!server.output.includes("shutdown_timeout"));
    checks.push("owned_production_process_shuts_down_cleanly");
    result = { capturedAt: new Date().toISOString(), status: "pass", environment: { platform: process.platform, arch: process.arch, node: process.version },
      schemaVersion: expectedSchema, sourceFiles: copied.length, sourceBytes: copied.reduce((sum,file)=>sum+file.bytes,0), sourceDigest,
      elapsedMs: Date.now() - startedAt, durations, checks,
      serverEntry: "node scripts/web.mjs start (canonical owner; pnpm wrapper lifecycle verified separately)",
      scope: "Private temporary working-tree source checkout on the current Mac; fresh node_modules using this machine's offline pnpm cache and installed build tools. No original source build output reused.",
      limitations: ["Not a fresh Mac or cache-free dependency download test", "Home application installer, launchers and LaunchAgent were not executed", "Actual user Claude logs and settings were not used", "14-day usage and sleep/wake remain separate gates"] };
  }
} catch (error) {
  result = { capturedAt: new Date().toISOString(), status: "failed", failedStep, reason: safeLog(error.message), checks, durations, scope: "Owned temporary clean-install verification" };
  process.exitCode = 1;
} finally {
  for (const record of [...children]) await terminate(record);
  await rm(scratch, { recursive: true, force: true });
  process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
}
result.cleanup = "owned_processes_stopped_and_temporary_source_dependencies_and_data_removed";
if (!prepareOnly) { await mkdir(dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(result, null, 2) + "\n"); }
console.log(JSON.stringify(result, null, 2));
