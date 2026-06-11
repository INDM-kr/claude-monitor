export type SessionStatus = "live" | "idle" | "stop";

export type RunnerKind = "conductor" | "claude-code" | "claude-desktop" | "agent" | "unknown";

/** Lifecycle of a sub-agent / workflow child run (not used for top-level sessions). */
export type AgentStatus = "done" | "cancelled" | "error" | "running";

export interface AgentMetrics {
  /** Σ tokens processed (input + cache_creation + output). */
  tokens: number;
  /** Number of tool calls. */
  tools: number;
  /** Wall-clock duration of the run, seconds. */
  durationSec: number;
}

export interface ContextUsage {
  /** 추정 컨텍스트 점유 토큰 (input + cache_read + cache_creation) */
  tokens: number;
  /** 모델 컨텍스트 윈도우 한도 */
  limit: number;
  /** tokens / limit, 0..1 (clamp) */
  pct: number;
}

export interface SessionRef {
  /** Adapter-scoped unique id (e.g., Claude session UUID) */
  id: string;
  /** Adapter id, e.g., "claude-code" */
  adapterId: string;
  /** Decoded workspace path (display) */
  workspace: string;
  /** Short workspace label (e.g., "indm-codegen/wt:budapest") */
  workspaceShort: string;
  /** 통합 키 — transcript cwd서 파생 (decoded dir 아님) */
  projectKey: string;
  /** 표시명 */
  projectLabel: string;
  /** OS 유저 (장래 팀 그룹용) */
  owner: string;
  /** Absolute path to source file/log */
  source: string;
  /** mtime epoch seconds */
  mtime: number;
  /** For sub-agent/workflow child transcripts: the parent session UUID
   *  (from the `<UUID>/subagents/` path). Undefined for normal/root sessions. */
  parentId?: string;
  /** Workflow run id (`wf_*`) when the child is under a workflow run; else undefined. */
  wfId?: string;
}

export interface PendingSubagent {
  id: string;
  desc: string;
  /** subagent_type from the Task/Agent tool input, when present (e.g. "Explore"). */
  type: string | null;
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
  /** Salient target of the last tool call (Bash description, edited file, grep
   *  pattern…) — "what it's doing now", beyond the bare tool name. */
  lastActivityDetail?: string | null;
  pendingSubagents: PendingSubagent[];
  todo: TodoSnapshot | null;
  /** Last assistant text, truncated to 200 chars to match CLI behavior */
  lastText: string | null;
  /** 세션 실행 러너 (프로세스 프로브서 보강; 기본 unknown) */
  runner: RunnerKind;
  /** 사용 모델 (<synthetic> 제외) */
  model: string | null;
  /** permissionMode */
  mode: string | null;
  /** Claude Code 버전 */
  version: string | null;
  /** 컨텍스트 사용량 */
  context: ContextUsage | null;
  /** 실행 프로세스 PID (존재 시 kill 가능) */
  pid: number | null;
  /** Workflow phase, for child agents that carry one (else null). */
  phase?: string | null;
  /** Lifecycle of a child sub-agent run (✔ done / ✗ cancelled·error / ◐ running);
   *  null for top-level sessions. */
  agentStatus?: AgentStatus | null;
  /** Per-run metrics for child agents (tokens · tools · duration). */
  metrics?: AgentMetrics | null;
  /** epoch seconds when this summary was computed */
  updatedAt: number;
}
