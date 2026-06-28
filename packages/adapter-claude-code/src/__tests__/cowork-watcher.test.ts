import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoworkWatcher, coworkRefParts, isIgnoredCoworkPath, ownerFromPath } from "../cowork/watcher.js";
import { COWORK_ADAPTER_ID, COWORK_DISPLAY } from "../cowork/constants.js";

const ROOT = "/Users/alice/Library/Application Support/Claude/local-agent-mode-sessions";

describe("coworkRefParts", () => {
  it("parses <sid>/<sub>/local_<id>/audit.jsonl", () => {
    expect(coworkRefParts(ROOT, `${ROOT}/sid1/sub1/local_abc123/audit.jsonl`)).toEqual({
      sid: "sid1",
      sub: "sub1",
      id: "abc123",
    });
  });

  it("rejects the nested per-session Desktop transcript (.claude/projects/…)", () => {
    expect(
      coworkRefParts(ROOT, `${ROOT}/sid1/sub1/local_abc/.claude/projects/enc/uuid.jsonl`),
    ).toBeNull();
  });

  it("rejects the skills-plugin sibling and non-local dirs", () => {
    expect(coworkRefParts(ROOT, `${ROOT}/skills-plugin/x/y/audit.jsonl`)).toBeNull();
    expect(coworkRefParts(ROOT, `${ROOT}/sid1/sub1/notlocal_abc/audit.jsonl`)).toBeNull();
  });

  it("rejects non-audit files and wrong depth", () => {
    expect(coworkRefParts(ROOT, `${ROOT}/sid1/sub1/local_abc/other.jsonl`)).toBeNull();
    expect(coworkRefParts(ROOT, `${ROOT}/sid1/local_abc/audit.jsonl`)).toBeNull();
  });
});

describe("ownerFromPath", () => {
  it("extracts the OS user from a /Users/<name>/ root", () => {
    expect(ownerFromPath(`${ROOT}`)).toBe("alice");
    expect(ownerFromPath("/Users/bob/Library/x")).toBe("bob");
  });
  it("falls back to 'unknown' off a non-/Users root (e.g. /var/folders tmp)", () => {
    expect(ownerFromPath("/var/folders/zz/cm-cowork-xyz")).toBe("unknown");
  });
});

describe("isIgnoredCoworkPath", () => {
  it("does not ignore the root or a session audit file", () => {
    expect(isIgnoredCoworkPath(ROOT, ROOT)).toBe(false);
    expect(isIgnoredCoworkPath(ROOT, `${ROOT}/sid/sub/local_x/audit.jsonl`)).toBe(false);
  });

  it("ignores hidden segments inside the tree (the per-session .claude subtree, .audit-key)", () => {
    expect(isIgnoredCoworkPath(ROOT, `${ROOT}/sid/sub/local_x/.claude/projects/e/u.jsonl`)).toBe(true);
    expect(isIgnoredCoworkPath(ROOT, `${ROOT}/sid/sub/local_x/.audit-key`)).toBe(true);
  });
});

describe("CoworkWatcher.scan", () => {
  let dir: string;
  let watcher: CoworkWatcher;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "cm-cowork-"));
    // Two sessions under one (sid, sub) group.
    await fs.mkdir(join(dir, "sidA", "subA", "local_one"), { recursive: true });
    await fs.mkdir(join(dir, "sidA", "subA", "local_two"), { recursive: true });
    await fs.writeFile(join(dir, "sidA", "subA", "local_one", "audit.jsonl"), '{"type":"user"}\n');
    await fs.writeFile(join(dir, "sidA", "subA", "local_two", "audit.jsonl"), '{"type":"user"}\n');
    // Decoys that must be ignored: the nested Desktop transcript + a sibling dir.
    await fs.mkdir(join(dir, "sidA", "subA", "local_one", ".claude", "projects", "enc"), { recursive: true });
    await fs.writeFile(join(dir, "sidA", "subA", "local_one", ".claude", "projects", "enc", "u.jsonl"), "{}\n");
    await fs.mkdir(join(dir, "skills-plugin", "x"), { recursive: true });
    await fs.writeFile(join(dir, "skills-plugin", "x", "audit.jsonl"), "{}\n");
    watcher = new CoworkWatcher({ coworkDir: dir });
  });

  afterEach(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("yields exactly the two session audit files with synthetic cowork refs", async () => {
    const refs = [];
    for await (const r of watcher.scan()) refs.push(r);

    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.id).sort()).toEqual(["one", "two"]);
    for (const r of refs) {
      expect(r.adapterId).toBe(COWORK_ADAPTER_ID);
      expect(r.projectKey).toBe("cowork:sidA/subA");
      expect(r.projectLabel).toBe(COWORK_DISPLAY);
      expect(r.workspace).toBe(COWORK_DISPLAY);
      expect(r.source.endsWith("audit.jsonl")).toBe(true);
    }
  });
});
