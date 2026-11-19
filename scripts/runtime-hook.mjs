#!/usr/bin/env node
// Observe only: no stdout and always exit 0, so this hook cannot grant/deny permission.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
const config = JSON.parse(await readFile(new URL("./runtime-hook-config.json", import.meta.url), "utf8"));
const web = JSON.parse(await readFile(new URL("./web-config.json", import.meta.url), "utf8"));
const requireWeb = createRequire(new URL("../packages/web/package.json", import.meta.url));
// Same resolver as the server: CM_RUNTIME_HOOK_TOKEN first, then the private token file in the data directory.
async function hookToken() {
  const { resolveRuntimeHookToken } = await import(pathToFileURL(requireWeb.resolve("@claude-monitor/collector/runtime-token")).href);
  const resolved = resolveRuntimeHookToken(process.env);
  if (resolved.diagnostic) throw new Error(resolved.diagnostic);
  return resolved.token;
}
export function sanitizeHook(input, processInfo = null, observedAt = Date.now()) {
  if (!input || typeof input !== "object" || !config.events.includes(input.hook_event_name)) return null;
  const id = /^[a-zA-Z0-9_.:-]{1,200}$/;
  if (typeof input.session_id !== "string" || !id.test(input.session_id)) return null;
  const safe = value => typeof value === "string" && id.test(value) ? value : null;
  return { eventId: randomUUID(), sessionId: input.session_id, agentId: safe(input.agent_id), eventName: input.hook_event_name,
    observedAt, toolName: safe(input.tool_name), notificationType: safe(input.notification_type),
    processPid: processInfo?.pid ?? null, processIdentity: processInfo?.identity ?? null };
}
export async function findClaudeProcess() {
  let pid = process.ppid;
  for (let i = 0; i < config.maxAncestors && pid > 1; i++) {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "ppid=", "-o", "comm="], { timeout: config.timeoutMs, env: { ...process.env, LC_ALL: "C" } });
    const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return null;
    if (/^claude(?:-code)?$/.test(basename(match[2]))) {
      const { stdout: identity } = await exec("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], { timeout: config.timeoutMs, env: { ...process.env, LC_ALL: "C" } });
      if (!identity.trim()) return null;
      return { pid, identity: createHash("sha256").update(identity.trim()).digest("hex") };
    }
    pid = Number(match[1]);
  }
  return null;
}
export async function main() {
  const token = await hookToken();
  if (!token) return;
  const endpoint = new URL(config.endpointPath, process.env.CM_RUNTIME_ENDPOINT ?? `http://${web.hostname}:${web.port}`);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("loopback_required");
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > config.maxInputBytes) throw new Error("input_too_large"); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // Missing PID evidence is reported as unknown; it must not suppress the hook event.
  let processInfo = null;
  try { processInfo = await findClaudeProcess(); } catch { /* ps unavailable: liveness remains unknown */ }
  const event = sanitizeHook(input, processInfo);
  if (!event) throw new Error("unsupported_hook_input");
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(event), signal: AbortSignal.timeout(config.timeoutMs), redirect: "error" });
  if (!response.ok) throw new Error("delivery_failed");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Fixed diagnostic only. Never print payload, paths, token, prompt, or tool input.
  main().catch(() => process.stderr.write("Claude Monitor: observation unavailable\n")).finally(() => { process.exitCode = 0; });
}
