export type SessionStatus = "live" | "idle" | "stop";

export interface SessionRef {
  /** Adapter-scoped unique id (e.g., Claude session UUID) */
  id: string;
  /** Adapter id, e.g., "claude-code" */
  adapterId: string;
  /** Decoded workspace path (display) */
  workspace: string;
  /** Short workspace label (e.g., "indm-codegen/wt:budapest") */
  workspaceShort: string;
  /** Absolute path to source file/log */
  source: string;
  /** mtime epoch seconds */
  mtime: number;
}

export interface PendingSubagent {
  id: string;
  desc: string;
}

export interface TodoSnapshot {
  total: number;
  done: number;
  current: string | null;
  next: string | null;
}

export interface SessionSummary {
  ref: SessionRef;
  status: SessionStatus;
  lastTool: string | null;
  pendingSubagents: PendingSubagent[];
  todo: TodoSnapshot | null;
  /** Last assistant text, truncated to 200 chars to match CLI behavior */
  lastText: string | null;
  /** epoch seconds when this summary was computed */
  updatedAt: number;
}
