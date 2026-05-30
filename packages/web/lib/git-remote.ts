import { exec } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(exec);

export interface RemoteProject {
  /** Unification key, e.g. "git:github.com/nexist/claude-monitor" */
  key: string;
  /** Display label, e.g. "claude-monitor" */
  label: string;
}

/**
 * Normalize a git remote URL into a canonical `host/owner/repo` project identity.
 * Handles the three common forms:
 *   - scp-like:  git@github.com:nexist/claude-monitor.git
 *   - https/ssh: https://github.com/nexist/claude-monitor.git
 *   - ssh://:    ssh://git@github.com/nexist/claude-monitor
 * Returns null if the string isn't a recognizable remote URL.
 */
export function normalizeRemote(url: string): RemoteProject | null {
  let u = (url ?? "").trim();
  if (!u) return null;
  u = u.replace(/\.git$/i, "");

  // scp-like: [user@]host:path  (no scheme, has a colon before the path)
  let m = u.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
  if (m && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    return mk(m[1]!, m[2]!);
  }

  // scheme://[user@]host[:port]/path
  m = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (m) {
    return mk(m[1]!, m[2]!);
  }

  return null;
}

function mk(host: string, path: string): RemoteProject {
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const label = clean.split("/").pop() || clean;
  return { key: `git:${host.toLowerCase()}/${clean}`, label };
}

// cwd → resolved remote (or null). Permanent per process — remotes rarely change;
// a restart re-resolves. Avoids spawning `git` on every snapshot.
const cache = new Map<string, RemoteProject | null>();

/**
 * Resolve the origin remote of the repo at `cwd` into a project identity.
 * Returns null when `cwd` is gone, not a git repo, or has no origin remote —
 * callers fall back to the cwd-derived projectKey in that case.
 */
export async function remoteProject(cwd: string): Promise<RemoteProject | null> {
  if (!cwd) return null;
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;

  let result: RemoteProject | null = null;
  try {
    const { stdout } = await pexec("git remote get-url origin", { cwd, timeout: 2000 });
    result = normalizeRemote(stdout);
  } catch {
    result = null; // cwd missing / not a repo / no origin
  }
  cache.set(cwd, result);
  return result;
}
