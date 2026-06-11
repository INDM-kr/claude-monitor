import { promises as fs } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";

/** One token-bearing assistant turn. ts = epoch seconds. */
export interface UsageEvent {
  ts: number;
  tokens: number;
}

const BLOCK_SEC = 5 * 3600; // Claude's 5-hour rate-limit window
const WEEK_SEC = 7 * 86400;

/**
 * Approximate per-turn token usage. cache_read is excluded on purpose: it is a
 * re-read of already-counted context, so summing it across turns double-counts
 * the window and is meaningless as a usage total. This is an ESTIMATE, not the
 * account's official rate-limit accounting.
 */
export function usageTokens(u: Record<string, unknown> | null | undefined): number {
  if (!u) return 0;
  const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return n("input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
}

export interface UsageLimits {
  block: number | null;
  week: number | null;
}

export interface UsageWindows {
  /** Current 5-hour block (Claude's session window). */
  block: {
    tokens: number;
    startSec: number | null;
    resetSec: number | null;
    active: boolean;
    /** Largest PRIOR block in the scan — the gauge denominator when no explicit
     *  limit is configured ("vs your recent peak"). 0 if no prior block. */
    peakPrior: number;
  };
  /** Rolling last 7 days (no fixed reset anchor available locally). */
  week: { tokens: number; sinceSec: number };
  /** Configured token limits (gauge denominator); null → fall back to peakPrior. */
  limits: UsageLimits;
  totalEvents: number;
  now: number;
  /** Estimate disclaimer surfaced to the UI. */
  estimated: true;
}

/** Pure: bucket events into the current 5h block + rolling 7d window. */
export function computeUsageWindows(
  events: UsageEvent[],
  now: number,
  limits: UsageLimits = { block: null, week: null },
): UsageWindows {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  // 5h blocks: a fixed 5h window from the block's first event; an event >=5h
  // after the current block's start opens a new block.
  const blocks: { start: number; tokens: number }[] = [];
  for (const e of sorted) {
    const cur = blocks[blocks.length - 1];
    if (!cur || e.ts - cur.start >= BLOCK_SEC) {
      blocks.push({ start: e.ts, tokens: e.tokens });
    } else {
      cur.tokens += e.tokens;
    }
  }
  const current = blocks[blocks.length - 1] ?? null;
  const resetSec = current ? current.start + BLOCK_SEC : null;
  const active = resetSec != null && now < resetSec;
  const prior = blocks.slice(0, -1);
  const peakPrior = prior.length > 0 ? Math.max(...prior.map((b) => b.tokens)) : 0;

  const weekSince = now - WEEK_SEC;
  let weekTokens = 0;
  for (const e of sorted) if (e.ts >= weekSince) weekTokens += e.tokens;

  return {
    block: {
      tokens: active && current ? current.tokens : 0,
      startSec: active && current ? current.start : null,
      resetSec: active ? resetSec : null,
      active,
      peakPrior,
    },
    week: { tokens: weekTokens, sinceSec: weekSince },
    limits,
    totalEvents: events.length,
    now,
    estimated: true,
  };
}

async function* walkJsonl(dir: string): AsyncIterable<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.name.endsWith(".jsonl")) yield full;
  }
}

/** Scan transcripts (account-wide) for token-bearing turns within the last 7 days. */
export async function collectUsageEvents(projectsDir: string, now: number): Promise<UsageEvent[]> {
  const cutoff = now - WEEK_SEC;
  const events: UsageEvent[] = [];
  for await (const file of walkJsonl(projectsDir)) {
    const st = await fs.stat(file).catch(() => null);
    if (!st || st.mtimeMs / 1000 < cutoff) continue; // bound the scan to recent files
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"') || !line.includes('"timestamp"')) continue;
      try {
        const o = JSON.parse(line) as {
          timestamp?: string;
          message?: { usage?: Record<string, unknown> };
        };
        const tokens = usageTokens(o.message?.usage);
        if (tokens <= 0) continue;
        const ts = o.timestamp ? Math.floor(Date.parse(o.timestamp) / 1000) : NaN;
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        events.push({ ts, tokens });
      } catch {
        /* skip malformed line */
      }
    }
  }
  return events;
}

let cache: { at: number; data: UsageWindows } | null = null;
const TTL_MS = 20_000;

/** Cached account-wide usage windows (20s TTL — the scan is non-trivial). */
export async function aggregateUsage(): Promise<UsageWindows> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const now = Math.floor(Date.now() / 1000);
  const cfg = loadConfig();
  const events = await collectUsageEvents(cfg.projectsDir, now);
  const data = computeUsageWindows(events, now, {
    block: cfg.blockTokenLimit,
    week: cfg.weeklyTokenLimit,
  });
  cache = { at: Date.now(), data };
  return data;
}
