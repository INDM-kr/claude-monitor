import { getProcessCollector } from "@claude-monitor/collector";
import type { CollectorStatus } from "@claude-monitor/core";

// Startup is owned by scripts/web.mjs; a request only reads the shared controller.
export function collectorStatus(): CollectorStatus {
  return getProcessCollector().status();
}
