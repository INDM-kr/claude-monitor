import type { NextRequest } from "next/server";
import { getDataSource } from "../../../lib/data-source/local";
import { checkBearer, unauthorized } from "../../../lib/auth/middleware";
import { loadConfig } from "../../../lib/config";
import { sessionMatches, parseStatuses } from "../../../lib/filter";
import { groupByProject } from "../../../lib/group";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const auth = checkBearer(req);
  if (!auth.ok) return unauthorized();

  const cfg = loadConfig();
  const url = new URL(req.url);
  const maxAgeParam = url.searchParams.get("maxAgeHours");
  const all = url.searchParams.get("all") === "1";
  const filterGlob = url.searchParams.get("filter");
  const statuses = parseStatuses(url.searchParams.get("status"));
  const maxAgeHours = maxAgeParam ? Number(maxAgeParam) : cfg.maxAgeHours;

  const now = Math.floor(Date.now() / 1000);
  const ds = getDataSource();
  const summaries = (await ds.snapshot())
    .filter((s) => sessionMatches(s, { maxAgeHours, all, filterGlob, statuses, now }))
    .sort((a, b) => b.ref.mtime - a.ref.mtime);

  const projects = groupByProject(summaries);
  // groupByProject drops child (sub-agent) sessions — they nest under their
  // parent client-side. Return them alongside so the SSE-reconnect snapshot
  // (fetchSnapshot) restores children too; otherwise finished sub-agents, which
  // never re-emit, vanish from the view after any reconnect.
  const children = summaries.filter((s) => s.ref.parentId);
  return Response.json(
    { projects, children },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}
