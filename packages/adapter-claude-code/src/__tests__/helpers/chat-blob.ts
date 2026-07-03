import { serialize } from "node:v8";
import SnappyJS from "snappyjs";

export interface BlobOpts {
  /** Include the Blink v17+ trailer (`0xfe` + 12 bytes) like real v21 data. */
  trailer?: boolean;
  /** IndexedDB SSV version byte (0x11 observed; the parser doesn't pin it). */
  ssvVersion?: number;
  blinkVersion?: number;
}

/**
 * Assemble a Chromium-IndexedDB-shaped cache blob the way Claude Desktop's
 * webview persists it: `0xff <ssv> 0x02` + snappy-raw(blink envelope + V8
 * structured clone). Node's `v8.serialize` writes the same clone wire format
 * the parser reads back, so fixtures are synthesized instead of committing a
 * real (privacy-laden) blob.
 */
export function buildCacheBlob(value: unknown, opts: BlobOpts = {}): Buffer {
  const payload = serialize(value); // starts 0xff <v8 version>
  const head: number[] = [0xff, opts.blinkVersion ?? 0x15];
  if (opts.trailer ?? true) head.push(0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const raw = Buffer.concat([Buffer.from(head), payload]);
  const compressed = Buffer.from(SnappyJS.compress(raw));
  return Buffer.concat([Buffer.from([0xff, opts.ssvVersion ?? 0x11, 0x02]), compressed]);
}

export function cacheWith(queries: unknown[]): unknown {
  return { clientState: { mutations: [], queries }, clientBuster: "test" };
}

export function listQuery(items: unknown[], variant: Record<string, unknown> = { limit: 30 }): unknown {
  return {
    queryKey: ["chat_conversation_list", { orgUuid: "org-1" }, variant],
    state: { data: { pages: [{ data: items }] } },
  };
}

/** The non-infinite (flat `{data: […]}`) list variant seen alongside `pages`. */
export function flatListQuery(items: unknown[]): unknown {
  return {
    queryKey: ["chat_conversation_list", { orgUuid: "org-1" }, "flat"],
    state: { data: { data: items } },
  };
}

export function treeQuery(tree: Record<string, unknown>): unknown {
  return {
    queryKey: ["chat_conversation_tree", { orgUuid: "org-1" }, { uuid: tree["uuid"] }],
    state: { data: tree },
  };
}

export function listItem(uuid: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid,
    name: `chat ${uuid}`,
    summary: `summary of ${uuid}`,
    model: "claude-fable-5",
    is_starred: false,
    created_at: "2026-06-01T00:00:00.000000Z",
    updated_at: "2026-06-02T00:00:00.000000Z",
    ...over,
  };
}

export function message(sender: string, text: string, createdAt: string): Record<string, unknown> {
  return {
    uuid: `msg-${sender}-${createdAt}`,
    text,
    content: [{ type: "text", text }],
    sender,
    created_at: createdAt,
  };
}
