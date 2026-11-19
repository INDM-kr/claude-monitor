import { resolve } from "node:path";
import type { MonitorProject, MonitorProjectMap } from "@claude-monitor/core";
import { getProcessCollector } from "@claude-monitor/collector";

/** How long a fetched mapping is reused before the next read asks the collector again (no timer runs). */
const REFRESH_MS = 10_000;

/** Where the live monitor reads the ledger's project mapping (managed on /projects). */
export interface ProjectMapSource {
  current(): MonitorProjectMap | null;
  /** Re-read when stale (or `force`); resolves true only when the mapping changed. */
  refresh(force?: boolean): Promise<boolean>;
}

/** The ledger project for a session folder, else for its git repository; null keeps automatic grouping. */
export function mappedProject(map: MonitorProjectMap | null, workspace: string, gitKey: string | null): MonitorProject | null {
  if (!map || !workspace) return null;
  return map.workspaces[resolve(workspace)] ?? (gitKey ? map.identities[gitKey] ?? null : null);
}

export class CollectorProjectMap implements ProjectMapSource {
  private map: MonitorProjectMap | null = null;
  private signature = "";
  private fetchedAt = 0;
  private pending: Promise<boolean> | null = null;
  private readonly reported = new Set<string>();

  current(): MonitorProjectMap | null {
    return this.map;
  }

  refresh(force = false): Promise<boolean> {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.fetchedAt < REFRESH_MS) return Promise.resolve(false);
    this.pending = Promise.resolve()
      .then(() => {
        // Collector off, starting or failed (its status is on /settings and /api/health): keep automatic grouping quietly.
        const collector = getProcessCollector();
        return collector.status().state === "ready" ? collector.request<MonitorProjectMap>("projects.monitorMap") : null;
      })
      .then((next) => {
        if (!next) return false;
        const signature = JSON.stringify(next);
        if (signature === this.signature) return false;
        this.signature = signature;
        this.map = next;
        return true;
      })
      // A ready collector that cannot answer is a real fault: report each kind once, keep automatic grouping, retry later.
      .catch((error: unknown) => {
        const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : String(error));
        if (!this.reported.has(code)) {
          this.reported.add(code);
          console.error(`[monitor] project mapping unavailable: ${code}`);
        }
        return false;
      })
      .finally(() => {
        this.fetchedAt = Date.now();
        this.pending = null;
      });
    return this.pending;
  }
}
