import { readFile } from "node:fs/promises";
import { metricTokens, usageContextTokens } from "./parser.js";

export interface UsagePoint {
  ts: number; // epoch ms
  tokens: number;
}

const MAX_POINTS = 500;

/** Timestamp (ms) of one transcript record, or NaN when it carries none.
 *  Cowork `audit.jsonl` records carry `_audit_timestamp` instead of a top-level
 *  `timestamp`; the cowork reader aliases it before `fold()`, but these readers
 *  parse the RAW source file, so they must accept both — otherwise every cowork
 *  event is dropped and the project/session pages show zero usage. */
function recordTsMs(obj: { timestamp?: string; _audit_timestamp?: string }): number {
  const raw = obj.timestamp ?? obj._audit_timestamp;
  return raw ? Date.parse(raw) : NaN;
}

export async function readUsageSeries(source: string): Promise<UsagePoint[]> {
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    return [];
  }
  const out: UsagePoint[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: { type?: string; timestamp?: string; _audit_timestamp?: string; message?: { usage?: Record<string, unknown> } };
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj.type !== "assistant" || !obj.message?.usage) continue;
    const ts = recordTsMs(obj);
    if (Number.isNaN(ts)) continue;
    out.push({ ts, tokens: usageContextTokens(obj.message.usage) });
  }
  return out.slice(-MAX_POINTS);
}

/** Every assistant token event (uncapped); tokens = metricTokens (input +
 *  cache_creation + output = work processed). For project-level activity
 *  aggregation (the contribution heatmap), where the context snapshot is wrong. */
export async function readTokenTimeline(source: string): Promise<UsagePoint[]> {
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    return [];
  }
  const out: UsagePoint[] = [];
  let lastId: string | null = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: { type?: string; timestamp?: string; _audit_timestamp?: string; message?: { id?: string; usage?: Record<string, unknown> } };
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj.type !== "assistant" || !obj.message?.usage) continue;
    const ts = recordTsMs(obj);
    if (Number.isNaN(ts)) continue;
    const point = { ts, tokens: metricTokens(obj.message.usage) };
    // One assistant message is split into per-content-block records that repeat
    // (or grow) the same usage — one point per message id, latest value wins,
    // so downstream sums don't overcount (same defect as the fold() dedup).
    const id = typeof obj.message.id === "string" && obj.message.id ? obj.message.id : null;
    if (id != null && id === lastId && out.length > 0) {
      out[out.length - 1] = point;
    } else {
      out.push(point);
      lastId = id;
    }
  }
  return out;
}
