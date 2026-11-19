import { collectorStatus } from "../../../lib/collector";
import { checkBearer, unauthorized } from "../../../lib/auth/middleware";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (!checkBearer(request).ok) return unauthorized();
  return Response.json(collectorStatus(), { headers: { "cache-control": "no-store" } });
}
