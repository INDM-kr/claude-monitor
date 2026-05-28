import clsx from "clsx";
import type { SessionStatus } from "@claude-monitor/core";

const META: Record<SessionStatus, { symbol: string; label: string; color: string; dotClass?: string }> = {
  live: { symbol: "●", label: "LIVE", color: "text-emerald-400", dotClass: "live-dot" },
  idle: { symbol: "○", label: "idle", color: "text-amber-400" },
  stop: { symbol: "·", label: "stop", color: "text-zinc-500" },
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  const m = META[status];
  return (
    <span
      className={clsx("inline-flex items-center gap-1.5 text-sm font-semibold", m.color)}
      aria-label={`status: ${m.label}`}
    >
      <span className={clsx("text-base leading-none", m.dotClass)}>{m.symbol}</span>
      <span>{m.label}</span>
    </span>
  );
}
