import { getProcessCollector } from "@claude-monitor/collector";
import { checkBearer, unauthorized } from "../../../lib/auth/middleware";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  if (!checkBearer(request).ok) return unauthorized();
  try { return Response.json(await getProcessCollector().request("runtime.list"), { headers: { "cache-control": "no-store" } }); }
  catch { return Response.json({ error: "collector_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } }); }
}
