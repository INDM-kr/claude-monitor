import type { ComponentType } from "react";
import type { SessionSummary } from "./session.js";

export interface WidgetContext {
  session: SessionSummary;
  t: (key: string) => string;
}

export type WidgetSlot = "card-footer" | "card-body" | "project-header";

export interface WidgetPlugin {
  readonly id: string;
  readonly title: string;
  readonly slot: WidgetSlot;
  visible?(ctx: WidgetContext): boolean;
  readonly Component: ComponentType<WidgetContext>;
}
