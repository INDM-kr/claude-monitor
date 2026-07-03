import { EventEmitter } from "node:events";
import chokidar, { type FSWatcher } from "chokidar";
import type { AdapterEvent, SessionRef } from "@claude-monitor/core";
import { CHAT_ADAPTER_ID, CHAT_DISPLAY, CHAT_PROJECT_KEY } from "./constants.js";
import { conversationMtime, type ChatConversation } from "./parse.js";
import type { ChatStore } from "./store.js";
import { ownerFromPath } from "../cowork/watcher.js";

/** Chromium replaces the cache blob (unlink + add under a new file number) on
 *  every update — collapse the burst into one reload. */
const REFRESH_DEBOUNCE_MS = 500;

export interface ChatWatcherOptions {
  /** Claude Desktop IndexedDB root (contains `https_claude.ai_*.indexeddb.blob`). */
  idbDir: string;
  /** Shared snapshot store (also used by the readers). */
  store: ChatStore;
}

/**
 * Watches the IndexedDB root for blob churn and diffs the parsed conversation
 * set into per-uuid adapter events. File events don't map 1:1 to sessions (one
 * blob holds them all), so events are debounced into a store reload + diff.
 *
 * No `removed` events: a conversation disappearing from the cache usually means
 * react-query evicted it, not that the user deleted it — stale cards age out
 * via the normal recency filter instead of flapping in and out.
 */
export class ChatWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** uuid → last emitted mtime (epoch sec) — drives the added/changed diff. */
  private readonly known = new Map<string, number>();
  private readonly idbDir: string;
  private readonly store: ChatStore;

  constructor(opts: ChatWatcherOptions) {
    super();
    this.idbDir = opts.idbDir;
    this.store = opts.store;
  }

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.idbDir, {
      depth: 4, // <idbDir>/https_claude.ai_0.indexeddb.blob/1/<xx>/<blob>
      persistent: true,
      ignoreInitial: true, // initial state flows through scan()
      awaitWriteFinish: false,
      // The `.indexeddb.leveldb` sibling churns constantly (LOG/MANIFEST writes)
      // and is lock-hazardous — only blob replacement signals a cache update.
      ignored: (p: string) => p.includes(".indexeddb.leveldb"),
    });
    this.watcher.on("add", () => this.schedule());
    this.watcher.on("change", () => this.schedule());
    this.watcher.on("unlink", () => this.schedule());
    // FSWatcher is an EventEmitter — an unhandled "error" (e.g. EACCES on the
    // TCC-protected ~/Library tree) would otherwise crash the whole monitor.
    this.watcher.on("error", () => {});
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  on(event: "event", listener: (e: AdapterEvent) => void): this {
    return super.on(event, listener);
  }

  /** Initial scan — yields one ref per conversation currently in the cache. */
  async *scan(): AsyncIterable<SessionRef> {
    const snap = await this.store.load();
    for (const conv of snap.conversations.values()) {
      const ref = this.refFor(conv);
      this.known.set(conv.uuid, ref.mtime);
      yield ref;
    }
  }

  /** Reload the store and emit added/changed per conversation whose activity
   *  moved. Public so tests (and manual polls) can bypass chokidar timing. */
  async refresh(): Promise<void> {
    const snap = await this.store.load();
    for (const conv of snap.conversations.values()) {
      const mtime = conversationMtime(conv);
      const prev = this.known.get(conv.uuid);
      if (prev === mtime) continue;
      this.known.set(conv.uuid, mtime);
      const event: AdapterEvent = { kind: prev == null ? "added" : "changed", ref: this.refFor(conv) };
      this.emit("event", event);
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch(() => {});
    }, REFRESH_DEBOUNCE_MS);
  }

  private refFor(conv: ChatConversation): SessionRef {
    return {
      id: conv.uuid,
      adapterId: CHAT_ADAPTER_ID,
      workspace: CHAT_DISPLAY,
      workspaceShort: CHAT_DISPLAY,
      projectKey: CHAT_PROJECT_KEY,
      projectLabel: CHAT_DISPLAY,
      owner: ownerFromPath(this.idbDir),
      // Deliberately the DIRECTORY, not the multi-MB binary blob file: generic
      // consumers line-read `source` as a JSONL transcript (usage series /
      // token timeline), which must fail fast (EISDIR) instead of re-reading
      // the whole blob on every render just to parse garbage.
      source: this.idbDir,
      mtime: conversationMtime(conv),
    };
  }
}
