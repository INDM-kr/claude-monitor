import { RUNTIME_DEFAULTS } from "@claude-monitor/core";
import { getProcessCollector } from "@claude-monitor/collector";
import { checkRuntimeHook } from "../../../../lib/runtime-auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const { maxBodyBytes } = RUNTIME_DEFAULTS;
export async function POST(request: Request): Promise<Response> {
  const auth = checkRuntimeHook(request);
  if (auth !== "ok") return Response.json({ error: auth === "disabled" ? "hooks_disabled" : "unauthorized" }, { status: auth === "disabled" ? 503 : 401 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "json_required" }, { status: 415 });
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return Response.json({ error: "payload_too_large" }, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "invalid_runtime_event" }, { status: 400 });
  let bytes = 0; const chunks: Uint8Array[] = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength;
    if (bytes > maxBodyBytes) { await reader.cancel(); return Response.json({ error: "payload_too_large" }, { status: 413 }); } chunks.push(value); }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  try {
    const result = await getProcessCollector().request("runtime.record", payload);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "collector_unavailable";
    const invalid = /^(invalid_runtime_|unsupported_runtime_event)/.test(code);
    return Response.json({ error: invalid ? code : "collector_unavailable" }, { status: invalid ? 400 : 503 });
  }
}
