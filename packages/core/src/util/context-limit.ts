import type { ContextUsage } from "../types/session.js";

const DEFAULT_LIMIT = 200_000;

/**
 * 모델명만으로는 1M 여부를 알 수 없다(transcript model엔 [1m] 접미사 없음).
 * 1M 감지는 프로세스 프로브의 --model 인자에서 별도 수행한다.
 */
export function contextLimitForModel(_model: string | null | undefined): number {
  return DEFAULT_LIMIT;
}

export function computeContext(tokens: number, limit: number): ContextUsage {
  const pct = limit > 0 ? Math.min(1, Math.max(0, tokens / limit)) : 0;
  return { tokens, limit, pct };
}
