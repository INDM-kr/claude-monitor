import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterEvent, SessionRef } from "@claude-monitor/core";
import { ChatAdapter } from "../chat/adapter.js";
import { ChatStore } from "../chat/store.js";
import { ChatWatcher } from "../chat/watcher.js";
import { CHAT_ADAPTER_ID, CHAT_DISPLAY, CHAT_PROJECT_KEY } from "../chat/constants.js";
import { buildCacheBlob, cacheWith, listItem, listQuery } from "./helpers/chat-blob.js";

describe("ChatAdapter + ChatWatcher", () => {
  let idbDir: string;
  let blobDir: string;

  beforeEach(async () => {
    idbDir = await fs.mkdtemp(join(tmpdir(), "cm-chat-adapter-"));
    blobDir = join(idbDir, "https_claude.ai_0.indexeddb.blob", "1", "00");
    await fs.mkdir(blobDir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(idbDir, { recursive: true, force: true });
  });

  async function writeCache(name: string, queries: unknown[]): Promise<void> {
    await fs.writeFile(join(blobDir, name), buildCacheBlob(cacheWith(queries)));
  }

  it("discovers one ref per unique conversation across queryKey variants", async () => {
    await writeCache("0a1b", [
      listQuery([listItem("a"), listItem("b")], { limit: 30 }),
      listQuery([listItem("a")], { limit: 5 }), // duplicate of a
    ]);
    const adapter = new ChatAdapter({ idbDir });
    const refs: SessionRef[] = [];
    for await (const ref of adapter.discover()) refs.push(ref);
    await adapter.dispose();

    expect(refs.map((r) => r.id).sort()).toEqual(["a", "b"]);
    const ref = refs[0]!;
    expect(ref.adapterId).toBe(CHAT_ADAPTER_ID);
    expect(ref.projectKey).toBe(CHAT_PROJECT_KEY);
    expect(ref.projectLabel).toBe(CHAT_DISPLAY);
    // source is the DIRECTORY (fail-fast for generic JSONL line-readers),
    // never the multi-MB binary blob file
    expect(ref.source).toBe(idbDir);
  });

  it("discovers nothing (and doesn't throw) when the cache is absent", async () => {
    const adapter = new ChatAdapter({ idbDir: join(idbDir, "does-not-exist") });
    const refs: SessionRef[] = [];
    for await (const ref of adapter.discover()) refs.push(ref);
    await adapter.dispose();
    expect(refs).toEqual([]);
  });

  it("open() reads a summary end-to-end through the shared store", async () => {
    await writeCache("0a1b", [listQuery([listItem("a", { name: "제목" })])]);
    const adapter = new ChatAdapter({ idbDir });
    const refs: SessionRef[] = [];
    for await (const ref of adapter.discover()) refs.push(ref);
    const s = await adapter.open(refs[0]!).readIncremental();
    await adapter.dispose();
    expect(s.firstPrompt).toBe("제목");
    expect(s.ref.adapterId).toBe(CHAT_ADAPTER_ID);
  });

  it("watcher diff: added for new uuid, changed for bumped activity, no removed on eviction", async () => {
    await writeCache("0a1b", [listQuery([listItem("a", { updated_at: "2026-06-02T00:00:00Z" })])]);
    const store = new ChatStore(idbDir);
    const watcher = new ChatWatcher({ idbDir, store });
    const events: AdapterEvent[] = [];
    watcher.on("event", (e) => events.push(e));
    for await (const ref of watcher.scan()) void ref; // prime known set

    // replace blob: a bumped, b new, and later a evicted — refresh() drives the
    // diff directly (chokidar wiring mirrors cowork; timing not under test)
    await fs.rm(join(blobDir, "0a1b"));
    await writeCache("0a1c", [
      listQuery([listItem("a", { updated_at: "2026-06-09T00:00:00Z" }), listItem("b")]),
    ]);
    await watcher.refresh();
    expect(events.map((e) => e.kind).sort()).toEqual(["added", "changed"]);

    events.length = 0;
    await fs.rm(join(blobDir, "0a1c"));
    await writeCache("0a1d", [listQuery([listItem("b")])]);
    await watcher.refresh();
    expect(events).toEqual([]); // eviction ≠ deletion: no removed, no flapping

    await watcher.stop();
  });

  it("refresh() after an unchanged signature emits nothing", async () => {
    await writeCache("0a1b", [listQuery([listItem("a")])]);
    const store = new ChatStore(idbDir);
    const watcher = new ChatWatcher({ idbDir, store });
    const events: AdapterEvent[] = [];
    watcher.on("event", (e) => events.push(e));
    for await (const ref of watcher.scan()) void ref;
    await watcher.refresh();
    expect(events).toEqual([]);
    await watcher.stop();
  });
});
