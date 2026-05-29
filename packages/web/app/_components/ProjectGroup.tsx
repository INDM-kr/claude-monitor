"use client";

import type { SessionSummary } from "@claude-monitor/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SessionCard } from "./SessionCard";
import { WidgetSlot } from "./WidgetSlot";
import { useCollapsed } from "./useCollapsed";

export function ProjectGroup({
  projectKey,
  projectLabel,
  sessions,
}: {
  projectKey: string;
  projectLabel: string;
  sessions: SessionSummary[];
}) {
  const [collapsed, toggle] = useCollapsed(projectKey);
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-2 flex-1 text-left text-sm text-zinc-300 hover:text-zinc-100"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span className="font-medium">{projectLabel}</span>
          <span className="text-xs text-zinc-500">({sessions.length})</span>
        </button>
        {/* WidgetSlot은 button 밖 — <button> 안 <div>는 비유효 HTML */}
        <WidgetSlot slot="project-header" session={sessions[0]!} />
      </div>
      {!collapsed && (
        <div className="space-y-2 pl-1">
          {sessions.map((s) => (
            <SessionCard key={`${s.ref.adapterId}::${s.ref.id}`} session={s} />
          ))}
        </div>
      )}
    </section>
  );
}
