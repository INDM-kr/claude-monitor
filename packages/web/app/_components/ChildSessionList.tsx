"use client";

import type { SessionSummary } from "@claude-monitor/core";
import { ago, truncate } from "@claude-monitor/core";
import clsx from "clsx";
import { useSessionStore } from "../../lib/store";
import { deriveStatus } from "../../lib/derive-status";
import { TreeGlyph } from "./TreeGlyph";
import { RunnerBadge } from "./RunnerBadge";

const STATE_CLS: Record<string, string> = {
  live: "text-emerald-400",
  idle: "text-amber-400",
  stop: "text-zinc-500",
};

/**
 * Sub-agent / workflow child sessions as terminal tree rows.
 * `trunk` = the vertical that continues down the LEFT of these rows: a `│`
 * (green when the parent session is live) when the parent has a sibling below,
 * else null → blank (parent is last). Keeps the │ trunk column aligned.
 */
export function ChildSessionList({
  sessions,
  trunk,
}: {
  sessions?: SessionSummary[];
  trunk?: { live: boolean } | null;
}) {
  const now = useSessionStore((s) => s.now);
  if (!sessions || sessions.length === 0) return null;
  return (
    <>
      {sessions.map((c, j) => {
        const last = j === sessions.length - 1;
        const status = deriveStatus(now, c.ref.mtime);
        const label =
          c.lastActivityDetail ||
          (c.lastText ? truncate(c.lastText, 64) : c.lastTool || "agent");
        return (
          <div
            key={`${c.ref.adapterId}::${c.ref.id}`}
            className="flex items-baseline whitespace-nowrap px-2 leading-[1.15] hover:bg-bg-soft/40"
          >
            <span className="whitespace-pre">
              {trunk ? (
                <span className={trunk.live ? "text-emerald-600" : "text-zinc-700"}>│</span>
              ) : (
                " "
              )}
              <span className="text-zinc-700">{`  ${last ? "└─ " : "├─ "}`}</span>
            </span>
            <TreeGlyph status={status} />
            <span className="ml-1.5 min-w-0 flex-1 truncate text-zinc-300">{label}</span>
            <span className="ml-2 shrink-0">
              <RunnerBadge runner={c.runner} compact />
            </span>
            <span className={clsx("ml-2 shrink-0 text-[10px]", STATE_CLS[status])}>{status}</span>
            <span className="ml-2 inline-block w-[7ch] shrink-0 whitespace-nowrap text-right tabular-nums text-zinc-600">
              {ago(Math.max(0, now - c.ref.mtime))}
            </span>
          </div>
        );
      })}
    </>
  );
}
