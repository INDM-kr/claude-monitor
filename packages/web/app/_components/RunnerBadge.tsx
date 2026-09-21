import clsx from "clsx";
import type { RunnerKind } from "@claude-monitor/core";
import { t } from "../../lib/i18n/t";

const STYLE: Record<RunnerKind, string> = {
  conductor: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "claude-code": "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "claude-desktop": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  agent: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  codex: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "codex-desktop": "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
  unknown: "bg-zinc-700/40 text-zinc-400 border-zinc-600/40",
};

/** Text-only color for the compact terminal-tree form ([Conductor], [Agent]…). */
const COMPACT: Record<RunnerKind, string> = {
  conductor: "text-violet-300",
  "claude-code": "text-emerald-300",
  "claude-desktop": "text-sky-300",
  agent: "text-amber-300",
  codex: "text-rose-300",
  "codex-desktop": "text-fuchsia-300",
  unknown: "text-zinc-400",
};

export function RunnerBadge({ runner, compact }: { runner: RunnerKind; compact?: boolean }) {
  if (runner === "unknown") return null;
  if (compact) {
    return <span className={clsx("text-[10px]", COMPACT[runner])}>[{t(`runner.${runner}`)}]</span>;
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STYLE[runner]}`}>
      {t(`runner.${runner}`)}
    </span>
  );
}
