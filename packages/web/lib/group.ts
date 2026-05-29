import type { SessionSummary } from "@claude-monitor/core";

export interface ProjectGroupData {
  projectKey: string;
  projectLabel: string;
  sessions: SessionSummary[];
}

/** Group sessions by projectKey; sessions sorted mtime-desc within group, groups sorted by most-recent activity. */
export function groupByProject(list: SessionSummary[]): ProjectGroupData[] {
  const map = new Map<string, ProjectGroupData>();
  for (const s of list) {
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
