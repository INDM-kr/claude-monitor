/**
 * Format seconds-ago into compact human label.
 * Mirrors bin/claude-monitor:42-48 `ago()`.
 */
export function ago(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Truncate string with ellipsis, preserving first n chars. */
export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/** Short session id — first 8 chars of UUID. */
export function shortSid(id: string): string {
  return id.slice(0, 8);
}
