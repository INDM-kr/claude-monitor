import type { AISessionAdapter, AdapterEvent } from "./adapter.js";
import type { AuthContext } from "./auth.js";

export interface DataSource {
  readonly kind: "local" | "remote";
  adapters(): AISessionAdapter[];
  auth(): AuthContext;
  /** Aggregated event stream across all adapters */
  subscribe(cb: (e: AdapterEvent) => void): () => void;
  /** Tear down */
  dispose(): Promise<void>;
}
