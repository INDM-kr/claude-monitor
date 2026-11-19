import { localRead, localWrite } from "../../../lib/local-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(request: Request): Promise<Response> { return localRead(request, "local.settings"); }
export function POST(request: Request): Promise<Response> { return localWrite(request, { update: "local.updateSettings" }); }
