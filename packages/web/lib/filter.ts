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

export function sessionMatches(s: SessionSummary, o: FilterOpts): boolean {
  if (o.statuses.length > 0 && !o.statuses.includes(s.status)) return false;
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
