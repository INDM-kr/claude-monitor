import type { RuntimeEvent, RuntimeProcessProbe, RuntimeState } from "../types/runtime.js";

/** Pure reducer. Probes refresh liveness, never the freshness of a wait event. */
export function deriveRuntimeState(event: RuntimeEvent | null, probe: RuntimeProcessProbe | null, now: number, staleAfterMs: number): RuntimeState {
  const eventFresh = !!event && event.observedAt <= now && now - event.observedAt <= staleAfterMs;
  const probeFresh = !!probe && probe.observedAt <= now && now - probe.observedAt <= staleAfterMs;
  const processState = probeFresh ? probe!.state : "unknown";
  let activityState: RuntimeState["activityState"] = "unknown";
  let outcome: RuntimeState["outcome"] = "unknown";
  const evidence: string[] = [];
  if (event) {
    evidence.push(`hook:${event.eventName}`);
    switch (event.eventName) {
      case "SessionStart": case "Stop": case "SubagentStop": activityState = "idle"; break;
      case "UserPromptSubmit": case "PostToolUse": case "PostToolUseFailure": case "ElicitationResult": case "SubagentStart": activityState = "working"; break;
      case "PreToolUse": activityState = event.toolName === "AskUserQuestion" ? "input_wait" : "tool_requested"; break;
      // Claude Code 2.1 routes AskUserQuestion through the permission flow; it still waits for an answer.
      case "PermissionRequest": activityState = event.toolName === "AskUserQuestion" ? "input_wait" : "permission_requested"; break;
      case "Elicitation": activityState = "input_wait"; break;
      case "Notification":
        if (event.notificationType === "permission_prompt") activityState = event.toolName === "AskUserQuestion" ? "input_wait" : "approval_wait";
        else if (["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"].includes(event.notificationType ?? "")) activityState = "input_wait";
        else if (event.notificationType === "idle_prompt") activityState = "idle";
        break;
    }
    if (event.eventName === "Stop" || event.eventName === "SubagentStop") outcome = "response_ended";
    if (event.eventName === "StopFailure") outcome = "response_failed";
    if (event.eventName === "SessionEnd") outcome = "session_ended";
  }
  if (probe) evidence.push(`process:${probe.reason}`);
  if (!eventFresh || processState === "exited" || outcome === "session_ended") activityState = "unknown";
  const interventionRequired = eventFresh && processState !== "exited" && (activityState === "approval_wait" || activityState === "input_wait");
  return { processState, activityState, freshness: !event ? "unsupported" : eventFresh ? "fresh" : "stale", outcome,
    lastObservedAt: Math.max(event?.observedAt ?? 0, probe?.observedAt ?? 0) || null,
    lastEventAt: event?.observedAt ?? null, lastEventName: event?.eventName ?? null, lastToolName: event?.toolName ?? null,
    interventionRequired, evidence };
}
