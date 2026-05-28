import type { WidgetPlugin, WidgetSlot } from "../types/widget.js";

export class WidgetRegistry {
  private readonly bySlot = new Map<WidgetSlot, WidgetPlugin[]>();
  private readonly byId = new Map<string, WidgetPlugin>();

  register(widget: WidgetPlugin): void {
    if (this.byId.has(widget.id)) {
      throw new Error(`Widget id collision: ${widget.id}`);
    }
    this.byId.set(widget.id, widget);
    const arr = this.bySlot.get(widget.slot) ?? [];
    arr.push(widget);
    this.bySlot.set(widget.slot, arr);
  }

  forSlot(slot: WidgetSlot): WidgetPlugin[] {
    return this.bySlot.get(slot) ?? [];
  }

  list(): WidgetPlugin[] {
    return [...this.byId.values()];
  }
}
