import type { NextRequest } from "next/server";
import { aggregateUsage } from "../../../lib/usage";
import { fetchOAuthUsage } from "../../../lib/usage-remote";
import { checkBearer, unauthorized } from "../../../lib/auth/middleware";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const auth = checkBearer(req);
  if (!auth.ok) return unauthorized();
  // Authoritative usage from the OAuth endpoint when available; the local
  // transcript estimate is always computed as the fallback + token detail.
  const [local, api] = await Promise.all([aggregateUsage(), fetchOAuthUsage()]);
  const body = { source: api ? "api" : "estimate", api, local, now: local.now };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
