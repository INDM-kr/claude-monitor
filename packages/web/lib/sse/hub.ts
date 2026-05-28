import { EventEmitter } from "node:events";
import type { SessionSummary } from "@claude-monitor/core";

export type SseEvent =
  | { kind: "summary"; data: SessionSummary }
  | { kind: "removed"; data: { refId: string } }
  | { kind: "heartbeat"; data: { ts: number } };

class SseHub {
  private readonly em = new EventEmitter();

  constructor() {
    this.em.setMaxListeners(0);
  }

  subscribe(cb: (e: SseEvent) => void): () => void {
    const fn = (e: SseEvent) => cb(e);
    this.em.on("event", fn);
    return () => this.em.off("event", fn);
  }

  publish(e: SseEvent): void {
    this.em.emit("event", e);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __claudeMonitorSseHub: SseHub | undefined;
}

export function getHub(): SseHub {
  if (!globalThis.__claudeMonitorSseHub) {
    globalThis.__claudeMonitorSseHub = new SseHub();
  }
  return globalThis.__claudeMonitorSseHub;
}
