import { loadConfig } from "../config";

export interface AuthCheckResult {
  ok: boolean;
  status: number;
}

const OK: AuthCheckResult = { ok: true, status: 200 };

export function checkBearer(request: Request): AuthCheckResult {
  const { bearerToken } = loadConfig();
  if (!bearerToken) return OK;
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m && m[1] === bearerToken) return OK;
  return { ok: false, status: 401 };
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
