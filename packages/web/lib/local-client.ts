let bearer = "";
export function setLocalBearer(value: string): void { bearer = value.trim(); }
export function localHeaders(): Record<string, string> { return bearer ? { authorization: `Bearer ${bearer}` } : {}; }
export class LocalApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
const REQUEST_TIMEOUT_MS = 10000;
export async function localFetch<T>(path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(path, {
    method: payload === undefined ? "GET" : "POST", cache: "no-store", signal: requestSignal,
    headers: { ...localHeaders(), ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const data = await response.json();
  if (!response.ok) throw new LocalApiError(response.status, data.error || "request_failed");
  return data as T;
}
