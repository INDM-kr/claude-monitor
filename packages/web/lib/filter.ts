import type { SessionSummary } from "@claude-monitor/core";

export function globToRegExp(g: string): RegExp {
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(re);
}

export interface FilterOpts {
  maxAgeHours: number | null;
  all: boolean;
  filterGlob: string | null;
  now: number; // epoch seconds
}

export function sessionMatches(s: SessionSummary, o: FilterOpts): boolean {
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
