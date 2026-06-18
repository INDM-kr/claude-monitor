import type { SessionSummary } from "@claude-monitor/core";

export interface ProjectGroupData {
  projectKey: string;
  projectLabel: string;
  sessions: SessionSummary[];
}

/** Group sessions by projectKey; sessions sorted mtime-desc within group, groups sorted by most-recent activity. Child (sub-agent) sessions are excluded — they render nested under their parent card. */
export function groupByProject(list: SessionSummary[]): ProjectGroupData[] {
  const map = new Map<string, ProjectGroupData>();
  for (const s of list) {
    if (s.ref.parentId) continue; // children nest under their parent, never top-level
    const key = s.ref.projectKey;
    let g = map.get(key);
    if (!g) {
      g = { projectKey: key, projectLabel: s.ref.projectLabel, sessions: [] };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  for (const g of map.values()) g.sessions.sort((a, b) => b.ref.mtime - a.ref.mtime);
  return [...map.values()].sort((a, b) => {
    const am = Math.max(...a.sessions.map((s) => s.ref.mtime));
    const bm = Math.max(...b.sessions.map((s) => s.ref.mtime));
    return bm - am;
  });
}

export interface AgentGroup {
  /** Workflow run id (wf_*), or null for direct (non-workflow) sub-agents. */
  wfId: string | null;
  agents: SessionSummary[];
  done: number;
  total: number;
}

/**
 * Group a parent's child agents by workflow run (wf_*) — the reliable middle
 * tier (Session → workflow run → agent). Direct (non-workflow) sub-agents share
 * one null group. Workflow groups first (most-recent first), direct group last.
 */
export function groupAgentsByWorkflow(children: SessionSummary[]): AgentGroup[] {
  const map = new Map<string, SessionSummary[]>();
  for (const c of children) {
    const key = c.ref.wfId ?? "";
    const arr = map.get(key);
    if (arr) arr.push(c);
    else map.set(key, [c]);
  }
  const groups: AgentGroup[] = [];
  for (const [key, agents] of map) {
    agents.sort((a, b) => b.ref.mtime - a.ref.mtime);
    groups.push({
      wfId: key || null,
      agents,
      done: agents.filter((a) => a.agentStatus === "done").length,
      total: agents.length,
    });
  }
  groups.sort((a, b) => {
    if ((a.wfId == null) !== (b.wfId == null)) return a.wfId == null ? 1 : -1; // direct last
    const am = Math.max(...a.agents.map((x) => x.ref.mtime));
    const bm = Math.max(...b.agents.map((x) => x.ref.mtime));
    return bm - am;
  });
  return groups;
}

/** Index child (sub-agent) sessions by their parent session id, mtime-desc. */
export function childrenByParent(list: SessionSummary[]): Map<string, SessionSummary[]> {
  const map = new Map<string, SessionSummary[]>();
  for (const s of list) {
    const pid = s.ref.parentId;
    if (!pid) continue;
    const arr = map.get(pid);
    if (arr) arr.push(s);
    else map.set(pid, [s]);
  }
  for (const arr of map.values()) arr.sort((a, b) => b.ref.mtime - a.ref.mtime);
  return map;
}
