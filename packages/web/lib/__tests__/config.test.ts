import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";

const KEYS = ["CM_ENABLE_CODEX", "CM_CODEX_DIR"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

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
