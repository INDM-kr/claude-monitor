import type { AISessionAdapter, AdapterEvent, SessionReader, SessionRef } from "@claude-monitor/core";
import type { StatusThresholds } from "@claude-monitor/core";
import { ChatReader } from "./reader.js";
import { ChatStore } from "./store.js";
import { ChatWatcher } from "./watcher.js";
import { CHAT_ADAPTER_ID, CHAT_DISPLAY, defaultChatIdbDir } from "./constants.js";

export interface ChatAdapterOptions {
  /** Claude Desktop IndexedDB root (contains `https_claude.ai_*.indexeddb.blob`). */
  idbDir?: string;
  thresholds?: StatusThresholds;
}

/**
 * Exposes claude.ai chat conversations from Claude Desktop's IndexedDB
 * react-query cache as monitor sessions. Opt-in (off by default) — see
 * `loadConfig().enableChat` — because the cache's app schema (queryKey names,
 * message shape) can change with any claude.ai deploy; every layer degrades to
 * an empty result rather than erroring, so a broken cache never takes the
 * monitor down. Coverage is what the webview cached: the recent conversation
 * LIST (metadata, live) plus full messages for recently OPENED conversations.
 */
export class ChatAdapter implements AISessionAdapter {
  readonly id = CHAT_ADAPTER_ID;
  readonly displayName = CHAT_DISPLAY;
  private readonly store: ChatStore;
  private readonly watcher: ChatWatcher;
  private readonly thresholds: StatusThresholds | undefined;

  constructor(opts: ChatAdapterOptions = {}) {
    const idbDir = opts.idbDir ?? defaultChatIdbDir();
    this.store = new ChatStore(idbDir);
    this.watcher = new ChatWatcher({ idbDir, store: this.store });
    this.thresholds = opts.thresholds;
  }

  async *discover(): AsyncIterable<SessionRef> {
    await this.watcher.start();
    yield* this.watcher.scan();
  }

  open(ref: SessionRef): SessionReader {
    return new ChatReader(ref, this.store, this.thresholds ? { thresholds: this.thresholds } : {});
  }

  async dispose(): Promise<void> {
    await this.watcher.stop();
  }

  onChange(cb: (event: AdapterEvent) => void): () => void {
    this.watcher.on("event", cb);
    return () => {
      this.watcher.off("event", cb);
    };
  }
}
