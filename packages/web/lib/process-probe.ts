import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { RunnerKind } from "@claude-monitor/core";

const pexec = promisify(exec);
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

export interface ProbeEntry {
  sessionId: string;
  pid: number;
  runner: RunnerKind;
  contextLimit: number | null;
}

export function classifyRunner(command: string): RunnerKind {
  if (command.includes("com.conductor.app")) return "conductor";
  if (command.includes("/Claude.app/")) return "claude-desktop";
  if (command.includes("Caskroom/claude-code")) return "claude-code";
  if (/(^|\/)claude(\s|$)/.test(command)) return "claude-code";
  return "unknown";
}

export function sessionIdFromCommand(command: string): string | null {
  const m = command.match(new RegExp(`--(?:resume|session-id)[ =](${UUID})`));
  return m ? m[1]! : null;
}

export function contextLimitFromCommand(command: string): number | null {
  const m = command.match(/--model[ =](\S+)/);
  if (m && /\[1m\]/i.test(m[1]!)) return 1_000_000;
  return null;
}

export function parsePsOutput(text: string): ProbeEntry[] {
  const out: ProbeEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const command = m[2]!;
    const sessionId = sessionIdFromCommand(command);
    if (!sessionId) continue;
    out.push({
      sessionId,
      pid: Number(m[1]),
      runner: classifyRunner(command),
      contextLimit: contextLimitFromCommand(command),
    });
  }
  return out;
}

let cache: { at: number; map: Map<string, ProbeEntry> } | null = null;
let inflight: Promise<Map<string, ProbeEntry>> | null = null;
const TTL_MS = 4000;

export async function probeProcesses(
  opts: { force?: boolean; now?: number } = {},
): Promise<Map<string, ProbeEntry>> {
  const now = opts.now ?? Date.now();
  if (!opts.force && cache && now - cache.at < TTL_MS) return cache.map;
  if (!opts.force && inflight) return inflight;
  inflight = (async () => {
    const map = new Map<string, ProbeEntry>();
    try {
      const { stdout } = await pexec("ps -eo pid=,command=", { maxBuffer: 16 * 1024 * 1024 });
      for (const e of parsePsOutput(stdout)) map.set(e.sessionId, e);
    } catch {
      // ps 실패 시 빈 맵 (프로브 없음 = pid/runner 미보강, 치명적 아님)
    }
    cache = { at: now, map };
    inflight = null;
    return map;
  })();
  return inflight;
}
