import type { SessionSummary } from "@claude-monitor/core";

export function globToRegExp(g: string): RegExp {
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(re);
}

/** Parse the comma-separated `status` query param into a list of statuses. */
export function parseStatuses(csv: string | null | undefined): string[] {
  return (csv ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface FilterOpts {
  maxAgeHours: number | null;
  all: boolean;
  filterGlob: string | null;
  /** selected statuses ("live"|"idle"|"stop"); empty = any (multi-select) */
  statuses: string[];
  now: number; // epoch seconds
}

/**
 * @param statusOverride client-derived status (deriveStatus(now, mtime)). The
 * server omits it (s.status is fresh at read time); the client passes it so the
 * live view filters by the SAME status the badge shows — and so the live filter
 * (maxAge/glob/status) matches the server's refresh filter exactly.
 */
export function sessionMatches(
  s: SessionSummary,
  o: FilterOpts,
  statusOverride?: string,
): boolean {
  const status = statusOverride ?? s.status;
  if (o.statuses.length > 0 && !o.statuses.includes(status)) return false;
  if (!o.all && o.maxAgeHours != null && Number.isFinite(o.maxAgeHours)) {
    const cutoff = o.now - o.maxAgeHours * 3600;
    if (s.ref.mtime < cutoff) return false;
  }
  if (o.filterGlob) {
    const re = globToRegExp(o.filterGlob);
    if (!(re.test(s.ref.workspace) || re.test(s.ref.workspaceShort) || re.test(s.ref.projectLabel))) {
      return false;
    }
  }
  return true;
}
