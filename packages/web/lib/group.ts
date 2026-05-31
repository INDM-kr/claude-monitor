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
