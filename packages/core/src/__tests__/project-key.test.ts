import { describe, it, expect } from "vitest";
import { projectIdentityFromCwd } from "../util/project-key.js";

describe("projectIdentityFromCwd", () => {
  it("conductor 형제 worktree를 같은 키로 묶고 하이픈 보존", () => {
    const a = projectIdentityFromCwd("/Users/Nexist/conductor/workspaces/260507_gstack-ui/edinburgh");
    const b = projectIdentityFromCwd("/Users/Nexist/conductor/workspaces/260507_gstack-ui/lisbon");
    expect(a.key).toBe("conductor/260507_gstack-ui");
    expect(a.label).toBe("260507_gstack-ui");
    expect(a.key).toBe(b.key);
    expect(a.owner).toBe("Nexist");
  });

  it(".worktrees 형제를 repo 루트로 묶음", () => {
    const id = projectIdentityFromCwd("/Users/kim/repo/.worktrees/budapest");
    expect(id.key).toBe("/Users/kim/repo");
    expect(id.label).toBe("repo");
    expect(id.owner).toBe("kim");
  });

  it("평범 repo는 전체 cwd를 키로 (오병합 방지)", () => {
    const id = projectIdentityFromCwd("/Users/kim/projects/claude-monitor");
    expect(id.key).toBe("/Users/kim/projects/claude-monitor");
    expect(id.label).toBe("claude-monitor");
  });

  it("/Users 밖 경로는 owner unknown", () => {
    const id = projectIdentityFromCwd("/tmp/foo/bar");
    expect(id.owner).toBe("unknown");
    expect(id.label).toBe("bar");
  });
});
