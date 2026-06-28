import type { AISessionAdapter, AdapterEvent, SessionReader, SessionRef } from "@claude-monitor/core";
import type { StatusThresholds } from "@claude-monitor/core";
import { CoworkReader } from "./reader.js";
import { CoworkWatcher } from "./watcher.js";
import { COWORK_ADAPTER_ID, COWORK_DISPLAY, defaultCoworkDir } from "./constants.js";

export interface CoworkAdapterOptions {
  coworkDir?: string;
  thresholds?: StatusThresholds;
}

/**
 * Exposes Claude Desktop **cowork** (local-agent-mode) conversations as monitor
 * sessions. Opt-in (off by default) — see `loadConfig().enableCowork` — because
 * cowork data is local-only and, today, historical.
 */
export class CoworkAdapter implements AISessionAdapter {
  readonly id = COWORK_ADAPTER_ID;
  readonly displayName = COWORK_DISPLAY;
  private readonly watcher: CoworkWatcher;
  private readonly thresholds: StatusThresholds | undefined;

  constructor(opts: CoworkAdapterOptions = {}) {
    this.watcher = new CoworkWatcher({ coworkDir: opts.coworkDir ?? defaultCoworkDir() });
    this.thresholds = opts.thresholds;
  }

  async *discover(): AsyncIterable<SessionRef> {
    await this.watcher.start();
    for await (const ref of this.watcher.scan()) {
      yield ref;
    }
  }

  open(ref: SessionRef): SessionReader {
    return new CoworkReader(ref, this.thresholds ? { thresholds: this.thresholds } : {});
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
