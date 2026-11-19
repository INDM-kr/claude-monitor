import { CollectorController } from "./controller.js";
import { loadCollectorConfig, type CollectorConfig } from "./config.js";

declare global {
  // Retained across Next.js route recompilation and module cache invalidation.
  var __claudeMonitorCollector: CollectorController | undefined;
}

export function getProcessCollector(config?: CollectorConfig): CollectorController {
  return globalThis.__claudeMonitorCollector ??= new CollectorController(config ?? loadCollectorConfig());
}
