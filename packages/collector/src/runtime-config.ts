import { RUNTIME_DEFAULTS } from "@claude-monitor/core";
export { RUNTIME_DEFAULTS };
export function runtimeStaleAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.CM_RUNTIME_STALE_AFTER_MS;
  if (value === undefined) return RUNTIME_DEFAULTS.staleAfterMs;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1_000 || number > 3_600_000) throw new Error("invalid_runtime_staleness");
  return number;
}
