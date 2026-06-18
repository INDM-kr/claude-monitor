/**
 * Sub-agent / workflow child transcripts live beside their parent session at:
 *   <projectsDir>/<encodedProj>/<PARENT-UUID>/subagents/agent-<id>.jsonl
 *   <projectsDir>/<encodedProj>/<PARENT-UUID>/subagents/workflows/wf_<id>/agent-<id>.jsonl
 *
 * The parent session UUID is the directory two (or more) levels above the
 * `subagents` segment. The agent file itself carries parentUuid:null in-line,
 * so the linkage MUST come from the path. This module is the single source of
 * truth for that layout (reused by the watcher, the reader, and tests).
 */

/** Composite child id, globally unique across parents. */
export function subagentChildId(parentUuid: string, agentId: string): string {
  return `${parentUuid}/${agentId}`;
}

export interface SubagentPathInfo {
  /** Parent session UUID (the dir owning the `subagents` folder). */
  parentUuid: string;
  /** Agent file stem, e.g. "agent-af30786086656f22c". */
  agentId: string;
  /** Composite child id = `${parentUuid}/${agentId}`. */
  childId: string;
  /** Workflow run id (`wf_<id>`) when under a `subagents/workflows/` run, else null. */
  wfId: string | null;
}

const AGENT_FILE_RE = /^agent-[^/]+\.jsonl$/i;

/**
 * Parse a `.../subagents/.../agent-<id>.jsonl` path into its parent/agent ids.
 * Returns null for any path that is not a sub-agent transcript (so callers can
 * branch cheaply). projectsDir is accepted for symmetry/validation but the
 * parse only relies on the `subagents` segment, so it is layout-robust.
 */
export function parentInfoFromSubagentPath(
  projectsDir: string,
  filePath: string,
): SubagentPathInfo | null {
  const segments = filePath.split("/");
  const fileName = segments[segments.length - 1] ?? "";
  if (!AGENT_FILE_RE.test(fileName)) return null;

  const subIdx = segments.lastIndexOf("subagents");
  if (subIdx <= 0) return null;
  const parentUuid = segments[subIdx - 1];
  if (!parentUuid) return null;

  // `subagents/workflows/wf_*/agent-*.jsonl` → capture the workflow run id.
  const wfId =
    segments[subIdx + 1] === "workflows" && segments[subIdx + 2]?.startsWith("wf_")
      ? segments[subIdx + 2]!
      : null;

  const agentId = fileName.replace(/\.jsonl$/i, "");
  return { parentUuid, agentId, childId: subagentChildId(parentUuid, agentId), wfId };
}
