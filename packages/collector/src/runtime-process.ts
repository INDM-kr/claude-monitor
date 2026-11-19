import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { RuntimeProcessProbe } from "@claude-monitor/core";
import { RUNTIME_DEFAULTS } from "./runtime-config.js";
const exec = promisify(execFile);
export function processIdentity(raw: string): string { return createHash("sha256").update(raw.trim()).digest("hex"); }
export async function probeProcess(pid: number, identity: string, now: number): Promise<RuntimeProcessProbe> {
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], { timeout: RUNTIME_DEFAULTS.processProbeTimeoutMs, env: { ...process.env, LC_ALL: "C" } });
    if (!stdout.trim()) return { state: "exited", reason: "missing", observedAt: now };
    return processIdentity(stdout) === identity
      ? { state: "alive", reason: "matched", observedAt: now }
      : { state: "exited", reason: "identity_changed", observedAt: now };
  } catch (error) {
    if ((error as {code?: unknown}).code === 1 && !(error as {stderr?: string}).stderr?.trim()) return { state: "exited", reason: "missing", observedAt: now };
    return { state: "unknown", reason: "probe_failed", observedAt: now };
  }
}
