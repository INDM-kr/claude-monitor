import { WidgetRegistry } from "@claude-monitor/core";
import { config as pluginsConfig } from "../plugins.config";

declare global {
  // eslint-disable-next-line no-var
  var __claudeMonitorWidgetRegistry: WidgetRegistry | undefined;
}

export function getWidgetRegistry(): WidgetRegistry {
  if (!globalThis.__claudeMonitorWidgetRegistry) {
    const reg = new WidgetRegistry();
    for (const w of pluginsConfig.widgets) reg.register(w);
    globalThis.__claudeMonitorWidgetRegistry = reg;
  }
  return globalThis.__claudeMonitorWidgetRegistry;
}

export { pluginsConfig };
