import type { NextRequest } from "next/server";
import { getDataSource } from "../../../../lib/data-source/local";
import { checkBearer, unauthorized } from "../../../../lib/auth/middleware";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<Response> {
  const auth = checkBearer(req);
  if (!auth.ok) return unauthorized();

  const url = new URL(req.url);
  const adapterId = url.searchParams.get("adapter") ?? "claude-code";
  const ds = getDataSource();
  const summary = await ds.getById(adapterId, ctx.params.id);
  if (!summary) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return Response.json(summary, { headers: { "cache-control": "no-store" } });
}
