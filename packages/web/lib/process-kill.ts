import { exec } from "node:child_process";
import { promisify } from "node:util";
import { probeProcesses, sessionIdFromCommand, classifyRunner } from "./process-probe";

const pexec = promisify(exec);

export interface KillResult {
  ok: boolean;
  reason?: string;
}

/** kill 직전 재검증: 해당 command가 진짜 그 세션의 claude 프로세스인가 (오살 방지). */
export function verifyKillTarget(command: string, sessionId: string): boolean {
  if (classifyRunner(command) === "unknown") return false;
  return sessionIdFromCommand(command) === sessionId;
}

export async function killSession(sessionId: string): Promise<KillResult> {
  const probe = await probeProcesses({ force: true });
  const e = probe.get(sessionId);
  if (!e) return { ok: false, reason: "not_found" };

  // TOCTOU 가드 — pid의 현재 command를 재확인
  let command = "";
  try {
    const { stdout } = await pexec(`ps -p ${e.pid} -o command=`);
    command = stdout.trim();
  } catch {
    return { ok: false, reason: "gone" };
  }
  if (!verifyKillTarget(command, sessionId)) return { ok: false, reason: "mismatch" };

  try {
    process.kill(e.pid, "SIGTERM");
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: false, reason: "gone" };
    if (code === "EPERM") return { ok: false, reason: "eperm" };
    return { ok: false, reason: "error" };
  }
}
