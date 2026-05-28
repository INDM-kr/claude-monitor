import type { NextRequest } from "next/server";
import { getDataSource } from "../../../lib/data-source/local";
import { checkBearer, unauthorized } from "../../../lib/auth/middleware";
import { loadConfig } from "../../../lib/config";

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

  const ds = getDataSource();
  let summaries = await ds.snapshot();

  if (!all && Number.isFinite(maxAgeHours)) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeHours * 3600;
    summaries = summaries.filter((s) => s.ref.mtime >= cutoff);
  }
  if (filterGlob) {
    const re = globToRegExp(filterGlob);
    summaries = summaries.filter((s) => re.test(s.ref.workspace) || re.test(s.ref.workspaceShort));
  }

  summaries.sort((a, b) => b.ref.mtime - a.ref.mtime);

  const projects = groupByWorkspace(summaries);
  return Response.json(
    { projects },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}

function groupByWorkspace(list: typeof Array.prototype) {
  const byWs = new Map<string, { workspace: string; workspaceShort: string; sessions: unknown[] }>();
  for (const s of list as Array<{ ref: { workspace: string; workspaceShort: string } }>) {
    const key = s.ref.workspace;
    let g = byWs.get(key);
    if (!g) {
      g = { workspace: s.ref.workspace, workspaceShort: s.ref.workspaceShort, sessions: [] };
      byWs.set(key, g);
    }
    g.sessions.push(s);
  }
  return [...byWs.values()];
}

function globToRegExp(g: string): RegExp {
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(re);
}
