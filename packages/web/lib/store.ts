"use client";

import { create } from "zustand";
import type { SessionSummary } from "@claude-monitor/core";

interface State {
  sessions: Map<string, SessionSummary>;
  connected: boolean;
  /** Wall-clock seconds, ticked client-side so time-relative UI (status decay,
   *  "X ago") advances even when no SSE event arrives. */
  now: number;
  setInitial: (list: SessionSummary[]) => void;
  upsert: (s: SessionSummary) => void;
  remove: (refId: string) => void;
  setConnected: (v: boolean) => void;
  tick: (now: number) => void;
}

function keyOf(s: SessionSummary): string {
  return `${s.ref.adapterId}::${s.ref.id}`;
}

export const useSessionStore = create<State>((set) => ({
  sessions: new Map(),
  connected: false,
  now: Math.floor(Date.now() / 1000),
  setInitial: (list) =>
    set(() => {
      const m = new Map<string, SessionSummary>();
      for (const s of list) m.set(keyOf(s), s);
      return { sessions: m };
    }),
  upsert: (s) =>
    set((state) => {
      const m = new Map(state.sessions);
      m.set(keyOf(s), s);
      return { sessions: m };
    }),
  remove: (refId) =>
    set((state) => {
      const m = new Map(state.sessions);
      for (const k of m.keys()) {
        if (k.endsWith(`::${refId}`)) m.delete(k);
      }
      return { sessions: m };
    }),
  setConnected: (v) => set({ connected: v }),
  tick: (now) => set((state) => (state.now === now ? state : { now })),
}));
