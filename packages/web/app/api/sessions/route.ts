import type { NextRequest } from "next/server";
import type { SessionSummary } from "@claude-monitor/core";
import { getDataSource } from "../../../lib/data-source/local";
import { checkBearer, unauthorized } from "../../../lib/auth/middleware";
import { loadConfig } from "../../../lib/config";
import { sessionMatches } from "../../../lib/filter";

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
  const maxAgeHours = maxAgeParam ? Number(maxAgeParam) : cfg.maxAgeHours;

  const now = Math.floor(Date.now() / 1000);
  const ds = getDataSource();
  const summaries = (await ds.snapshot())
    .filter((s) => sessionMatches(s, { maxAgeHours, all, filterGlob, now }))
    .sort((a, b) => b.ref.mtime - a.ref.mtime);

  const projects = groupByProject(summaries);
  return Response.json(
    { projects },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}

function groupByProject(list: SessionSummary[]) {
  const map = new Map<string, { projectKey: string; projectLabel: string; sessions: SessionSummary[] }>();
  for (const s of list) {
    const key = s.ref.projectKey;
    let g = map.get(key);
    if (!g) {
      g = { projectKey: key, projectLabel: s.ref.projectLabel, sessions: [] };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  return [...map.values()];
}
