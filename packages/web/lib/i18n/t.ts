import { ko } from "./ko";

type DeepValue = string | { [k: string]: DeepValue };

function dig(obj: DeepValue, path: string[]): string | undefined {
  let cur: DeepValue | undefined = obj;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, DeepValue>)[k];
  }
  return typeof cur === "string" ? cur : undefined;
}

export function t(key: string): string {
  const path = key.split(".");
  return dig(ko as unknown as DeepValue, path) ?? key;
}
