"use client";

import { create } from "zustand";
import type { SessionSummary } from "@claude-monitor/core";

const STORAGE_KEY = "cm:dismissed";

export function dismissKey(s: SessionSummary): string {
  return `${s.ref.adapterId}::${s.ref.id}`;
}

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function save(keys: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
}

interface DismissedState {
  dismissed: Set<string>;
  hydrated: boolean;
  /** Read localStorage once on the client (SSR-safe — call from useEffect). */
  hydrate: () => void;
  dismiss: (key: string) => void;
  restore: (key: string) => void;
  restoreAll: () => void;
}

export const useDismissed = create<DismissedState>((set, get) => ({
  dismissed: new Set(),
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return;
    set({ dismissed: new Set(load()), hydrated: true });
  },
  dismiss: (key) =>
    set((s) => {
      const next = new Set(s.dismissed);
      next.add(key);
      save([...next]);
      return { dismissed: next };
    }),
  restore: (key) =>
    set((s) => {
      const next = new Set(s.dismissed);
      next.delete(key);
      save([...next]);
      return { dismissed: next };
    }),
  restoreAll: () => {
    save([]);
    set({ dismissed: new Set() });
  },
}));
