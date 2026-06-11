import type { NextRequest } from "next/server";
import { aggregateUsage } from "../../../lib/usage";
import { checkBearer, unauthorized } from "../../../lib/auth/middleware";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const auth = checkBearer(req);
  if (!auth.ok) return unauthorized();
  const data = await aggregateUsage();
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
