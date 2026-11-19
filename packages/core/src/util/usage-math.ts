import type { UsageTokens } from "../types/usage.js";

/** Cache creation TTL components are a split of cacheWrite, never added again. */
export function usageTotal(tokens: UsageTokens): bigint {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}
export function usageObservedContext(tokens: UsageTokens): bigint {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite;
}
export function sumUsageTokens(values: Iterable<UsageTokens>): UsageTokens {
  const sum: UsageTokens = { input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n };
  for (const value of values) {
    sum.input += value.input;
    sum.output += value.output;
    sum.cacheRead += value.cacheRead;
    sum.cacheWrite += value.cacheWrite;
  }
  return sum;
}
/** JSON tuple encoding avoids delimiter collisions in provider-native identifiers. */
export function usageIdentityKey(deviceId: string, providerId: string, responseId: string): string {
  return JSON.stringify([deviceId, providerId, responseId]);
}
export function usageRunKey(deviceId: string, providerId: string, sessionId: string, parentSessionId: string | null = null, agentId: string | null = null, workflowId: string | null = null): string {
  return JSON.stringify([deviceId, providerId, sessionId, parentSessionId, agentId, workflowId]);
}
