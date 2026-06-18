"use client";

import type { SessionSummary } from "@claude-monitor/core";
import { groupAgentsByWorkflow } from "../../lib/group";
import { AgentRow } from "./AgentRow";
import { WorkflowGroup } from "./WorkflowGroup";

/**
 * Sub-agent / workflow child runs under a parent session. Agents from a workflow
 * run (wf_*) collapse under a WorkflowGroup; direct (non-workflow) sub-agents
 * render as flat agent rows. `trunk` continues the parent's │ down the left.
 */
export function ChildSessionList({
  sessions,
  trunk,
}: {
  sessions?: SessionSummary[];
  trunk?: { live: boolean } | null;
}) {
  if (!sessions || sessions.length === 0) return null;
  const groups = groupAgentsByWorkflow(sessions);
  return (
    <>
      {groups.map((g) =>
        g.wfId ? (
          <WorkflowGroup key={g.wfId} group={g} trunk={trunk} />
        ) : (
          g.agents.map((a) => (
            <AgentRow key={`${a.ref.adapterId}::${a.ref.id}`} agent={a} trunk={trunk} />
          ))
        ),
      )}
    </>
  );
}
