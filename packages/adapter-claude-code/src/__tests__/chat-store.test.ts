import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatStore } from "../chat/store.js";
import { buildCacheBlob, cacheWith, listItem, listQuery } from "./helpers/chat-blob.js";

describe("ChatStore", () => {
  let idbDir: string;
  let blobDir: string;

  beforeEach(async () => {
    idbDir = await fs.mkdtemp(join(tmpdir(), "cm-chat-store-"));
    blobDir = join(idbDir, "https_claude.ai_0.indexeddb.blob", "1", "00");
    await fs.mkdir(blobDir, { recursive: true });
    // leveldb sibling exists in real installs; must never be read
    await fs.mkdir(join(idbDir, "https_claude.ai_0.indexeddb.leveldb"), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(idbDir, { recursive: true, force: true });
  });

  async function writeBlob(name: string, queries: unknown[]): Promise<void> {
    await fs.writeFile(join(blobDir, name), buildCacheBlob(cacheWith(queries)));
  }

  it("finds the cache by content among decoy blobs (file numbering irrelevant)", async () => {
    // decoy is LARGER than the cache — content detection must skip it
    await fs.writeFile(join(blobDir, "zz-decoy"), Buffer.alloc(64 * 1024, 7));
    await writeBlob("0a1b", [listQuery([listItem("conv-1")])]);
    const snap = await new ChatStore(idbDir).load();
    expect([...snap.conversations.keys()]).toEqual(["conv-1"]);
    expect(snap.blobPath).toContain("0a1b");
    expect(snap.fingerprint?.hasTrailer).toBe(true);
  });

  it("returns the identical snapshot while the dir signature is unchanged", async () => {
    await writeBlob("0a1b", [listQuery([listItem("conv-1")])]);
    const store = new ChatStore(idbDir);
    const a = await store.load();
    const b = await store.load();
    expect(b).toBe(a);
  });

  it("reloads when the blob is replaced (Chromium renumbers on update)", async () => {
    await writeBlob("0a1b", [listQuery([listItem("conv-1")])]);
    const store = new ChatStore(idbDir);
    const first = await store.load();
    expect(first.conversations.has("conv-2")).toBe(false);
    await fs.rm(join(blobDir, "0a1b"));
    await writeBlob("0a1c", [listQuery([listItem("conv-1"), listItem("conv-2")])]);
    const second = await store.load();
    expect(second).not.toBe(first);
    expect(second.conversations.has("conv-2")).toBe(true);
  });

  it("degrades to an empty snapshot: missing dir, no cache blob, corrupt blob", async () => {
    const missing = await new ChatStore(join(idbDir, "nope")).load();
    expect(missing.conversations.size).toBe(0);
    expect(missing.blobPath).toBeNull();

    const empty = await new ChatStore(idbDir).load();
    expect(empty.conversations.size).toBe(0);

    await fs.writeFile(join(blobDir, "bad"), Buffer.from([0xff, 0x11, 0x02, 1, 2, 3]));
    const corrupt = await new ChatStore(idbDir).load();
    expect(corrupt.conversations.size).toBe(0);
  });

  it("does not serve a stale join: a load() during an in-flight pass re-checks the signature", async () => {
    await writeBlob("0a1b", [listQuery([listItem("conv-1")])]);
    const store = new ChatStore(idbDir);
    // Gate the FIRST pass after it has captured its dir listing, so the blob
    // replacement below deterministically lands mid-flight.
    type FileList = Array<{ path: string; size: number; mtimeMs: number }>;
    const anyStore = store as unknown as { listBlobFiles: () => Promise<FileList> };
    const orig = anyStore.listBlobFiles.bind(store);
    let release: (() => void) | null = null;
    let gated = false;
    anyStore.listBlobFiles = async () => {
      const files = await orig();
      if (!gated) {
        gated = true;
        await new Promise<void>((res) => {
          release = res;
        });
      }
      return files;
    };

    const p1 = store.load(); // in flight, holds the pre-change listing
    await new Promise((r) => setTimeout(r, 10)); // let p1 reach the gate
    await fs.rm(join(blobDir, "0a1b"));
    await writeBlob("0a1c", [listQuery([listItem("conv-1"), listItem("conv-2")])]);
    const p2 = store.load(); // arrived mid-flight — must NOT join p1's result
    release!();
    await p1;
    const second = await p2;
    expect(second.conversations.has("conv-2")).toBe(true);
  });

  it("ignores dirs that don't match the claude.ai blob pattern", async () => {
    const other = join(idbDir, "https_example.com_0.indexeddb.blob", "1", "00");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(join(other, "0a1b"), buildCacheBlob(cacheWith([listQuery([listItem("evil")])])));
    const snap = await new ChatStore(idbDir).load();
    expect(snap.conversations.size).toBe(0);
  });
});
