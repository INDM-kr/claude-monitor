import { describe, it, expect } from "vitest";
import { canonicalRemote, normalizeRemote } from "../git-remote";

describe("normalizeRemote", () => {
  it("https form", () => {
    expect(normalizeRemote("https://github.com/nexist/claude-monitor.git")).toEqual({
      key: "git:github.com/nexist/claude-monitor",
      label: "claude-monitor",
    });
  });

  it("scp-like form", () => {
    expect(normalizeRemote("git@github.com:nexist/claude-monitor.git")).toEqual({
      key: "git:github.com/nexist/claude-monitor",
      label: "claude-monitor",
    });
  });

  it("ssh:// form with user", () => {
    expect(normalizeRemote("ssh://git@github.com/nexist/claude-monitor")).toEqual({
      key: "git:github.com/nexist/claude-monitor",
      label: "claude-monitor",
    });
  });

  it("https and scp of same repo produce identical key (unifies clones/worktrees)", () => {
    const a = normalizeRemote("https://github.com/nexist/claude-monitor.git");
    const b = normalizeRemote("git@github.com:nexist/claude-monitor.git");
    expect(a?.key).toBe(b?.key);
  });

  it("host is lowercased; nested group path kept", () => {
    expect(normalizeRemote("https://Gitlab.com/grp/sub/repo.git")).toEqual({
      key: "git:gitlab.com/grp/sub/repo",
      label: "repo",
    });
  });

  it("empty / unrecognizable → null", () => {
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("not a url")).toBeNull();
  });
});

describe("canonicalRemote", () => {
  it("replaces an SSH alias host with its real host so it matches the https clone", async () => {
    const lookup = async (alias: string) => (alias === "github-work" ? "github.com" : null);
    expect(await canonicalRemote("git@github-work:nexist/claude-monitor.git", lookup)).toEqual({ key: "git:github.com/nexist/claude-monitor", label: "claude-monitor" });
    expect((await canonicalRemote("https://github.com/nexist/claude-monitor.git", lookup))?.key).toBe("git:github.com/nexist/claude-monitor");
    expect(await canonicalRemote("not a remote", lookup)).toBeNull();
  });
});
