/** Exact storage values. Convert to decimal strings at the JSON boundary. */
export interface UsageTokens {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
}

export interface UsageQueryScope {
  from: string;
  to: string;
  timezone: string;
  asOf: number;
  projectId?: string;
  model?: string;
  providerId?: string;
  pricingVersion?: string;
}

export type CollectorState = "disabled" | "starting" | "ready" | "stopping" | "stopped" | "error";

/** Safe to expose in health responses: no paths, prompts, SQL or raw errors. */
export interface CollectorStatus {
  state: CollectorState;
  ingestionState: "not_started" | "indexing" | "watching" | "partial" | "error";
  lastScanAt?: number | null;
  sourceCount?: number;
  diagnosticCount?: number;
  workerId: number | null;
  schemaVersion: number | null;
  deviceId: string | null;
  diagnostic: string | null;
}
