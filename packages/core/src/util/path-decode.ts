/**
 * Decode Claude Code's encoded workspace directory name back to an absolute path.
 * Claude Code stores each workspace under ~/.claude/projects/<encoded>/, where
 * "/" in the path is replaced by "-".
 *
 * NOTE: This transform is *not* injective — workspace paths that originally
 * contain "-" become ambiguous (they look identical to "/" segments). This
 * mirrors the behavior of bin/claude-monitor:40, intentionally preserved.
 */
export function decodePath(encoded: string): string {
  return encoded.replace(/-/g, "/");
}
