import { timingSafeEqual } from "node:crypto";
import { resolveRuntimeHookToken } from "@claude-monitor/collector/runtime-token";
/** Hooks are opt-in and always require a separate bearer token, including on loopback. */
export function checkRuntimeHook(request: Request): "ok" | "disabled" | "unauthorized" {
  const { token } = resolveRuntimeHookToken();
  if (!token) return "disabled";
  const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(token), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "unauthorized";
}
