import type { RunnerKind } from "@claude-monitor/core";
import { t } from "../../lib/i18n/t";

const STYLE: Record<RunnerKind, string> = {
  conductor: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "claude-code": "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "claude-desktop": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  agent: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  unknown: "bg-zinc-700/40 text-zinc-400 border-zinc-600/40",
};

export function RunnerBadge({ runner }: { runner: RunnerKind }) {
  if (runner === "unknown") return null;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STYLE[runner]}`}>
      {t(`runner.${runner}`)}
    </span>
  );
}
