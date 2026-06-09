import type { SessionStatus } from "@claude-monitor/core";
import clsx from "clsx";

const GLYPH: Record<SessionStatus, { ch: string; cls: string; pulse?: boolean }> = {
  live: { ch: "●", cls: "text-emerald-400", pulse: true },
  idle: { ch: "○", cls: "text-amber-400" },
  stop: { ch: "·", cls: "text-zinc-500" },
};

/** Terminal-tree status glyph (●/○/·), 1ch wide so connector columns stay aligned. */
export function TreeGlyph({ status }: { status: SessionStatus }) {
  const g = GLYPH[status];
  return (
    <span
      className={clsx("inline-block w-[1ch] shrink-0 text-center", g.cls, g.pulse && "live-dot")}
      aria-label={`status: ${status}`}
    >
      {g.ch}
    </span>
  );
}
