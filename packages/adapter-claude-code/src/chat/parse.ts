import { deserialize } from "node:v8";
import SnappyJS from "snappyjs";

/**
 * Parses the claude.ai react-query cache out of a Chromium IndexedDB blob.
 *
 * Pipeline (bottom-up, in decompose order):
 *   1. IndexedDB value wrapper : `0xff <SSV version> 0x02` (0x02 = snappy)
 *   2. snappy                  : RAW block format (no framing)
 *   3. Blink SSV envelope      : `0xff <blink ver>` + optional `0xfe` trailer (v17+)
 *   4. V8 structured clone     : `0xff <v8 ver>` — Node's own `v8.deserialize`
 *                                reads the same wire format
 *   5. app schema              : `clientState.queries[].queryKey` →
 *                                `chat_conversation_list` / `chat_conversation_tree`
 *
 * Version defense: no version byte is pinned — the chain self-validates (a
 * false-positive candidate fails snappy or V8 decoding and returns null), and
 * layer 5 skips anything that doesn't match the observed shape. Every function
 * here fails soft (null / empty) because the app schema can change with any
 * claude.ai deploy and a broken cache must never take the monitor down.
 */

/** Chromium serialization tag byte (leads both the Blink and V8 headers). */
const SERIALIZATION_TAG = 0xff;
/** IndexedDB value wrapper: byte 2 = compression mode, 0x02 = snappy. */
const IDB_COMPRESSION_SNAPPY = 0x02;
/** Blink SSV trailer tag (v17+): `0xfe` + 8B offset + 4B size (big-endian). */
const BLINK_TRAILER_TAG = 0xfe;
const BLINK_TRAILER_LEN = 13;

export interface ChatFingerprint {
  blinkVer: number;
  v8Ver: number;
  hasTrailer: boolean;
}

export interface ChatMessage {
  /** "human" | "assistant" (kept as string — schema not ours). */
  sender: string;
  createdAt: string | null;
  text: string;
}

export interface ChatConversation {
  uuid: string;
  name: string | null;
  summary: string | null;
  model: string | null;
  isStarred: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  /** Full messages when the `chat_conversation_tree` query happens to be cached
   *  (recently opened conversations only); null for list-only entries. */
  messages: ChatMessage[] | null;
}

export interface BlinkEnvelope {
  /** Payload starting at the V8 header (`0xff <ver>`). */
  body: Buffer;
  blinkVer: number;
  v8Ver: number;
  hasTrailer: boolean;
}

/** Strip the Blink SSV envelope; null when the bytes don't look like one. */
export function stripBlinkEnvelope(raw: Buffer): BlinkEnvelope | null {
  if (raw.length < 4 || raw[0] !== SERIALIZATION_TAG) return null;
  const blinkVer = raw[1]!;
  let idx = 2;
  let hasTrailer = false;
  if (raw[idx] === BLINK_TRAILER_TAG) {
    hasTrailer = true;
    idx += BLINK_TRAILER_LEN;
  }
  if (idx + 1 >= raw.length || raw[idx] !== SERIALIZATION_TAG) return null;
  const v8Ver = raw[idx + 1]!;
  return { body: raw.subarray(idx), blinkVer, v8Ver, hasTrailer };
}

/** Decode one blob candidate into the react-query cache object; null unless the
 *  full chain succeeds AND the result carries `clientState` (content detection —
 *  blob file numbering is unstable, so callers probe every file). */
export function parseReactQueryBlob(buf: Buffer): { cache: Record<string, unknown>; fingerprint: ChatFingerprint } | null {
  if (buf.length < 4 || buf[0] !== SERIALIZATION_TAG || buf[2] !== IDB_COMPRESSION_SNAPPY) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(SnappyJS.uncompress(buf.subarray(3)));
  } catch {
    return null;
  }
  const env = stripBlinkEnvelope(raw);
  if (!env) return null;
  let val: unknown;
  try {
    val = deserialize(env.body);
  } catch {
    // Unknown clone tag (future V8) or a Blink host object — skip, don't raise.
    return null;
  }
  const cache = asRecord(val);
  if (!cache || !("clientState" in cache)) return null;
  return { cache, fingerprint: { blinkVer: env.blinkVer, v8Ver: env.v8Ver, hasTrailer: env.hasTrailer } };
}

/**
 * App-schema layer: pull conversations out of the cache's queries. List entries
 * (metadata for the recent ~30+) and tree entries (full messages for recently
 * opened ones) are merged per uuid — queryKey variants (limit30/limit5/starred)
 * duplicate list items, so the freshest variant wins field-by-field and
 * messages are never dropped once seen. Unknown shapes are skipped silently.
 */
export function extractConversations(cache: unknown): ChatConversation[] {
  const clientState = asRecord(asRecord(cache)?.["clientState"]);
  const queries = clientState?.["queries"];
  if (!Array.isArray(queries)) return [];

  const byUuid = new Map<string, ChatConversation>();
  const trees: Record<string, unknown>[] = [];
  for (const q of queries) {
    const qr = asRecord(q);
    const qk = qr?.["queryKey"];
    if (!Array.isArray(qk) || typeof qk[0] !== "string") continue;
    const data = asRecord(asRecord(qr?.["state"])?.["data"]);
    if (!data) continue;
    if (qk[0] === "chat_conversation_tree") {
      trees.push(data);
    } else if (qk[0] === "chat_conversation_list") {
      // Observed shapes: infinite query `{pages:[{data:[…]}]}` and flat `{data:[…]}`.
      const pages = Array.isArray(data["pages"]) ? data["pages"] : [data];
      for (const pg of pages) {
        const items = asRecord(pg)?.["data"];
        if (!Array.isArray(items)) continue;
        for (const it of items) {
          const r = asRecord(it);
          if (r) upsert(byUuid, r, null);
        }
      }
    }
  }
  // Trees last so their (fresher, message-bearing) variant wins the merge.
  for (const t of trees) upsert(byUuid, t, extractMessages(t));
  return [...byUuid.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** Last-activity epoch seconds for a conversation (`updated_at`, falling back
 *  to `created_at`; 0 when neither parses — an entry with no evidence of
 *  activity should age out, not surface as fresh). */
export function conversationMtime(conv: ChatConversation): number {
  for (const ts of [conv.updatedAt, conv.createdAt]) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

function upsert(byUuid: Map<string, ChatConversation>, raw: Record<string, unknown>, messages: ChatMessage[] | null): void {
  const uuid = strOrNull(raw["uuid"]);
  if (!uuid) return;
  const next: ChatConversation = {
    uuid,
    name: strOrNull(raw["name"]),
    summary: strOrNull(raw["summary"]),
    model: strOrNull(raw["model"]),
    isStarred: raw["is_starred"] === true,
    createdAt: strOrNull(raw["created_at"]),
    updatedAt: strOrNull(raw["updated_at"]),
    messages,
  };
  const prev = byUuid.get(uuid);
  if (!prev) {
    byUuid.set(uuid, next);
    return;
  }
  const fresher = (next.updatedAt ?? "") >= (prev.updatedAt ?? "") ? next : prev;
  const older = fresher === next ? prev : next;
  byUuid.set(uuid, {
    ...fresher,
    name: fresher.name ?? older.name,
    summary: fresher.summary ?? older.summary,
    model: fresher.model ?? older.model,
    createdAt: fresher.createdAt ?? older.createdAt,
    updatedAt: fresher.updatedAt ?? older.updatedAt,
    // Same fresher-wins rule as the scalars: null means "this variant carries
    // no tree" and never wipes — cache processing order must not decide.
    messages: fresher.messages ?? older.messages,
  });
}

function extractMessages(tree: Record<string, unknown>): ChatMessage[] | null {
  const raw = tree["chat_messages"];
  if (!Array.isArray(raw)) return null;
  const msgs: ChatMessage[] = [];
  for (const m of raw) {
    const r = asRecord(m);
    if (!r) continue;
    msgs.push({
      sender: strOrNull(r["sender"]) ?? "unknown",
      createdAt: strOrNull(r["created_at"]),
      text: messageText(r).trim(),
    });
  }
  return msgs;
}

/** Message text: the top-level `text` convenience field, else joined
 *  `content[]` text blocks (mirrors the tree shape observed 2026-07). */
function messageText(m: Record<string, unknown>): string {
  const direct = m["text"];
  if (typeof direct === "string" && direct.trim()) return direct;
  const blocks = m["content"];
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const b of blocks) {
    const r = asRecord(b);
    if (r && r["type"] === "text" && typeof r["text"] === "string" && r["text"]) parts.push(r["text"]);
  }
  return parts.join(" ");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
