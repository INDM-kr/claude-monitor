import type { SessionRef } from "@claude-monitor/core";
import {
  CODEX_ADAPTER_ID,
  readCodexTokenTimeline,
  readCodexUsageSeries,
  readTokenTimeline,
  readUsageSeries,
  type UsagePoint,
} from "@claude-monitor/adapter-claude-code";

type SeriesRef = Pick<SessionRef, "adapterId" | "source">;

/** Context-occupancy trend for the session detail page, by adapter. The Claude
 *  readers parse Claude/cowork record shapes and yield nothing for a Codex
 *  rollout file, so the dispatch is by adapterId, not by sniffing the file. */
export function usageSeriesFor(ref: SeriesRef): Promise<UsagePoint[]> {
  return ref.adapterId === CODEX_ADAPTER_ID ? readCodexUsageSeries(ref.source) : readUsageSeries(ref.source);
}

/** Tokens-processed timeline for project activity aggregation, by adapter. */
export function tokenTimelineFor(ref: SeriesRef): Promise<UsagePoint[]> {
  return ref.adapterId === CODEX_ADAPTER_ID ? readCodexTokenTimeline(ref.source) : readTokenTimeline(ref.source);
}
