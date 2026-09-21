import type { SessionRef } from "@claude-monitor/core";
import { getDataSource } from "./data-source/local";
import { tokenTimelineFor } from "./token-series";

export interface ProjectActivity {
  projectKey: string;
  projectLabel: string;
  sessionCount: number;
  totalTokens: number;
  /** epoch seconds of the earliest token event (project start), or null. */
  startSec: number | null;
  /** "YYYY-MM-DD" (local) → tokens that day. For the contribution heatmap. */
  daily: Record<string, number>;
  /** [weekday 0-6 (Sun)][hour 0-23] → tokens. For the time-of-day pattern. */
  weekdayHour: number[][];
}

/**
 * Aggregate one project's token usage over time from its session transcripts.
 * Scans every transcript whose projectKey matches (roots + sub-agents), bucketing
 * tokens by local date and by weekday×hour. Computed on demand (force-dynamic);
 * cost scales with the project's transcript volume.
 */
export async function getProjectActivity(projectKey: string): Promise<ProjectActivity | null> {
  const ds = getDataSource();
  const sessions = (await ds.snapshot()).filter((s) => s.ref.projectKey === projectKey);
  if (sessions.length === 0) return null;

  // One read per transcript file; the ref picks the adapter-specific reader.
  const byPath = new Map<string, SessionRef>();
  for (const s of sessions) if (!byPath.has(s.ref.source)) byPath.set(s.ref.source, s.ref);
  const daily: Record<string, number> = {};
  const weekdayHour: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let totalTokens = 0;
  let startMs: number | null = null;

  for (const ref of byPath.values()) {
    const events = await tokenTimelineFor(ref);
    for (const e of events) {
      if (e.tokens <= 0) continue;
      const d = new Date(e.ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      daily[key] = (daily[key] ?? 0) + e.tokens;
      const row = weekdayHour[d.getDay()];
      if (row) row[d.getHours()] = (row[d.getHours()] ?? 0) + e.tokens;
      totalTokens += e.tokens;
      if (startMs == null || e.ts < startMs) startMs = e.ts;
    }
  }

  return {
    projectKey,
    projectLabel: sessions[0]!.ref.projectLabel,
    sessionCount: sessions.filter((s) => !s.ref.parentId).length,
    totalTokens,
    startSec: startMs != null ? Math.floor(startMs / 1000) : null,
    daily,
    weekdayHour,
  };
}
