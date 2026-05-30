import { getDataSource } from "../lib/data-source/local";
import { loadConfig } from "../lib/config";
import { sessionMatches } from "../lib/filter";
import { groupByProject, type ProjectGroupData } from "../lib/group";
import { Dashboard } from "./_components/Dashboard";

export const dynamic = "force-dynamic";

export type { ProjectGroupData };

export default async function Page({
  searchParams,
}: {
  searchParams?: { maxAgeHours?: string; all?: string; filter?: string; status?: string };
}) {
  const cfg = loadConfig();
  const all = searchParams?.all === "1";
  const maxAge = searchParams?.maxAgeHours ? Number(searchParams.maxAgeHours) : cfg.maxAgeHours;
  const filterGlob = searchParams?.filter ?? null;
  const status = searchParams?.status || null;

  const ds = getDataSource();
  const now = Math.floor(Date.now() / 1000);
  const summaries = (await ds.snapshot()).filter((s) =>
    sessionMatches(s, { maxAgeHours: maxAge, all, filterGlob, status, now }),
  );
  const initial = groupByProject(summaries);

  return <Dashboard initial={initial} />;
}
