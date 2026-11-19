import type { UsageTokens } from "./usage.js";

export type UsageCostEligibility = "eligible" | "unknown_cache_split" | "invalid_cache_split";
export interface UsageSourceContext {
  deviceId: string;
  sourceId: string;
  /** Used only for deriving child run identity; never returned in diagnostics. */
  sourcePath: string;
  generation: number;
  byteStart: number;
  byteEnd: number;
  ingestedAt: number;
}
export interface UsageRunIdentity {
  key: string;
  nativeSessionId: string;
  nativeAgentId: string | null;
  parentNativeSessionId: string | null;
  parentKey: string | null;
  workflowId: string | null;
  /** Provider-internal helper thread (e.g. a Codex approval review): its usage counts, but it gets no run row. */
  internal?: boolean;
}
export interface NormalizedUsageObservation {
  identityKey: string;
  deviceId: string;
  providerId: string;
  sourceId: string;
  generation: number;
  byteStart: number;
  byteEnd: number;
  ingestedAt: number;
  recordId: string | null;
  responseId: string;
  requestId: string | null;
  model: string;
  eventAt: number;
  tokens: UsageTokens;
  cache5m: bigint | null;
  cache1h: bigint | null;
  costEligibility: UsageCostEligibility;
  run: UsageRunIdentity;
  cwd: string | null;
  serviceTier: string | null;
  inferenceGeo: string | null;
  speed: string | null;
  parserVersion: string;
}
export type UsageDiagnosticCode =
  | "invalid_record" | "missing_message_id" | "missing_session_id" | "missing_model"
  | "missing_timestamp" | "invalid_timestamp" | "missing_usage" | "missing_token"
  | "invalid_token" | "unsafe_token_integer" | "unknown_cache_split" | "invalid_cache_split"
  | "request_id_conflict" | "model_conflict" | "ambiguous_snapshot" | "attribution_conflict"
  | "missing_response_id";
export interface UsageDiagnostic {
  code: UsageDiagnosticCode;
  sourceId: string;
  generation: number;
  byteStart: number;
  identityKey: string | null;
}
export interface UsageNormalizationResult {
  observation: NormalizedUsageObservation | null;
  diagnostics: UsageDiagnostic[];
  ignored: boolean;
}
export interface CanonicalUsageRecord extends NormalizedUsageObservation {
  firstEventAt: number;
  snapshotAt: number;
  validity: "valid" | "conflict";
  attributionConflict: boolean;
  /** Unique source locations, sorted independently of ingestion/discovery order. */
  sourceLinks: NormalizedUsageObservation[];
}
export interface ReconciledUsage {
  records: CanonicalUsageRecord[];
  diagnostics: UsageDiagnostic[];
}
