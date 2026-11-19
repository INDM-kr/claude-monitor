import {
  parentInfoFromSubagentPath, usageIdentityKey, usageRunKey,
  type CanonicalUsageRecord, type NormalizedUsageObservation, type ReconciledUsage,
  type UsageDiagnostic, type UsageDiagnosticCode, type UsageNormalizationResult,
  type UsageSourceContext, type UsageTokens,
} from "@claude-monitor/core";

export const USAGE_PARSER_VERSION = "claude-code-usage-v1";
export const USAGE_PROVIDER_ID = "claude-code";
const TOKEN_FIELDS = [
  ["input", "input_tokens"], ["output", "output_tokens"],
  ["cacheRead", "cache_read_input_tokens"], ["cacheWrite", "cache_creation_input_tokens"],
] as const;
const ownObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identifier = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;

export function token(value: unknown): bigint | UsageDiagnosticCode {
  if (value === undefined || value === null) return "missing_token";
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return "invalid_token";
  if (!Number.isSafeInteger(value)) return "unsafe_token_integer";
  return BigInt(value);
}

/** Require a timezone and reject Date.parse's rollover of nonexistent dates. */
export function eventTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  if (match[8] !== "Z" && (Number(match[8]!.slice(1, 3)) > 23 || Number(match[8]!.slice(4)) > 59)) return null;
  const result = Date.parse(value);
  return Number.isSafeInteger(result) ? result : null;
}

export function validateContext(context: UsageSourceContext): void {
  if (!identifier(context.deviceId) || !identifier(context.sourceId) || !identifier(context.sourcePath) ||
      !Number.isSafeInteger(context.generation) || context.generation < 0 ||
      !Number.isSafeInteger(context.byteStart) || context.byteStart < 0 ||
      !Number.isSafeInteger(context.byteEnd) || context.byteEnd <= context.byteStart ||
      !Number.isSafeInteger(context.ingestedAt)) throw new TypeError("invalid_usage_source_context");
}

/** Pure, body-free projection. Source positions refer to complete JSONL records. */
export function normalizeUsageRecord(record: unknown, context: UsageSourceContext): UsageNormalizationResult {
  validateContext(context);
  const diagnostics: UsageDiagnostic[] = [];
  let identityKey: string | null = null;
  const diagnostic = (code: UsageDiagnosticCode): void => {
    diagnostics.push({ code, sourceId: context.sourceId, generation: context.generation, byteStart: context.byteStart, identityKey });
  };
  const invalid = (code: UsageDiagnosticCode): UsageNormalizationResult => {
    diagnostic(code);
    return { observation: null, diagnostics, ignored: false };
  };
  const data = ownObject(record);
  if (!data) return invalid("invalid_record");
  if (data.type !== "assistant") return { observation: null, diagnostics, ignored: true };
  const message = ownObject(data.message);
  if (!message) return invalid("invalid_record");
  if (message.model === "<synthetic>") return { observation: null, diagnostics, ignored: true };
  const responseId = identifier(message.id);
  if (!responseId) return invalid("missing_message_id");
  identityKey = usageIdentityKey(context.deviceId, USAGE_PROVIDER_ID, responseId);
  const nativeSessionId = identifier(data.sessionId);
  if (!nativeSessionId) return invalid("missing_session_id");
  const model = identifier(message.model);
  if (!model) return invalid("missing_model");
  if (data.timestamp === undefined || data.timestamp === null) return invalid("missing_timestamp");
  const eventAt = eventTimestamp(data.timestamp);
  if (eventAt === null) return invalid("invalid_timestamp");
  const usage = ownObject(message.usage);
  if (!usage) return invalid("missing_usage");
  const tokens: UsageTokens = { input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n };
  for (const [target, source] of TOKEN_FIELDS) {
    const value = token(usage[source]);
    if (typeof value === "string") return invalid(value);
    tokens[target] = value;
  }
  let cache5m: bigint | null = null, cache1h: bigint | null = null;
  let costEligibility: NormalizedUsageObservation["costEligibility"] = "eligible";
  const split = ownObject(usage.cache_creation);
  if (!split && usage.cache_creation === undefined) {
    if (tokens.cacheWrite === 0n) { cache5m = 0n; cache1h = 0n; }
    else costEligibility = "unknown_cache_split";
  } else if (!split) costEligibility = "invalid_cache_split";
  else {
    const five = token(split.ephemeral_5m_input_tokens), hour = token(split.ephemeral_1h_input_tokens);
    if (typeof five === "bigint") cache5m = five;
    if (typeof hour === "bigint") cache1h = hour;
    if (cache5m === null || cache1h === null || cache5m + cache1h !== tokens.cacheWrite) costEligibility = "invalid_cache_split";
  }
  if (costEligibility !== "eligible") diagnostic(costEligibility);
  if (data.requestId !== undefined && data.requestId !== null && !identifier(data.requestId)) return invalid("invalid_record");
  const child = parentInfoFromSubagentPath("", context.sourcePath);
  const parentNativeSessionId = child?.parentUuid ?? null;
  // Workflow runs can reuse an agent stem; include both in the native child identity.
  const nativeAgentId = child ? (child.wfId ? `${child.wfId}/${child.agentId}` : child.agentId) : null;
  const parentKey = parentNativeSessionId ? usageRunKey(context.deviceId, USAGE_PROVIDER_ID, parentNativeSessionId) : null;
  const observation: NormalizedUsageObservation = {
    identityKey, deviceId: context.deviceId, providerId: USAGE_PROVIDER_ID,
    sourceId: context.sourceId, generation: context.generation, byteStart: context.byteStart,
    byteEnd: context.byteEnd, ingestedAt: context.ingestedAt,
    recordId: identifier(data.uuid), responseId, requestId: identifier(data.requestId), model, eventAt,
    tokens, cache5m, cache1h, costEligibility,
    run: {
      key: usageRunKey(context.deviceId, USAGE_PROVIDER_ID, nativeSessionId, parentNativeSessionId, nativeAgentId, child?.wfId ?? null),
      nativeSessionId, nativeAgentId, parentNativeSessionId, parentKey, workflowId: child?.wfId ?? null,
    },
    cwd: identifier(data.cwd), serviceTier: identifier(usage.service_tier),
    inferenceGeo: identifier(usage.inference_geo), speed: identifier(usage.speed), parserVersion: USAGE_PARSER_VERSION,
  };
  return { observation, diagnostics, ignored: false };
}

function locationKey(value: NormalizedUsageObservation): string {
  return JSON.stringify([value.sourceId, value.generation, value.byteStart]);
}
function sourceKey(value: NormalizedUsageObservation): string {
  return JSON.stringify([value.sourceId, value.generation]);
}
function snapshotKey(value: NormalizedUsageObservation): string {
  return JSON.stringify([value.tokens.input.toString(), value.tokens.output.toString(), value.tokens.cacheRead.toString(), value.tokens.cacheWrite.toString(), value.cache5m?.toString() ?? null, value.cache1h?.toString() ?? null, value.costEligibility]);
}
function representativeKey(value: NormalizedUsageObservation): string {
  return JSON.stringify([
    snapshotKey(value), value.eventAt, value.requestId, value.model, value.run.key,
    value.cwd, value.recordId, value.byteEnd, value.serviceTier, value.inferenceGeo,
    value.speed, value.parserVersion, value.ingestedAt,
  ]);
}
function compareLocation(a: NormalizedUsageObservation, b: NormalizedUsageObservation): number {
  return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.generation - b.generation || a.byteStart - b.byteStart;
}

/**
 * Rebuild each response projection from its retained observations. No input order
 * is meaningful: offsets order one source generation, timestamps order sources.
 * Conflict rows stay addressable, but consumers MUST filter validity='valid'.
 */
export function reconcileUsageObservations(observations: Iterable<NormalizedUsageObservation>): ReconciledUsage {
  const groups = new Map<string, NormalizedUsageObservation[]>();
  for (const observation of observations) {
    const values = groups.get(observation.identityKey) ?? [];
    values.push(observation);
    groups.set(observation.identityKey, values);
  }
  const records: CanonicalUsageRecord[] = [], diagnostics: UsageDiagnostic[] = [];
  for (const identityKey of [...groups.keys()].sort()) {
    const values = groups.get(identityKey)!;
    const unique = new Map<string, NormalizedUsageObservation>();
    let locationConflict = false;
    for (const value of values) {
      const key = locationKey(value), prior = unique.get(key);
      if (prior && (snapshotKey(prior) !== snapshotKey(value) || prior.eventAt !== value.eventAt)) locationConflict = true;
      // Stable representative even when a caller supplies a contradictory location.
      if (!prior || representativeKey(value) < representativeKey(prior)) unique.set(key, value);
    }
    const sourceLinks = [...unique.values()].sort(compareLocation);
    const latestBySource = new Map<string, NormalizedUsageObservation>();
    for (const value of sourceLinks) {
      const key = sourceKey(value), prior = latestBySource.get(key);
      if (!prior || value.byteStart > prior.byteStart) latestBySource.set(key, value);
    }
    const latest = [...latestBySource.values()].sort((a, b) => b.eventAt - a.eventAt || compareLocation(a, b));
    const selected = latest[0]!;
    const newest = latest.filter((value) => value.eventAt === selected.eventAt);
    const requestIds = new Set(values.map((value) => value.requestId).filter((value) => value !== null));
    const models = new Set(values.map((value) => value.model));
    const conflictCodes: UsageDiagnosticCode[] = [];
    if (requestIds.size > 1) conflictCodes.push("request_id_conflict");
    if (models.size > 1) conflictCodes.push("model_conflict");
    if (locationConflict || new Set(newest.map(snapshotKey)).size > 1) conflictCodes.push("ambiguous_snapshot");
    const attributionConflict = new Set(values.map((value) => value.run.key)).size > 1 || new Set(values.map((value) => value.cwd).filter((value) => value !== null)).size > 1;
    const row: CanonicalUsageRecord = {
      ...selected, requestId: requestIds.size === 1 ? [...requestIds][0]! : selected.requestId,
      firstEventAt: values.reduce((min, value) => Math.min(min, value.eventAt), selected.eventAt),
      snapshotAt: selected.eventAt, validity: conflictCodes.length ? "conflict" : "valid",
      attributionConflict, sourceLinks,
    };
    records.push(row);
    const codes = [...conflictCodes, ...(attributionConflict ? ["attribution_conflict" as const] : [])];
    for (const code of codes) diagnostics.push({ code, sourceId: selected.sourceId, generation: selected.generation, byteStart: selected.byteStart, identityKey });
  }
  return { records, diagnostics };
}
