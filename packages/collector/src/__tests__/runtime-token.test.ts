import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../config.js";
import { createRuntimeHookToken, resolveRuntimeHookToken } from "../runtime-token.js";

const dirs: string[] = [];
function dataDir() { const d = mkdtempSync(join(tmpdir(), "cm-hook-token-test-")); chmodSync(d, 0o700); dirs.push(d); return d; }
const tokenPath = (d: string) => join(d, DEFAULTS.runtimeHookTokenFile);
const valid = "a".repeat(43);
afterEach(() => { dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });

describe("runtime hook token resolution", () => {
  it("prefers the environment and treats an explicit empty value as disabled even when a file exists", () => {
    const d = dataDir(); writeFileSync(tokenPath(d), valid, { mode: 0o600 });
    expect(resolveRuntimeHookToken({ CM_DATA_DIR: d, CM_RUNTIME_HOOK_TOKEN: "from-env" })).toEqual({ token: "from-env", source: "env" });
    expect(resolveRuntimeHookToken({ CM_DATA_DIR: d, CM_RUNTIME_HOOK_TOKEN: "" })).toEqual({ token: null, source: "none" });
  });

  it("reads a private token file from the data directory when the environment is unset", () => {
    const d = dataDir(); writeFileSync(tokenPath(d), `${valid}\n`, { mode: 0o600 });
    expect(resolveRuntimeHookToken({ CM_DATA_DIR: d })).toEqual({ token: valid, source: "file" });
  });

  it("stays disabled without a file and rejects unsafe or malformed files without exposing their content", () => {
    const d = dataDir();
    expect(resolveRuntimeHookToken({ CM_DATA_DIR: d })).toEqual({ token: null, source: "none" });
    writeFileSync(tokenPath(d), valid, { mode: 0o644 }); chmodSync(tokenPath(d), 0o644);
    expect(resolveRuntimeHookToken({ CM_DATA_DIR: d })).toEqual({ token: null, source: "none", diagnostic: "runtime_token_not_private" });
    chmodSync(tokenPath(d), 0o600); writeFileSync(tokenPath(d), "short");
    expect(resolveRuntimeHookToken({ CM_DATA_DIR: d })).toEqual({ token: null, source: "none", diagnostic: "runtime_token_invalid" });
    rmSync(tokenPath(d)); const target = join(d, "elsewhere"); writeFileSync(target, valid, { mode: 0o600 }); symlinkSync(target, tokenPath(d));
    expect(resolveRuntimeHookToken({ CM_DATA_DIR: d })).toEqual({ token: null, source: "none", diagnostic: "runtime_token_unreadable" });
    expect(resolveRuntimeHookToken({ CM_DATA_DIR: "relative" })).toEqual({ token: null, source: "none", diagnostic: "invalid_data_directory" });
  });
});

describe("runtime hook token creation", () => {
  it("creates a 0600 random token once and never overwrites an existing one", () => {
    const d = join(dataDir(), "nested");
    const first = createRuntimeHookToken({ CM_DATA_DIR: d });
    expect(first).toEqual({ created: true, path: tokenPath(d) });
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(statSync(tokenPath(d)).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenPath(d), "utf8");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resolveRuntimeHookToken({ CM_DATA_DIR: d })).toEqual({ token, source: "file" });
    expect(createRuntimeHookToken({ CM_DATA_DIR: d })).toEqual({ created: false, path: tokenPath(d) });
    expect(readFileSync(tokenPath(d), "utf8")).toBe(token);
  });

  it("refuses a data directory other users can read", () => {
    const d = dataDir(); chmodSync(d, 0o755);
    expect(() => createRuntimeHookToken({ CM_DATA_DIR: d })).toThrow("data_directory_not_private");
  });
});
