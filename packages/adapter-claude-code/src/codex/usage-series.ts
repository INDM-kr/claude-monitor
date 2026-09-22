import { readFile } from "node:fs/promises";
import { MAX_POINTS, type UsagePoint } from "../usage-series.js";
import { foldCodex, initialCodex } from "./parser.js";

/**
 * Walk a rollout file with the same fold the reader uses, invoking `onToken`
 * once per folded token_count event, so a sub-agent's copied parent prefix is
 * excluded exactly as the reader excludes it and the timeline's Σ equals the
 * summary's totalTokens. One difference: a malformed (unparseable) line is
 * skipped here, whereas the reader stops at it and retries on the next pass
 * (see tailLines) — the two only diverge on a corrupt file.
 */
async function walkTokenEvents(
  source: string,
  onToken: (tsMs: number, deltaTokens: number, contextTokens: number) => void,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    return;
  }
  let state = initialCodex();
  let events = 0;
  let total = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      state = foldCodex(state, t);
    } catch {
      continue;
    }
    if (state.tokenEvents !== events) {
      events = state.tokenEvents;
      if (state.lastTsMs != null) onToken(state.lastTsMs, state.totalTokens - total, state.contextTokens ?? 0);
      total = state.totalTokens;
    }
  }
}

/** Context occupancy after each token_count event (session detail trend). */
export async function readCodexUsageSeries(source: string): Promise<UsagePoint[]> {
  const out: UsagePoint[] = [];
  await walkTokenEvents(source, (ts, _delta, context) => out.push({ ts, tokens: context }));
  return out.slice(-MAX_POINTS);
}

/** Tokens processed per token_count event (project activity heatmap). */
export async function readCodexTokenTimeline(source: string): Promise<UsagePoint[]> {
  const out: UsagePoint[] = [];
  await walkTokenEvents(source, (ts, delta) => out.push({ ts, tokens: delta }));
  return out;
}
