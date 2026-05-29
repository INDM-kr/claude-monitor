import { readFile } from "node:fs/promises";
import { usageContextTokens } from "./parser.js";

export interface UsagePoint {
  ts: number; // epoch ms
  tokens: number;
}

const MAX_POINTS = 500;

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
    let obj: { type?: string; timestamp?: string; message?: { usage?: Record<string, unknown> } };
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj.type !== "assistant" || !obj.message?.usage) continue;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    out.push({ ts, tokens: usageContextTokens(obj.message.usage) });
  }
  return out.slice(-MAX_POINTS);
}
