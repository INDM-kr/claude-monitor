"use client";

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
    <section className="mb-3">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-baseline gap-2 px-2 py-0.5 text-left hover:bg-bg-soft/40"
      >
        <span className="inline-block w-[1ch] shrink-0 text-zinc-500">{collapsed ? "▸" : "▾"}</span>
        <span className="font-semibold text-zinc-100">{projectLabel}</span>
        <span className="text-xs text-zinc-500">({sessions.length})</span>
      </button>
      {!collapsed &&
        sessions.map((s, i) => (
          <SessionCard
            key={`${s.ref.adapterId}::${s.ref.id}`}
            session={s}
            childSessions={childrenByParent?.get(s.ref.id)}
            isLast={i === sessions.length - 1}
          />
        ))}
    </section>
  );
}
