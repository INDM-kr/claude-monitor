import { describe, expect, it } from "vitest";
import { decodePath } from "../util/path-decode.js";

describe("decodePath", () => {
  it("converts dashes back to slashes", () => {
    expect(decodePath("-Users-Nexist-projects-claude-monitor")).toBe("/Users/Nexist/projects/claude/monitor");
  });

  it("handles empty string", () => {
    expect(decodePath("")).toBe("");
  });
});
