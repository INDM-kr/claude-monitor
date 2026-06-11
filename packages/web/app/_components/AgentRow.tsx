"use client";

import type { SessionSummary } from "@claude-monitor/core";
import { truncate } from "@claude-monitor/core";
import { AgentGlyph } from "./AgentGlyph";

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
function fmtDur(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (sec < 3600) return `${m}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${m % 60}m`;
}

/** One sub-agent run row: status glyph · label · model · tok·tools·duration.
 *  `trunk` draws the parent session's continuing │; `indent` adds depth (ch). */
export function AgentRow({
  agent,
  trunk,
  indent = 0,
}: {
  agent: SessionSummary;
  trunk?: { live: boolean } | null;
  indent?: number;
}) {
  const label =
    agent.lastActivityDetail ||
    (agent.lastText ? truncate(agent.lastText, 56) : agent.lastTool || "agent");
  const m = agent.metrics;
  return (
    <div className="flex items-baseline whitespace-nowrap px-2 leading-[1.3] hover:bg-bg-soft/40">
      <span className="whitespace-pre">
        {trunk ? <span className={trunk.live ? "text-emerald-600" : "text-zinc-700"}>│</span> : " "}
        {`  ${" ".repeat(indent)}`}
      </span>
      <AgentGlyph status={agent.agentStatus} />
      <span className="ml-1.5 min-w-0 flex-1 truncate text-zinc-300">{label}</span>
      {agent.model && (
        <span className="ml-2 shrink-0 text-zinc-600">{agent.model.replace(/^claude-/, "")}</span>
      )}
      {m && (
        <span className="ml-3 shrink-0 tabular-nums text-zinc-600">
          {fmtTok(m.tokens)} tok · {m.tools} tools · {fmtDur(m.durationSec)}
        </span>
      )}
    </div>
  );
}
