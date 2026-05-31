import { describe, expect, it } from "vitest";
import { runnerFromEntrypoint } from "../util/runner.js";

describe("runnerFromEntrypoint", () => {
  it("maps claude-desktop", () => {
    expect(runnerFromEntrypoint("claude-desktop", "/Users/x/proj")).toBe("claude-desktop");
  });

  it("maps cli and sdk-cli to claude-code", () => {
    expect(runnerFromEntrypoint("cli", "/Users/x/proj")).toBe("claude-code");
    expect(runnerFromEntrypoint("sdk-cli", "/Users/x/proj")).toBe("claude-code");
  });

  it("maps sdk-ts under a conductor workspace to conductor", () => {
    expect(
      runnerFromEntrypoint("sdk-ts", "/Users/x/conductor/workspaces/proj/lisbon"),
    ).toBe("conductor");
  });

  it("maps sdk-ts outside conductor to agent", () => {
    expect(runnerFromEntrypoint("sdk-ts", "/Users/x/gstack-ui-projects/foo")).toBe("agent");
  });

  it("falls back to unknown for null/undefined/unrecognized", () => {
    expect(runnerFromEntrypoint(null, "/Users/x/proj")).toBe("unknown");
    expect(runnerFromEntrypoint(undefined, "/Users/x/proj")).toBe("unknown");
    expect(runnerFromEntrypoint("weird", "/Users/x/proj")).toBe("unknown");
  });
});
