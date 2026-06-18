import { exec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";

const pexec = promisify(exec);

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_BETA = "oauth-2025-04-20";
// The endpoint rate-limits aggressively (HTTP 429); 180s is the documented
// safe floor with the claude-code User-Agent. Kept tight so the % stays fresh
// near the limit (a longer cache made it read stale, e.g. 95% after a hit).
const CACHE_TTL_MS = 180_000;

/** Authoritative usage % + reset from Anthropic (same source Claude Code shows). */
export interface OAuthUsage {
  fiveHour: { pct: number; resetSec: number | null };
  sevenDay: { pct: number; resetSec: number | null };
}

function isoToSec(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
function pctOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Read the Claude Code OAuth access token from the macOS Keychain (server-side
 *  only — never returned to the browser). Returns null off-macOS / if denied. */
async function readToken(): Promise<string | null> {
  try {
    const { stdout } = await pexec(
      `security find-generic-password -s ${JSON.stringify(KEYCHAIN_SERVICE)} -w`,
      { timeout: 8000 },
    );
    const raw = stdout.trim();
    try {
      const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string }; accessToken?: string };
      return j.claudeAiOauth?.accessToken ?? j.accessToken ?? null;
    } catch {
      return raw.startsWith("sk-ant") ? raw : null;
    }
  } catch {
    return null;
  }
}

let cachedVersion: string | null = null;
/** Newest transcript's version, for the required `User-Agent: claude-code/<ver>`. */
async function ccVersion(projectsDir: string): Promise<string> {
  if (cachedVersion) return cachedVersion;
  let newest: { path: string; m: number } | null = null;
  for (const p of await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => [])) {
    if (!p.isDirectory()) continue;
    const dir = join(projectsDir, p.name);
    for (const f of await fs.readdir(dir).catch(() => [])) {
      if (!f.endsWith(".jsonl")) continue;
      const st = await fs.stat(join(dir, f)).catch(() => null);
      if (st && (!newest || st.mtimeMs > newest.m)) newest = { path: join(dir, f), m: st.mtimeMs };
    }
  }
  let ver = "2.1.0";
  if (newest) {
    const m = (await fs.readFile(newest.path, "utf8").catch(() => "")).match(/"version":"([0-9][^"]*)"/);
    if (m) ver = m[1]!;
  }
  cachedVersion = ver;
  return ver;
}

let cache: { at: number; data: OAuthUsage | null } | null = null;

/** Fetch authoritative usage from the OAuth endpoint. Cached 5min (incl. null,
 *  to avoid hammering a rate-limited endpoint). null → caller falls back. */
export async function fetchOAuthUsage(): Promise<OAuthUsage | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const cfg = loadConfig();
  let data: OAuthUsage | null = null;
  const token = await readToken();
  if (token) {
    try {
      const res = await fetch(ENDPOINT, {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": OAUTH_BETA,
          "user-agent": `claude-code/${await ccVersion(cfg.projectsDir)}`,
        },
        cache: "no-store",
      });
      if (res.ok) {
        const j = (await res.json()) as {
          five_hour?: { utilization?: unknown; resets_at?: unknown };
          seven_day?: { utilization?: unknown; resets_at?: unknown };
        };
        data = {
          fiveHour: { pct: pctOf(j.five_hour?.utilization), resetSec: isoToSec(j.five_hour?.resets_at) },
          sevenDay: { pct: pctOf(j.seven_day?.utilization), resetSec: isoToSec(j.seven_day?.resets_at) },
        };
      }
    } catch {
      /* network/parse error → null → fallback */
    }
  }
  cache = { at: Date.now(), data };
  return data;
}
