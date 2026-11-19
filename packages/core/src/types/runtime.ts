export const RUNTIME_DEFAULTS = Object.freeze({ staleAfterMs: 120_000, processProbeTimeoutMs: 1_000, listLimit: 200, maxBodyBytes: 16_384, pollIntervalMs: 2_000 });

/** Observations are facts; a session/turn ending never proves work completion. */
export const RUNTIME_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "Elicitation", "ElicitationResult", "Stop", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop"] as const;
export type RuntimeEventName = typeof RUNTIME_EVENTS[number];
export interface RuntimeEvent {
  eventId: string;
  sessionId: string;
  agentId: string | null;
  eventName: RuntimeEventName;
  observedAt: number;
  toolName: string | null;
  notificationType: string | null;
  processPid: number | null;
  processIdentity: string | null;
}
export interface RuntimeProcessProbe {
  state: "alive" | "exited" | "unknown";
  observedAt: number;
  reason: "matched" | "missing" | "identity_changed" | "probe_failed" | "unavailable";
}
export interface RuntimeState {
  processState: "alive" | "exited" | "unknown";
  activityState: "working" | "tool_requested" | "permission_requested" | "approval_wait" | "input_wait" | "idle" | "unknown";
  freshness: "fresh" | "stale" | "unsupported";
  outcome: "unknown" | "response_ended" | "response_failed" | "session_ended";
  lastObservedAt: number | null;
  lastEventAt: number | null;
  lastEventName: RuntimeEventName | null;
  lastToolName: string | null;
  interventionRequired: boolean;
  evidence: string[];
}
export interface RuntimeRun extends RuntimeState {
  runId: string;
  /** Ledger provider ("claude-code", "codex"); Codex state comes from its rollout log, not hooks. */
  providerId: string;
  sessionId: string;
  agentId: string | null;
  parentRunId: string | null;
  projectId: string | null;
  projectLabel: string | null;
  workItems: { id: string; title: string }[];
}
export interface RuntimeReport {
  asOf: number;
  /** Receiver token configured; does not imply Claude settings were installed or events received. */
  hookConfigured: boolean;
  staleAfterMs: number;
  runs: RuntimeRun[];
  total: number;
  truncated: boolean;
  interventionCount: number;
}
