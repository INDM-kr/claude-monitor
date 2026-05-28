import type { AISessionAdapter } from "../types/adapter.js";

export class AdapterRegistry {
  private readonly byId = new Map<string, AISessionAdapter>();

  register(adapter: AISessionAdapter): void {
    if (this.byId.has(adapter.id)) {
      throw new Error(`Adapter id collision: ${adapter.id}`);
    }
    this.byId.set(adapter.id, adapter);
  }

  get(id: string): AISessionAdapter | undefined {
    return this.byId.get(id);
  }

  list(): AISessionAdapter[] {
    return [...this.byId.values()];
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.byId.values()].map((a) => a.dispose()));
    this.byId.clear();
  }
}
