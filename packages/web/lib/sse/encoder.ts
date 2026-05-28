import type { SseEvent } from "./hub";

export function encodeSse(e: SseEvent): string {
  return `event: ${e.kind}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
