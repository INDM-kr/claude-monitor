import type { AgentStatus } from "@claude-monitor/core";
import clsx from "clsx";

const GLYPH: Record<AgentStatus, { ch: string; cls: string }> = {
  done: { ch: "✔", cls: "text-emerald-400" },
  cancelled: { ch: "✗", cls: "text-red-400" },
  error: { ch: "✗", cls: "text-red-500" },
  running: { ch: "◐", cls: "text-cyan-400" },
};

/** Sub-agent lifecycle glyph: ✔ done / ✗ cancelled·error / ◐ running. */
export function AgentGlyph({ status }: { status?: AgentStatus | null }) {
  const g = GLYPH[status ?? "running"];
  return (
    <span
      className={clsx("inline-block w-[1ch] shrink-0 text-center", g.cls)}
      aria-label={`agent: ${status ?? "running"}`}
    >
      {g.ch}
    </span>
  );
}
