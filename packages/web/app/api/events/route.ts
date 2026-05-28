import type { NextRequest } from "next/server";
import { getDataSource } from "../../../lib/data-source/local";
import { getHub, type SseEvent } from "../../../lib/sse/hub";
import { encodeSse } from "../../../lib/sse/encoder";
import { checkBearer, unauthorized } from "../../../lib/auth/middleware";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 30_000;

export async function GET(req: NextRequest): Promise<Response> {
  const auth = checkBearer(req);
  if (!auth.ok) return unauthorized();

  // Make sure the data source has discovered sessions & wired its watchers.
  await getDataSource().ensureDiscovered();

  const encoder = new TextEncoder();
  const hub = getHub();

  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: SseEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeSse(e)));
        } catch {
          // Stream closed — cleanup will run on cancel().
        }
      };
      unsubscribe = hub.subscribe(send);
      heartbeat = setInterval(
        () => send({ kind: "heartbeat", data: { ts: Date.now() } }),
        HEARTBEAT_MS,
      );
      // initial heartbeat so the client knows the stream is open
      send({ kind: "heartbeat", data: { ts: Date.now() } });
    },
    cancel() {
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
