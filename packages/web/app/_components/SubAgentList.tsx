import type { PendingSubagent } from "@claude-monitor/core";
import { t } from "../../lib/i18n/t";

/**
 * One indented tree row. Generic primitive reused by both SubAgentList (inline
 * pending Task/Agent calls) and ChildSessionList (discovered child transcripts).
 * The caller owns the text color via a wrapping element.
 */
export function SubAgentRow({
  connector,
  label,
  tag,
}: {
  connector: string;
  label: string;
  tag?: string | null;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-mono opacity-60">{connector}</span>
      <span className="min-w-0 truncate">{label}</span>
      {tag && <span className="opacity-70 shrink-0">({tag})</span>}
    </div>
  );
}

export function SubAgentList({ agents }: { agents: PendingSubagent[] }) {
  if (agents.length === 0) return null;
  return (
    <div className="text-xs text-red-400/90 space-y-0.5">
      <div>
        🤖 {t("card.subagent")} {agents.length}개:
      </div>
      <div className="pl-2 text-red-300/90">
        {agents.map((a, i) => (
          <SubAgentRow
            key={a.id}
            connector={i === agents.length - 1 ? "└" : "├"}
            label={a.desc}
            tag={a.type && a.type !== a.desc ? a.type : null}
          />
        ))}
      </div>
    </div>
  );
}
