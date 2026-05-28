import { getDataSource } from "../../../lib/data-source/local";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const ds = getDataSource();
  const adapters = ds.adapters().map((a) => ({ id: a.id, displayName: a.displayName }));
  const sessions = (await ds.snapshot()).length;
  return Response.json(
    { ok: true, adapters, sessions },
    { headers: { "cache-control": "no-store" } },
  );
}
