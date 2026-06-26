import { getDataSource } from "../lib/data-source/local";
import { loadConfig } from "../lib/config";
import { filterWithVisibleChildren, parseStatuses } from "../lib/filter";
import type { ProjectGroupData } from "../lib/group";
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
  const statuses = parseStatuses(searchParams?.status);

  const ds = getDataSource();
  const now = Math.floor(Date.now() / 1000);
  const summaries = filterWithVisibleChildren(await ds.snapshot(), {
    maxAgeHours: maxAge,
    all,
    filterGlob,
    statuses,
    now,
  });

  // Seed the store with the flat list (incl. child sub-agent sessions); the
  // Dashboard groups roots and nests children client-side. Pass the resolved
  // filter so the live (SSE) view applies the SAME maxAge/glob the server used
  // here — otherwise the live view drifts from this refresh snapshot.
  return <Dashboard initial={summaries} filter={{ maxAgeHours: maxAge, all, filterGlob }} />;
}
