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

export interface UsageWindows {
  /** Current 5-hour block (Claude's session window). */
  block: { tokens: number; startSec: number | null; resetSec: number | null; active: boolean };
  /** Rolling last 7 days (no fixed reset anchor available locally). */
  week: { tokens: number; sinceSec: number };
  totalEvents: number;
  now: number;
  /** Estimate disclaimer surfaced to the UI. */
  estimated: true;
}

/** Pure: bucket events into the current 5h block + rolling 7d window. */
export function computeUsageWindows(events: UsageEvent[], now: number): UsageWindows {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  // 5h blocks: a fixed 5h window from the block's first event; an event >=5h
  // after the current block's start opens a new block.
  let blockStart: number | null = null;
  let blockTokens = 0;
  for (const e of sorted) {
    if (blockStart === null || e.ts - blockStart >= BLOCK_SEC) {
      blockStart = e.ts;
      blockTokens = 0;
    }
    blockTokens += e.tokens;
  }
  const resetSec = blockStart != null ? blockStart + BLOCK_SEC : null;
  const active = resetSec != null && now < resetSec;

  const weekSince = now - WEEK_SEC;
  let weekTokens = 0;
  for (const e of sorted) if (e.ts >= weekSince) weekTokens += e.tokens;

  return {
    block: {
      tokens: active ? blockTokens : 0,
      startSec: active ? blockStart : null,
      resetSec: active ? resetSec : null,
      active,
    },
    week: { tokens: weekTokens, sinceSec: weekSince },
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
  const events = await collectUsageEvents(loadConfig().projectsDir, now);
  const data = computeUsageWindows(events, now);
  cache = { at: Date.now(), data };
  return data;
}
