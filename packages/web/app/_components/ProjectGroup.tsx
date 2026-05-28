"use client";

import { useState } from "react";
import type { SessionSummary } from "@claude-monitor/core";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { SessionCard } from "./SessionCard";
import { WidgetSlot } from "./WidgetSlot";

export function ProjectGroup({
  workspace,
  workspaceShort,
  sessions,
}: {
  workspace: string;
  workspaceShort: string;
  sessions: SessionSummary[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="space-y-2">
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1 text-zinc-300 hover:text-zinc-100"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <Folder size={14} className="text-zinc-500" />
          <span title={workspace}>{workspaceShort}</span>
        </button>
        <span className="text-xs text-zinc-500">{sessions.length}개 세션</span>
      </header>
      {sessions[0] && <WidgetSlot slot="project-header" session={sessions[0]} />}
      {!collapsed && (
        <div className="space-y-2 pl-4">
          {sessions.map((s) => (
            <SessionCard key={`${s.ref.adapterId}::${s.ref.id}`} session={s} />
          ))}
        </div>
      )}
    </section>
  );
}
