import { describe, expect, it } from "vitest";
import { shortenWorkspace } from "../util/ws-shortener.js";

describe("shortenWorkspace", () => {
  it("strips /Users/<user>/", () => {
    expect(shortenWorkspace("/Users/Nexist/projects/foo")).toBe("projects/foo");
  });

  it("strips conductor/workspaces/", () => {
    expect(shortenWorkspace("/Users/Nexist/conductor/workspaces/budapest"))
      .toBe("budapest");
  });

  it("labels worktrees as wt:<name>", () => {
    expect(shortenWorkspace("/Users/Nexist/projects/indm-codegen/.worktrees/budapest"))
      .toBe("projects/indm-codegen/wt:budapest");
  });

  it("returns original when no rules match", () => {
    expect(shortenWorkspace("/var/log/something")).toBe("/var/log/something");
  });

  it("handles empty input", () => {
    expect(shortenWorkspace("")).toBe("");
  });
});
