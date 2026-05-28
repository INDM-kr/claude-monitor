/**
 * Produce a human-friendly short label for a workspace path.
 *
 * Rules (mirrors bin/claude-monitor:99 sed transform):
 *   - Strip leading "/Users/<user>/" prefix.
 *   - Strip "conductor/workspaces/" if present.
 *   - Strip a trailing ".worktrees/<name>" segment, label it as "wt:<name>".
 *   - Collapse remaining repeated slashes.
 *
 * If the path can't be shortened, return it unchanged.
 */
export function shortenWorkspace(absPath: string): string {
  if (!absPath) return absPath;

  let p = absPath;

  // Strip /Users/<user>/
  p = p.replace(/^\/Users\/[^/]+\//, "");

  // Strip conductor/workspaces/
  p = p.replace(/^conductor\/workspaces\//, "");

  // .worktrees/<name>  →  /wt:<name>
  const wtMatch = p.match(/^(.+?)\/\.worktrees\/([^/]+)\/?$/);
  if (wtMatch) {
    p = `${wtMatch[1]}/wt:${wtMatch[2]}`;
  }

  // Collapse duplicate slashes
  p = p.replace(/\/{2,}/g, "/");

  // Trim trailing slash
  p = p.replace(/\/$/, "");

  return p || absPath;
}
