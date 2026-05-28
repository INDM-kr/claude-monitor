import type { WidgetPlugin } from "@claude-monitor/core";

/**
 * Plugin registration entry point.
 *
 * Add adapter & widget contributions here. Plugins ship as workspace
 * packages or external npm packages — import the contribution object
 * and add it to one of the arrays below.
 *
 * Note: adapters are auto-loaded by LocalDataSource for now (just
 * @claude-monitor/adapter-claude-code). To add another adapter, expose
 * it here and update LocalDataSource to consume `config.adapters`.
 */

export const config: {
  widgets: WidgetPlugin[];
} = {
  widgets: [],
};
