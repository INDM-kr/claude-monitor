"use client";

import Link from "next/link";
import clsx from "clsx";
import type { SessionStatus, SessionSummary } from "@claude-monitor/core";
import { ago, shortSid, truncate } from "@claude-monitor/core";
import { useSessionStore } from "../../lib/store";
import { deriveStatus } from "../../lib/derive-status";
import { RunnerBadge } from "./RunnerBadge";
import { ChildSessionList } from "./ChildSessionList";
import { useCollapsed } from "./useCollapsed";
import { KillButton } from "./KillButton";
import { DismissButton } from "./DismissButton";
import { t } from "../../lib/i18n/t";

const TONE: Record<SessionStatus, { border: string; dot: string; pulse: boolean }> = {
  live: { border: "border-l-status-live", dot: "bg-status-live", pulse: true },
  waiting: { border: "border-l-status-waiting", dot: "bg-status-waiting", pulse: true },
  idle: { border: "border-l-status-stop", dot: "bg-status-stop", pulse: false },
  stop: { border: "border-l-status-stop", dot: "bg-status-stop", pulse: false },
};

function fmtTok(n: number): string {
  if (n >= 1e6) return `↓${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `↓${(n / 1e3).toFixed(1)}k`;
  return `↓${n}`;
}
function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (sec < 3600) return `${m}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${m % 60}m`;
}

/**
 * One session as a card: status dot + originating request (firstPrompt) as the
 * headline, runner/model/mode + context bar, the current activity line (tool ·
 * live elapsed · token burn), and the last assistant message. Click to expand
 * the full request history, task list, and sub-agent/workflow tree.
 */
export function SessionCard({
  session,
  childSessions,
}: {
  session: SessionSummary;
  childSessions?: SessionSummary[];
}) {
  const now = useSessionStore((s) => s.now);
  // Persist expand state per session id so a reload/restart keeps cards the user
  // opened open. Default collapsed (true) — untouched cards stay closed.
  const [collapsed, toggleOpen] = useCollapsed(`card:${session.ref.id}`, true);
  const open = !collapsed;
  const age = Math.max(0, now - session.ref.mtime);
  const status = deriveStatus(now, session);
  const tone = TONE[status];
  const live = status === "live";
  const userTurns = session.userTurns ?? [];
  // Title = the most recent user request; the full history below is newest-first.
  const lastTurn = userTurns[userTurns.length - 1];
  const label = lastTurn ?? session.firstPrompt ?? (session.lastText ? truncate(session.lastText, 90) : t("card.request"));
  const ctxPct = session.context ? Math.round(session.context.pct * 100) : null;
  const ctxColor = ctxPct == null ? "" : ctxPct >= 90 ? "bg-status-error" : ctxPct >= 70 ? "bg-status-waiting" : "bg-status-live";
  const turns = [...userTurns].reverse(); // newest first

  return (
    <article
      className={clsx(
        "min-w-0 rounded-lg border border-border bg-bg-soft border-l-[3px] px-3 py-2.5 transition-colors",
        !open && "overflow-hidden", // truncate the collapsed title; open lets the sticky head escape
        tone.border,
        status === "stop" && "opacity-80",
      )}
    >
      {/* head — click to expand */}
      <div
        className={clsx(
          "group/row -mx-3 flex cursor-pointer items-start gap-2.5 px-3 py-1 hover:bg-accent/[0.07] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent",
          open && "sticky top-[calc(var(--cm-header-h,102px)+29px)] z-20 border-b border-border bg-bg-soft",
        )}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleOpen();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={t("card.expand")}
      >
        <span className={clsx("mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full", tone.dot, tone.pulse && "live-dot")} />
        <span
          className={clsx(
            "min-w-0 flex-1 font-medium text-zinc-100 group-hover/row:underline group-hover/row:decoration-dotted group-hover/row:underline-offset-4",
            open ? "whitespace-normal text-justify [word-break:break-all]" : "truncate",
          )}
        >
          {label}
        </span>
        {ctxPct != null && (
          <span className="mt-[3px] flex shrink-0 items-center gap-1.5" title={t("card.context")}>
            <span className="w-[5ch] text-right font-mono text-[11px] tabular-nums text-zinc-500">{ctxPct}%</span>
            <span className="h-[5px] w-16 overflow-hidden rounded-full bg-track">
              <span className={clsx("block h-full rounded-full", ctxColor)} style={{ width: `${ctxPct}%` }} />
            </span>
          </span>
        )}
        <span
          className="mt-[2px] flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <DismissButton session={session} />
          <KillButton session={session} />
        </span>
        <svg
          className={clsx("mt-[2px] h-4 w-4 shrink-0 text-zinc-500 transition-transform group-hover/row:text-accent", open && "rotate-180 text-accent")}
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="M4 6.2l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* meta */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[22px] font-mono text-[11px] text-zinc-500">
        <RunnerBadge runner={session.runner} />
        {session.model && <span className="text-accent">{session.model}</span>}
        {session.mode && <span className="text-accent-purple">· {session.mode}</span>}
        <Link
          href={`/session/${session.ref.id}?adapter=${session.ref.adapterId}`}
          onClick={(e) => e.stopPropagation()}
          className="text-zinc-600 hover:text-accent hover:underline"
        >
          {shortSid(session.ref.id)}
        </Link>
      </div>

      {/* activity line */}
      {status === "waiting" ? (
        <div className="mt-1 pl-[22px] font-mono text-[11.5px] text-status-waiting">
          🟡 {t("card.waitingInput")}
        </div>
      ) : session.lastTool ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 pl-[22px] font-mono text-[11.5px] text-zinc-500">
          {live && <span className="text-status-live">◐</span>}
          <span className="text-zinc-200">
            {session.lastTool}
            {session.lastActivityDetail && <span className="text-zinc-500"> — {truncate(session.lastActivityDetail, 60)}</span>}
          </span>
          {live && session.turnStartSec != null && (
            <span className="tabular-nums text-zinc-600">{fmtElapsed(Math.max(0, now - session.turnStartSec))}</span>
          )}
          {live && session.turnTokens != null ? (
            <span className="tabular-nums text-zinc-600">{fmtTok(session.turnTokens)}</span>
          ) : (
            <span className="tabular-nums text-zinc-600">{ago(age)}</span>
          )}
        </div>
      ) : null}

      {/* last assistant message */}
      {session.lastText && (
        <div className="mt-1 truncate pl-[22px] text-[12px] text-zinc-500">
          <span className="mr-1.5 text-zinc-600">💬</span>
          {truncate(session.lastText, 120)}
        </div>
      )}

      {/* todo snapshot (compact, always visible when present) */}
      {session.todo && (
        <div className="mt-1 truncate pl-[22px] font-mono text-[11.5px] text-zinc-500">
          📋 <span className="text-zinc-400">{session.todo.done}/{session.todo.total}</span>
          {(session.todo.current ?? session.todo.next) && (
            <>
              {" · "}
              <span className={session.todo.current ? "text-status-waiting" : "text-zinc-500"}>
                {truncate(session.todo.current ?? session.todo.next ?? "", 56)}
              </span>
            </>
          )}
        </div>
      )}

      {/* expanded detail */}
      {open && (
        <div className="ml-[22px] mt-3 border-t border-dashed border-border pt-2.5">
          {turns.length > 0 && (
            <>
              <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">{t("card.request")}</h4>
              <ol className="mb-3 space-y-1">
                {turns.map((turn, i) => {
                  const latest = i === 0 && turns.length > 1; // newest sits first after reverse
                  const chronoNum = turns.length - i; // keep the chronological number (original request = 1)
                  return (
                    <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed">
                      <span
                        className={clsx(
                          "mt-0.5 grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full border font-mono text-[10px]",
                          latest ? "border-status-live text-status-live" : "border-border text-zinc-600",
                        )}
                      >
                        {chronoNum}
                      </span>
                      <span className={latest ? "text-zinc-100" : "text-zinc-400"}>{turn}</span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          {childSessions && childSessions.length > 0 && (
            <>
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">{t("card.childAgents")}</h4>
              <div className="font-mono text-[12px]">
                <ChildSessionList sessions={childSessions} trunk={null} />
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}
