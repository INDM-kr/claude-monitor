"use client";

import type { SessionSummary } from "@claude-monitor/core";
import { ago, shortSid, truncate } from "@claude-monitor/core";
import { StatusBadge } from "./StatusBadge";
import { TodoProgress } from "./TodoProgress";
import { SubAgentList } from "./SubAgentList";
import { WidgetSlot } from "./WidgetSlot";
import { t } from "../../lib/i18n/t";

export function SessionCard({ session }: { session: SessionSummary }) {
  const age = Math.max(0, Math.floor(Date.now() / 1000) - session.ref.mtime);
  return (
    <article className="rounded-md border border-border-subtle bg-bg-card px-4 py-3 space-y-2">
      <header className="flex items-center gap-3 text-sm">
        <StatusBadge status={session.status} />
        <span className="text-cyan-400">{shortSid(session.ref.id)}</span>
        <time
          className="text-zinc-500"
          dateTime={new Date(session.ref.mtime * 1000).toISOString()}
          title={new Date(session.ref.mtime * 1000).toLocaleString()}
        >
          {ago(age)}
        </time>
      </header>

      {session.lastTool && (
        <div className="text-xs text-amber-400/90 pl-1">
          {t("card.tool")}: <span className="text-amber-300">{session.lastTool}</span>
        </div>
      )}

      {session.pendingSubagents.length > 0 && (
        <SubAgentList agents={session.pendingSubagents} />
      )}

      <WidgetSlot slot="card-body" session={session} />

      {session.todo && <TodoProgress todo={session.todo} />}

      {session.lastText && (
        <div className="text-xs text-zinc-500 pl-1">
          └ {t("card.msg")}: <span className="text-zinc-400">{truncate(session.lastText, 120)}</span>
        </div>
      )}

      <WidgetSlot slot="card-footer" session={session} />
    </article>
  );
}
