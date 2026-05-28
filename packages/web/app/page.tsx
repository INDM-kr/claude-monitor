import type { SessionSummary } from "@claude-monitor/core";
import { getDataSource } from "../lib/data-source/local";
import { loadConfig } from "../lib/config";
import { Dashboard } from "./_components/Dashboard";

export const dynamic = "force-dynamic";

interface InitialGroup {
  workspace: string;
  workspaceShort: string;
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
  let summaries = await ds.snapshot();
  if (!all && Number.isFinite(maxAge)) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAge * 3600;
    summaries = summaries.filter((s) => s.ref.mtime >= cutoff);
  }
  if (filterGlob) {
    const re = globToRegExp(filterGlob);
    summaries = summaries.filter(
      (s) => re.test(s.ref.workspace) || re.test(s.ref.workspaceShort),
    );
  }
  const initial = groupByWorkspace(summaries);

  return <Dashboard initial={initial} />;
}

function groupByWorkspace(list: SessionSummary[]): InitialGroup[] {
  const map = new Map<string, InitialGroup>();
  for (const s of list) {
    const key = s.ref.workspace;
    let g = map.get(key);
    if (!g) {
      g = { workspace: s.ref.workspace, workspaceShort: s.ref.workspaceShort, sessions: [] };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  return [...map.values()];
}

function globToRegExp(g: string): RegExp {
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(re);
}
