import { localRead, localWrite } from "../../../lib/local-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(request: Request): Promise<Response> { return localRead(request, "local.diagnostics"); }
export function POST(request: Request): Promise<Response> { return localWrite(request, { backup: "local.backup", preview: "local.purgePreview", purge: "local.purge" }); }
