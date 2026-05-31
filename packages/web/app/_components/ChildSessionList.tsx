"use client";

import { useState } from "react";
import type { SessionSummary } from "@claude-monitor/core";
import { ago, truncate } from "@claude-monitor/core";
import { useSessionStore } from "../../lib/store";
import { deriveStatus } from "../../lib/derive-status";
import { StatusBadge } from "./StatusBadge";
import { RunnerBadge } from "./RunnerBadge";
import { t } from "../../lib/i18n/t";

const COLLAPSE_THRESHOLD = 5;

/** Sub-agent / workflow child sessions, nested under their parent card. */
export function ChildSessionList({ sessions }: { sessions?: SessionSummary[] }) {
  const now = useSessionStore((s) => s.now);
  const [open, setOpen] = useState((sessions?.length ?? 0) <= COLLAPSE_THRESHOLD);
  if (!sessions || sessions.length === 0) return null;
  return (
    <div className="mt-2 border-t border-border-subtle pt-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-zinc-400 hover:text-zinc-200"
      >
        🤖 {t("card.childAgents")} ({sessions.length}) ·{" "}
        <span className="text-zinc-500">{open ? t("card.childHide") : t("card.childShow")}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-2">
          {sessions.map((c) => {
            const age = Math.max(0, now - c.ref.mtime);
            const label =
              c.lastActivityDetail ||
              (c.lastText ? truncate(c.lastText, 60) : c.lastTool || "agent");
            return (
              <div
                key={`${c.ref.adapterId}::${c.ref.id}`}
                className="flex items-center gap-2 min-w-0"
              >
                <span className="shrink-0">
                  <StatusBadge status={deriveStatus(now, c.ref.mtime)} />
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-300">{label}</span>
                <RunnerBadge runner={c.runner} />
                <span className="shrink-0 text-zinc-600">{ago(age)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
