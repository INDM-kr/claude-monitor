"use client";

import Link from "next/link";
import type { SessionSummary } from "@claude-monitor/core";
import { ago, shortSid, truncate } from "@claude-monitor/core";
import clsx from "clsx";
import { useSessionStore } from "../../lib/store";
import { deriveStatus } from "../../lib/derive-status";
import { TreeGlyph } from "./TreeGlyph";
import { RunnerBadge } from "./RunnerBadge";
import { ChildSessionList } from "./ChildSessionList";
import { KillButton } from "./KillButton";
import { DismissButton } from "./DismissButton";

/**
 * One session as terminal-tree rows: the session row (├─/└─ from the project),
 * an optional de-glyphed activity sub-line (│ ↳, so it never reads as a child),
 * then its sub-agent/workflow children. `isLast` = last session in the project
 * group → its subtree gets a blank trunk instead of a continuing │.
 */
export function SessionCard({
  session,
  childSessions,
  isLast,
}: {
  session: SessionSummary;
  childSessions?: SessionSummary[];
  isLast?: boolean;
}) {
  const now = useSessionStore((s) => s.now);
  const age = Math.max(0, now - session.ref.mtime);
  const status = deriveStatus(now, session.ref.mtime);
  const trunkLive = status === "live";
  const hasTrunk = !isLast; // a sibling session follows → │ continues
  const ctx = session.context ? `${Math.round(session.context.pct * 100)}%` : null;

  return (
    <div>
      {/* session row */}
      <div className="group/row flex items-baseline whitespace-nowrap px-2 leading-[1.15] hover:bg-bg-soft/40">
        <span className="whitespace-pre text-zinc-700">{isLast ? "└─ " : "├─ "}</span>
        <TreeGlyph status={status} />
        <Link
          href={`/session/${session.ref.id}?adapter=${session.ref.adapterId}`}
          className="ml-1.5 shrink-0 text-cyan-400 hover:underline"
        >
          {shortSid(session.ref.id)}
        </Link>
        {session.model && <span className="ml-2 shrink-0 text-zinc-500">{session.model}</span>}
        <span className="ml-2 shrink-0">
          <RunnerBadge runner={session.runner} compact />
        </span>
        {session.mode && <span className="ml-2 shrink-0 text-[11px] text-amber-300/70">{session.mode}</span>}
        <span className="ml-auto flex items-baseline gap-2 pl-3">
          <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
            <DismissButton session={session} />
            <KillButton session={session} />
          </span>
          <span className="shrink-0 whitespace-nowrap tabular-nums text-zinc-500">
            {ctx && <span className="inline-block w-[5ch] text-right">{ctx}</span>}
            {ctx && <span className="text-zinc-700"> · </span>}
            <span className="inline-block w-[7ch] text-right">{ago(age)}</span>
          </span>
        </span>
      </div>

      {/* activity sub-line — de-glyphed (no status dot) so it's session metadata, not a child */}
      {session.lastTool && (
        <div className="flex items-baseline whitespace-nowrap px-2 leading-[1.15] text-zinc-500">
          <span className="whitespace-pre">
            <span className={clsx(hasTrunk && (trunkLive ? "text-emerald-600" : "text-zinc-700"))}>
              {hasTrunk ? "│" : " "}
            </span>
            <span className="text-zinc-700">{"  ↳ "}</span>
          </span>
          <span className="min-w-0 truncate text-xs">
            <span className="text-amber-400/80">{session.lastTool}</span>
            {session.lastActivityDetail && (
              <>
                {" — "}
                <span className="text-amber-200/70">{truncate(session.lastActivityDetail, 60)}</span>
              </>
            )}
          </span>
        </div>
      )}

      {/* task list (TaskCreate/TaskUpdate or TodoWrite) — compact summary */}
      {session.todo && (
        <div className="flex items-baseline whitespace-nowrap px-2 leading-[1.15] text-zinc-500">
          <span className="whitespace-pre">
            <span className={clsx(hasTrunk && (trunkLive ? "text-emerald-600" : "text-zinc-700"))}>
              {hasTrunk ? "│" : " "}
            </span>
            <span className="text-zinc-700">{"  ↳ "}</span>
          </span>
          <span className="min-w-0 truncate text-xs">
            📋 <span className="text-zinc-400">{session.todo.done}/{session.todo.total}</span>
            {(session.todo.current ?? session.todo.next) && (
              <>
                {" · "}
                <span className={session.todo.current ? "text-cyan-400/80" : "text-zinc-500"}>
                  {truncate(session.todo.current ?? session.todo.next ?? "", 50)}
                </span>
              </>
            )}
          </span>
        </div>
      )}

      {/* children (sub-agents / workflow agents) */}
      <ChildSessionList sessions={childSessions} trunk={hasTrunk ? { live: trunkLive } : null} />
    </div>
  );
}
