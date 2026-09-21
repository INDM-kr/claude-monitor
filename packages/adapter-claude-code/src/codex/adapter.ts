import type { AISessionAdapter, AdapterEvent, SessionReader, SessionRef } from "@claude-monitor/core";
import type { StatusThresholds } from "@claude-monitor/core";
import { CodexReader } from "./reader.js";
import { CodexWatcher } from "./watcher.js";
import { CODEX_ADAPTER_ID, CODEX_DISPLAY, defaultCodexDir } from "./constants.js";

export interface CodexAdapterOptions {
  codexDir?: string;
  thresholds?: StatusThresholds;
}

/**
 * Exposes OpenAI Codex (CLI / Desktop) rollout threads as monitor sessions.
 * On by default — see `loadConfig().enableCodex`; a missing `~/.codex/sessions`
 * simply yields no sessions.
 */
export class CodexAdapter implements AISessionAdapter {
  readonly id = CODEX_ADAPTER_ID;
  readonly displayName = CODEX_DISPLAY;
  private readonly watcher: CodexWatcher;
  private readonly thresholds: StatusThresholds | undefined;

  constructor(opts: CodexAdapterOptions = {}) {
    this.watcher = new CodexWatcher({ codexDir: opts.codexDir ?? defaultCodexDir() });
    this.thresholds = opts.thresholds;
  }

  async *discover(): AsyncIterable<SessionRef> {
    await this.watcher.start();
    for await (const ref of this.watcher.scan()) {
      yield ref;
    }
  }

  open(ref: SessionRef): SessionReader {
    return new CodexReader(ref, this.thresholds ? { thresholds: this.thresholds } : {});
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
