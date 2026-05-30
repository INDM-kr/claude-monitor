import type { NextRequest } from "next/server";
import { checkBearer, unauthorized } from "../../../../../lib/auth/middleware";
import { killSession } from "../../../../../lib/process-kill";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<Response> {
  const auth = checkBearer(req);
  if (!auth.ok) return unauthorized();

  const result = await killSession(ctx.params.id);
  const status = result.ok ? 200 : result.reason === "not_found" ? 404 : 409;
  return new Response(JSON.stringify(result), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
