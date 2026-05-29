import type { ContextUsage } from "@claude-monitor/core";
import { t } from "../../lib/i18n/t";

export function ContextBar({ context }: { context: ContextUsage | null }) {
  if (!context) return null;
  const pct = Math.round(context.pct * 100);
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500 pl-1">
      <span>{t("card.context")}</span>
      <div className="h-1.5 w-24 rounded bg-zinc-800 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-zinc-400">{pct}%</span>
      <span className="text-zinc-600">
        ({(context.tokens / 1000).toFixed(0)}k/{(context.limit / 1000).toFixed(0)}k)
      </span>
    </div>
  );
}
