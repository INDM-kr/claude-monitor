import type { SessionRef, SessionStatus, SessionSummary } from "./session.js";

export type AdapterEvent =
  | { kind: "added"; ref: SessionRef }
  | { kind: "changed"; ref: SessionRef }
  | { kind: "removed"; refId: string };

export interface SessionReader {
  /** mtime-derived bucket. No I/O. */
  status(now: number): SessionStatus;
  /** Read appended bytes since last call, fold into summary. Idempotent. */
  readIncremental(): Promise<SessionSummary>;
  close(): void;
}

export interface AISessionAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Initial scan + ongoing additions via watcher */
  discover(): AsyncIterable<SessionRef>;
  /** Open a stateful reader for one session */
  open(ref: SessionRef): SessionReader;
  /** Stop watchers, close handles */
  dispose(): Promise<void>;
  /** Subscribe to ref-level events */
  onChange(cb: (event: AdapterEvent) => void): () => void;
}
