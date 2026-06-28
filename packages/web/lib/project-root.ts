import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

/**
 * Markers that identify a real project root for NON-git sessions. Deliberately
 * EXCLUDES language manifests (package.json, composer.json, pyproject.toml, …):
 * a plugin or dependency installed INTO a project carries those, and must not
 * become its own group (e.g. pickko's `.reversa` plugin dir). VCS dirs and
 * CLAUDE.md are project/user-level root signals, not dependency-level ones.
 */
export const ROOT_MARKERS = [".git", ".hg", ".svn", "CLAUDE.md"] as const;

export interface ProjectRoot {
  /** Absolute path of the detected root (used as the projectKey). */
  key: string;
  /** Display label (basename of the root). */
  label: string;
}

// cwd → detected root (or null). Permanent per process — markers rarely move;
// a restart re-resolves. Mirrors git-remote.ts's cache.
const cache = new Map<string, ProjectRoot | null>();

async function hasMarker(dir: string): Promise<boolean> {
  for (const m of ROOT_MARKERS) {
    const ok = await fs.stat(join(dir, m)).then(
      () => true,
      () => false,
    );
    if (ok) return true;
  }
  return false;
}

function isUnder(dir: string, base: string): boolean {
  return dir === base || dir.startsWith(base + sep);
}

/**
 * Nearest ancestor of `cwd` (inclusive) that looks like a project root — i.e.
 * contains a VCS dir or CLAUDE.md. Walks up, stopping BELOW `stopBelow` (the
 * home dir by default) so it never folds everything under $HOME into one group.
 * Returns null when no marker is found, so the caller keeps the cwd-derived key.
 *
 * Used only as the non-git fallback in enrich(): a `git:` remote already unifies
 * clones/worktrees across paths; this folds subfolders of a NON-git project
 * (e.g. a `_plan` planning dir) into the project root that owns them.
 *
 * @param stopBelow exclusive boundary — the walk never inspects this dir or
 *        anything above it (default: the OS home directory).
 */
export async function findProjectRoot(
  cwd: string,
  stopBelow: string = homedir(),
): Promise<ProjectRoot | null> {
  if (!cwd) return null;
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;

  let dir = cwd.replace(/\/+$/, "");
  let result: ProjectRoot | null = null;
  // Walk up while STRICTLY inside stopBelow (never treat the boundary itself,
  // e.g. $HOME, as a root).
  while (dir !== stopBelow && isUnder(dir, stopBelow) && dir.length > stopBelow.length) {
    if (await hasMarker(dir)) {
      result = { key: dir, label: basename(dir) };
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(cwd, result);
  return result;
}
