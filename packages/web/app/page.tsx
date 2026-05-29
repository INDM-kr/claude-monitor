import type { SessionSummary } from "@claude-monitor/core";
import { getDataSource } from "../lib/data-source/local";
import { loadConfig } from "../lib/config";
import { sessionMatches } from "../lib/filter";
import { Dashboard } from "./_components/Dashboard";

export const dynamic = "force-dynamic";

export interface ProjectGroupData {
  projectKey: string;
  projectLabel: string;
  sessions: SessionSummary[];
}

export default async function Page({
  searchParams,
}: {
  searchParams?: { maxAgeHours?: string; all?: string; filter?: string };
}) {
  const cfg = loadConfig();
  const all = searchParams?.all === "1";
  const maxAge = searchParams?.maxAgeHours ? Number(searchParams.maxAgeHours) : cfg.maxAgeHours;
  const filterGlob = searchParams?.filter ?? null;

  const ds = getDataSource();
  const now = Math.floor(Date.now() / 1000);
  const summaries = (await ds.snapshot()).filter((s) =>
    sessionMatches(s, { maxAgeHours: maxAge, all, filterGlob, now }),
  );
  const initial = groupByProject(summaries);

  return <Dashboard initial={initial} />;
}

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
