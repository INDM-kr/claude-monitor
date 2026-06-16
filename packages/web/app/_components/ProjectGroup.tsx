"use client";

import clsx from "clsx";
import type { SessionSummary } from "@claude-monitor/core";
import { SessionCard } from "./SessionCard";
import { useCollapsed } from "./useCollapsed";

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
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-1 py-1 text-left text-zinc-400 hover:text-zinc-200"
      >
        <span className={clsx("text-[11px] text-zinc-600 transition-transform", collapsed && "-rotate-90")}>▾</span>
        <span className="font-mono text-[12.5px] text-zinc-100">📁 {projectLabel}</span>
        <span className="rounded-full border border-border bg-bg-soft px-2 py-px text-[11px] tabular-nums text-zinc-500">
          {sessions.length}
        </span>
      </button>
      {!collapsed && (
        <div className="mt-1 grid gap-2.5">
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
