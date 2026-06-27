"use client";

import clsx from "clsx";
import Link from "next/link";
import type { SessionSummary } from "@claude-monitor/core";
import { SessionCard } from "./SessionCard";
import { useCollapsed } from "./useCollapsed";
import { t } from "../../lib/i18n/t";

export function ProjectGroup({
  projectKey,
  projectLabel,
  sessions,
  childrenByParent,
}: {
  projectKey: string;
  projectLabel: string;
  sessions: SessionSummary[];
  childrenByParent?: Map<string, SessionSummary[]>;
}) {
  const [collapsed, toggle] = useCollapsed(projectKey);
  return (
    <section className="mb-4">
      <div className="sticky top-[var(--cm-header-h,102px)] z-30 -mx-4 box-border flex w-[calc(100%+2rem)] items-center gap-2 bg-[rgb(13_17_23_/_92%)] px-4 py-1.5 backdrop-blur-[4px] relative after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border-subtle after:content-['']">
        <button type="button" onClick={toggle} className="flex flex-1 items-center gap-2 text-left text-zinc-300 hover:text-zinc-100">
          <span className={clsx("text-[11px] text-zinc-600 transition-transform", collapsed && "-rotate-90")}>▾</span>
          <span className="font-mono text-[12.5px] text-zinc-100">📁 {projectLabel}</span>
          <span className="rounded-full border border-border bg-bg-soft px-2 py-px text-[11px] tabular-nums text-zinc-500">
            {sessions.length}
          </span>
        </button>
        <Link
          href={`/project/${encodeURIComponent(projectKey)}`}
          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-cyan-400 transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-cyan-300"
        >
          {t("project.detail")} ↗
        </Link>
      </div>
      {!collapsed && (
        <div className="-mt-px flex flex-col gap-2.5">
          {sessions.map((s) => (
            <SessionCard
              key={`${s.ref.adapterId}::${s.ref.id}`}
              session={s}
              childSessions={childrenByParent?.get(s.ref.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
