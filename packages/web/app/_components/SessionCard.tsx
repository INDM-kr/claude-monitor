"use client";

import Link from "next/link";
import type { SessionSummary } from "@claude-monitor/core";
import { ago, shortSid, truncate } from "@claude-monitor/core";
import { useSessionStore } from "../../lib/store";
import { deriveStatus } from "../../lib/derive-status";
import { StatusBadge } from "./StatusBadge";
import { TodoProgress } from "./TodoProgress";
import { SubAgentList } from "./SubAgentList";
import { WidgetSlot } from "./WidgetSlot";
import { RunnerBadge } from "./RunnerBadge";
import { ContextBar } from "./ContextBar";
import { KillButton } from "./KillButton";
import { DismissButton } from "./DismissButton";
import { t } from "../../lib/i18n/t";

export function SessionCard({ session }: { session: SessionSummary }) {
  // Derive status/age from the ticking client clock (not the frozen
  // session.status baked in at read time) so LIVE→idle→stop decays in place.
  const now = useSessionStore((s) => s.now);
  const age = Math.max(0, now - session.ref.mtime);
  const status = deriveStatus(now, session.ref.mtime);
  return (
    <article className="relative rounded-md border border-border-subtle bg-bg-card px-4 py-3">
      {/* 액션 버튼: 박스 우측 상단 고정 */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
        <DismissButton session={session} />
        <KillButton session={session} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:gap-5">
        {/* 좌: 정체성·상태·모델·컨텍스트 */}
        <div className="min-w-0 space-y-2 sm:flex-1">
          <header className="flex flex-wrap items-center gap-3 pr-14 text-sm">
            <StatusBadge status={status} />
            <Link
              href={`/session/${session.ref.id}?adapter=${session.ref.adapterId}`}
              className="text-cyan-400 hover:underline"
            >
              {shortSid(session.ref.id)}
            </Link>
            <time
              className="text-zinc-500"
              dateTime={new Date(session.ref.mtime * 1000).toISOString()}
              title={new Date(session.ref.mtime * 1000).toLocaleString()}
            >
              {ago(age)}
            </time>
            <RunnerBadge runner={session.runner} />
          </header>

          {(session.model || session.mode) && (
            <div className="flex items-center gap-3 pl-1 text-xs text-zinc-500">
              {session.model && <span>{session.model}</span>}
              {session.mode && <span className="text-zinc-600">· {session.mode}</span>}
            </div>
          )}

          <ContextBar context={session.context} />
        </div>

        {/* 우: 활동(도구·sub-agent·todo·메시지) */}
        <div className="min-w-0 space-y-2 sm:flex-1 sm:pr-10">
          {session.lastTool && (
            <div className="pl-1 text-xs text-amber-400/90">
              {t("card.tool")}: <span className="text-amber-300">{session.lastTool}</span>
            </div>
          )}

          {session.pendingSubagents.length > 0 && <SubAgentList agents={session.pendingSubagents} />}

          <WidgetSlot slot="card-body" session={session} />

          {session.todo && <TodoProgress todo={session.todo} />}

          {session.lastText && (
            <div className="pl-1 text-xs text-zinc-500">
              └ {t("card.msg")}:{" "}
              <span className="text-zinc-400">{truncate(session.lastText, 120)}</span>
            </div>
          )}
        </div>
      </div>

      <WidgetSlot slot="card-footer" session={session} />
    </article>
  );
}
