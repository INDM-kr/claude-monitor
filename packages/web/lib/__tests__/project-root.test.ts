import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectRoot } from "../project-root";

describe("findProjectRoot", () => {
  let base: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(join(tmpdir(), "cm-root-"));
    // Mirror the real pickko layout:
    //   pickko/                 (CLAUDE.md — non-git project root)
    //   pickko/_plan/           (no marker — planning subdir)
    //   pickko/.reversa/        (no marker — installed plugin)
    //   pickko/pickko_admin/    (.git — real sub-project)
    //   loose/sub/              (no marker anywhere)
    await fs.mkdir(join(base, "pickko", "_plan"), { recursive: true });
    await fs.mkdir(join(base, "pickko", ".reversa"), { recursive: true });
    await fs.mkdir(join(base, "pickko", "pickko_admin", ".git"), { recursive: true });
    await fs.mkdir(join(base, "loose", "sub"), { recursive: true });
    await fs.writeFile(join(base, "pickko", "CLAUDE.md"), "# pickko\n");
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("folds a markerless subdir (_plan) into the nearest CLAUDE.md ancestor", async () => {
    const root = await findProjectRoot(join(base, "pickko", "_plan"), base);
    expect(root).toEqual({ key: join(base, "pickko"), label: "pickko" });
  });

  it("folds an installed plugin dir (.reversa) into the project root, not its own group", async () => {
    const root = await findProjectRoot(join(base, "pickko", ".reversa"), base);
    expect(root?.key).toBe(join(base, "pickko"));
  });

  it("returns the project root itself when cwd already has a marker", async () => {
    const root = await findProjectRoot(join(base, "pickko"), base);
    expect(root).toEqual({ key: join(base, "pickko"), label: "pickko" });
  });

  it("keeps a real git sub-project separate (its own .git)", async () => {
    const root = await findProjectRoot(join(base, "pickko", "pickko_admin"), base);
    expect(root?.key).toBe(join(base, "pickko", "pickko_admin"));
  });

  it("returns null when no marker exists up to the boundary (keep cwd-derived key)", async () => {
    expect(await findProjectRoot(join(base, "loose", "sub"), base)).toBeNull();
  });

  it("never treats the boundary dir itself as a root", async () => {
    // Even if the boundary had a marker, the walk must not inspect it.
    await fs.writeFile(join(base, "CLAUDE.md"), "# boundary\n");
    expect(await findProjectRoot(join(base, "loose", "sub"), base)).toBeNull();
  });

  it("caches: language manifests are NOT markers (a package.json subdir does not split)", async () => {
    // package.json deliberately excluded — a deps/plugin dir with one must fold.
    await fs.mkdir(join(base, "pickko", "node_thing"), { recursive: true });
    await fs.writeFile(join(base, "pickko", "node_thing", "package.json"), "{}\n");
    const root = await findProjectRoot(join(base, "pickko", "node_thing"), base);
    expect(root?.key).toBe(join(base, "pickko")); // folded, not its own group
  });
});
