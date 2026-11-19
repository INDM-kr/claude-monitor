import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RuntimeEventName, RuntimeProcessProbe } from "../../types/runtime.js";
import { deriveRuntimeState } from "../runtime-state.js";
const now = 1_000_000, stale = 120_000;
const event = (eventName: RuntimeEventName, values: Partial<RuntimeEvent> = {}): RuntimeEvent => ({ eventId: "event", sessionId: "session", agentId: null, eventName, observedAt: now, toolName: null, notificationType: null, processPid: null, processIdentity: null, ...values });
const alive: RuntimeProcessProbe = { state: "alive", reason: "matched", observedAt: now };
describe("honest runtime state", () => {
  it("does not invent state from a historical run without hooks", () => {
    expect(deriveRuntimeState(null, null, now, stale)).toMatchObject({ freshness: "unsupported", processState: "unknown", activityState: "unknown", outcome: "unknown", interventionRequired: false });
  });
  it("keeps a long tool alive while activity becomes stale, without claiming completion", () => {
    expect(deriveRuntimeState(event("PreToolUse", { observedAt: now - stale - 1, toolName: "Bash" }), alive, now, stale)).toMatchObject({ processState: "alive", activityState: "unknown", freshness: "stale", outcome: "unknown" });
  });
  it("PermissionRequest alone can be auto-denied and is not counted as waiting", () => {
    expect(deriveRuntimeState(event("PermissionRequest"), alive, now, stale)).toMatchObject({ activityState: "permission_requested", interventionRequired: false });
  });
  it("fresh explicit approval notification is actionable", () => {
    expect(deriveRuntimeState(event("Notification", { notificationType: "permission_prompt" }), alive, now, stale)).toMatchObject({ activityState: "approval_wait", interventionRequired: true });
  });
  it("does not revive an old approval wait by refreshing process liveness", () => {
    expect(deriveRuntimeState(event("Notification", { notificationType: "permission_prompt", observedAt: now - stale - 1 }), alive, now, stale)).toMatchObject({ processState: "alive", activityState: "unknown", interventionRequired: false });
  });
  it.each([event("Elicitation"), event("PreToolUse", { toolName: "AskUserQuestion" })])("supports explicit input request and clears it when answered", input => {
    expect(deriveRuntimeState(input, alive, now, stale).interventionRequired).toBe(true);
    expect(deriveRuntimeState(event("ElicitationResult"), alive, now, stale).interventionRequired).toBe(false);
  });
  it("a question tool reaches Claude Code 2.1 through the permission flow and stays an input wait", () => {
    expect(deriveRuntimeState(event("PermissionRequest", { toolName: "AskUserQuestion" }), alive, now, stale)).toMatchObject({ activityState: "input_wait", interventionRequired: true });
    expect(deriveRuntimeState(event("Notification", { notificationType: "permission_prompt", toolName: "AskUserQuestion" }), alive, now, stale)).toMatchObject({ activityState: "input_wait", interventionRequired: true });
    expect(deriveRuntimeState(event("Notification", { notificationType: "permission_prompt", toolName: "Bash" }), alive, now, stale)).toMatchObject({ activityState: "approval_wait", interventionRequired: true });
  });
  it("normal session exit and response finish never prove work success", () => {
    expect(deriveRuntimeState(event("Stop"), alive, now, stale).outcome).toBe("response_ended");
    expect(deriveRuntimeState(event("SessionEnd"), alive, now, stale)).toMatchObject({ outcome: "session_ended", processState: "alive", activityState: "unknown" });
  });
  it("forced exit or reused PID cancels the intervention count without inventing failure", () => {
    expect(deriveRuntimeState(event("Notification", { notificationType: "permission_prompt" }), { state: "exited", reason: "identity_changed", observedAt: now }, now, stale)).toMatchObject({ processState: "exited", activityState: "unknown", interventionRequired: false, outcome: "unknown" });
  });
  it("probe error is unknown rather than exited", () => {
    expect(deriveRuntimeState(event("UserPromptSubmit"), { state: "unknown", reason: "probe_failed", observedAt: now }, now, stale).processState).toBe("unknown");
  });
  it("stale or future probes cannot assert process liveness", () => {
    for (const observedAt of [now - stale - 1, now + 1]) expect(deriveRuntimeState(null, { ...alive, observedAt }, now, stale).processState).toBe("unknown");
  });
  it("idle notification and tool errors are not user waits or business failure", () => {
    expect(deriveRuntimeState(event("Notification", { notificationType: "idle_prompt" }), alive, now, stale).interventionRequired).toBe(false);
    expect(deriveRuntimeState(event("PostToolUseFailure"), alive, now, stale).outcome).toBe("unknown");
  });
});
