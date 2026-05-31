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
 * Child sessions whose parent is not currently visible (filtered out by
 * status/age). Surfaced under a lightweight synthetic parent header keyed by
 * the parent session id, so child work is never silently dropped.
 */
export function OrphanChildren({ groups }: { groups: OrphanGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="text-sm text-zinc-400">{t("app.orphanAgents")}</div>
      <div className="space-y-2 pl-1">
        {groups.map(({ parentId, children }) => (
          <article
            key={parentId}
            className="rounded-md border border-dashed border-border-subtle bg-bg-card px-4 py-3"
          >
            <header className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-400">⌁ {children[0]?.ref.projectLabel ?? "?"}</span>
              <span className="text-xs text-zinc-600">
                parent {shortSid(parentId)} · {t("app.parentHidden")}
              </span>
            </header>
            <ChildSessionList sessions={children} />
          </article>
        ))}
      </div>
    </section>
  );
}
