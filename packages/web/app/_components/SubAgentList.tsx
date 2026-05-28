import type { PendingSubagent } from "@claude-monitor/core";
import { t } from "../../lib/i18n/t";

export function SubAgentList({ agents }: { agents: PendingSubagent[] }) {
  if (agents.length === 0) return null;
  return (
    <div className="text-xs text-red-400/90">
      🤖 {t("card.subagent")} {agents.length}개:{" "}
      <span className="text-red-300/90">
        {agents.map((a) => a.desc).join(", ")}
      </span>
    </div>
  );
}
