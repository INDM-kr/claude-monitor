import { homedir } from "node:os";
import { join } from "node:path";
import type { AISessionAdapter, AdapterEvent, SessionReader, SessionRef } from "@claude-monitor/core";
import type { StatusThresholds } from "@claude-monitor/core";
import { ClaudeCodeReader } from "./reader.js";
import { ProjectsWatcher } from "./watcher.js";

export interface ClaudeCodeAdapterOptions {
  projectsDir?: string;
  thresholds?: StatusThresholds;
}

export class ClaudeCodeAdapter implements AISessionAdapter {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  private readonly watcher: ProjectsWatcher;
  private readonly thresholds: StatusThresholds | undefined;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
    this.watcher = new ProjectsWatcher({ projectsDir });
    this.thresholds = opts.thresholds;
  }

  async *discover(): AsyncIterable<SessionRef> {
    await this.watcher.start();
    for await (const ref of this.watcher.scan()) {
      yield ref;
    }
  }

  open(ref: SessionRef): SessionReader {
    const opts = this.thresholds ? { thresholds: this.thresholds } : {};
    return new ClaudeCodeReader(ref, opts);
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
