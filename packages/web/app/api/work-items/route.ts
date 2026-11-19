import { localRead, localWrite } from "../../../lib/local-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(request: Request): Promise<Response> { return localRead(request, "work.list"); }
export function POST(request: Request): Promise<Response> {
  return localWrite(request, { create: "work.create", update: "work.update", linkRun: "work.linkRun", unlinkRun: "work.unlinkRun", artifact: "work.artifact", verify: "work.verify", reopen: "work.reopen" });
}
