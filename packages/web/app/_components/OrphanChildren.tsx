"use client";

import type { SessionSummary } from "@claude-monitor/core";
import { shortSid } from "@claude-monitor/core";
import { ChildSessionList } from "./ChildSessionList";
import { t } from "../../lib/i18n/t";

export interface OrphanGroup {
  parentId: string;
  children: SessionSummary[];
}

/**
 * Child sessions whose parent is filtered out of view — surfaced under a
 * synthetic parent header keyed by parentId, so child work is never dropped.
 */
export function OrphanChildren({ groups }: { groups: OrphanGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section className="mb-3">
      <div className="px-2 py-0.5 text-xs text-zinc-500">{t("app.orphanAgents")}</div>
      {groups.map(({ parentId, children }) => (
        <div key={parentId}>
          <div className="flex items-baseline px-2 leading-[1.15] text-zinc-400">
            <span className="inline-block w-[1ch] shrink-0 text-zinc-600">⌁</span>
            <span className="ml-1.5">{children[0]?.ref.projectLabel ?? "?"}</span>
            <span className="ml-2 text-xs text-zinc-600">
              parent {shortSid(parentId)} · {t("app.parentHidden")}
            </span>
          </div>
          <ChildSessionList sessions={children} trunk={null} />
        </div>
      ))}
    </section>
  );
}
