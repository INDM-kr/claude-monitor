import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { snapshotEnv } from "./helpers";

const restoreEnv = snapshotEnv(["CM_ENABLE_CODEX", "CM_CODEX_DIR"]);
afterEach(restoreEnv);

describe("loadConfig — Codex", () => {
  it("is on by default and points at ~/.codex/sessions", () => {
    delete process.env.CM_ENABLE_CODEX;
    delete process.env.CM_CODEX_DIR;
    const c = loadConfig();
    expect(c.enableCodex).toBe(true);
    expect(c.codexDir.endsWith("/.codex/sessions")).toBe(true);
  });
  it("CM_ENABLE_CODEX=0 turns it off; CM_CODEX_DIR overrides the root", () => {
    process.env.CM_ENABLE_CODEX = "0";
    process.env.CM_CODEX_DIR = "/tmp/codex-sessions";
    const c = loadConfig();
    expect(c.enableCodex).toBe(false);
    expect(c.codexDir).toBe("/tmp/codex-sessions");
  });
});
