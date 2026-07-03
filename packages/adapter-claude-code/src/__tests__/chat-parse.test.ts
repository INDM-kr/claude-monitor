import { describe, expect, it } from "vitest";
import {
  conversationMtime,
  extractConversations,
  parseReactQueryBlob,
  stripBlinkEnvelope,
} from "../chat/parse.js";
import {
  buildCacheBlob,
  cacheWith,
  flatListQuery,
  listItem,
  listQuery,
  message,
  treeQuery,
} from "./helpers/chat-blob.js";

describe("parseReactQueryBlob", () => {
  it("round-trips a synthesized cache blob (trailer variant, like real v21 data)", () => {
    const blob = buildCacheBlob(cacheWith([listQuery([listItem("a")])]), { trailer: true });
    const parsed = parseReactQueryBlob(blob);
    expect(parsed).not.toBeNull();
    expect(parsed!.fingerprint.hasTrailer).toBe(true);
    expect(parsed!.fingerprint.blinkVer).toBe(0x15);
    expect(extractConversations(parsed!.cache)).toHaveLength(1);
  });

  it("round-trips without a trailer (pre-v17 blink envelope)", () => {
    const blob = buildCacheBlob(cacheWith([listQuery([listItem("a")])]), { trailer: false });
    const parsed = parseReactQueryBlob(blob);
    expect(parsed).not.toBeNull();
    expect(parsed!.fingerprint.hasTrailer).toBe(false);
  });

  it("tolerates an unknown SSV version byte (chain self-validates)", () => {
    const blob = buildCacheBlob(cacheWith([listQuery([listItem("a")])]), { ssvVersion: 0x12 });
    expect(parseReactQueryBlob(blob)).not.toBeNull();
  });

  it("rejects garbage, wrong magic, corrupt snappy, and non-cache values", () => {
    expect(parseReactQueryBlob(Buffer.from([]))).toBeNull();
    expect(parseReactQueryBlob(Buffer.from("not a blob at all"))).toBeNull();
    // right wrapper, snappy body is garbage
    expect(parseReactQueryBlob(Buffer.from([0xff, 0x11, 0x02, 0xde, 0xad, 0xbe, 0xef]))).toBeNull();
    // valid chain but the value isn't a react-query cache
    const notCache = buildCacheBlob({ somethingElse: true });
    expect(parseReactQueryBlob(notCache)).toBeNull();
    // valid snappy but no blink/v8 envelope inside
    const blob = buildCacheBlob(cacheWith([]));
    const truncated = blob.subarray(0, 8);
    expect(parseReactQueryBlob(truncated)).toBeNull();
  });
});

describe("stripBlinkEnvelope", () => {
  it("returns null for short or untagged buffers", () => {
    expect(stripBlinkEnvelope(Buffer.from([]))).toBeNull();
    expect(stripBlinkEnvelope(Buffer.from([0x00, 0x15, 0xff, 0x0f]))).toBeNull();
    // trailer tag but nothing after it
    expect(stripBlinkEnvelope(Buffer.from([0xff, 0x15, 0xfe, 0, 0]))).toBeNull();
  });
});

describe("extractConversations", () => {
  it("dedups queryKey variants by uuid, freshest fields win, messages survive", () => {
    const older = listItem("a", { name: "old name", updated_at: "2026-06-01T00:00:00Z", model: null });
    const newer = listItem("a", { name: "new name", updated_at: "2026-06-03T00:00:00Z" });
    const tree = {
      ...listItem("a", { updated_at: "2026-06-04T00:00:00Z" }),
      chat_messages: [message("human", "hi", "2026-06-04T00:00:00Z")],
    };
    const cache = cacheWith([
      listQuery([older], { limit: 5 }),
      listQuery([newer], { limit: 30 }),
      treeQuery(tree),
    ]);
    const convs = extractConversations(cache);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.updatedAt).toBe("2026-06-04T00:00:00Z");
    expect(convs[0]!.messages).toHaveLength(1);
    expect(convs[0]!.model).toBe("claude-fable-5");
  });

  it("reads both list shapes (infinite pages + flat data) and sorts by recency", () => {
    const cache = cacheWith([
      listQuery([listItem("a", { updated_at: "2026-06-01T00:00:00Z" })]),
      flatListQuery([listItem("b", { updated_at: "2026-06-05T00:00:00Z" })]),
    ]);
    const convs = extractConversations(cache);
    expect(convs.map((c) => c.uuid)).toEqual(["b", "a"]);
  });

  it("same-uuid tree variants: the fresher tree's messages win regardless of cache order", () => {
    const fresh = {
      ...listItem("a", { updated_at: "2026-06-05T00:00:00Z" }),
      chat_messages: [message("human", "q1", "2026-06-01T00:00:00Z"), message("human", "q2", "2026-06-05T00:00:00Z")],
    };
    const stale = {
      ...listItem("a", { updated_at: "2026-06-01T00:00:00Z" }),
      chat_messages: [message("human", "q1", "2026-06-01T00:00:00Z")],
    };
    // fresh first, stale second — processing order must not decide
    const convs = extractConversations(cacheWith([treeQuery(fresh), treeQuery(stale)]));
    expect(convs).toHaveLength(1);
    expect(convs[0]!.updatedAt).toBe("2026-06-05T00:00:00Z");
    expect(convs[0]!.messages!.map((m) => m.text)).toEqual(["q1", "q2"]);
  });

  it("a messageless tree variant (no chat_messages) never wipes seen messages", () => {
    const withMsgs = {
      ...listItem("a", { updated_at: "2026-06-01T00:00:00Z" }),
      chat_messages: [message("human", "q1", "2026-06-01T00:00:00Z")],
    };
    const withoutMsgs = listItem("a", { updated_at: "2026-06-05T00:00:00Z" }); // fresher but no chat_messages
    const convs = extractConversations(cacheWith([treeQuery(withMsgs), treeQuery(withoutMsgs)]));
    expect(convs[0]!.updatedAt).toBe("2026-06-05T00:00:00Z");
    expect(convs[0]!.messages!.map((m) => m.text)).toEqual(["q1"]);
  });

  it("keeps tree-only conversations (not present in any list page)", () => {
    const tree = { ...listItem("t"), chat_messages: [message("human", "hello", "2026-06-02T00:00:00Z")] };
    const convs = extractConversations(cacheWith([treeQuery(tree)]));
    expect(convs).toHaveLength(1);
    expect(convs[0]!.messages![0]!.text).toBe("hello");
  });

  it("falls back to content[] text blocks when the top-level text is empty", () => {
    const msg = {
      sender: "assistant",
      created_at: "2026-06-02T00:00:00Z",
      text: "",
      content: [
        { type: "text", text: "part one" },
        { type: "tool_use", name: "web_search" },
        { type: "text", text: "part two" },
      ],
    };
    const tree = { ...listItem("t"), chat_messages: [msg] };
    const convs = extractConversations(cacheWith([treeQuery(tree)]));
    expect(convs[0]!.messages![0]!.text).toBe("part one part two");
  });

  it("returns empty on schema drift or malformed shapes (graceful skip)", () => {
    expect(extractConversations(null)).toEqual([]);
    expect(extractConversations({})).toEqual([]);
    expect(extractConversations({ clientState: { queries: "nope" } })).toEqual([]);
    // renamed queryKey → nothing recognized, nothing thrown
    const drifted = cacheWith([
      { queryKey: ["conversations_v2", {}], state: { data: { data: [listItem("a")] } } },
    ]);
    expect(extractConversations(drifted)).toEqual([]);
    // recognized key but items missing uuid → skipped
    const noUuid = cacheWith([listQuery([{ name: "no uuid here" }])]);
    expect(extractConversations(noUuid)).toEqual([]);
  });
});

describe("conversationMtime", () => {
  it("parses updated_at (microsecond ISO), falls back to created_at, else 0", () => {
    const base = listItem("a", { updated_at: "2026-07-02T06:34:01.650334Z" });
    const conv = extractConversations(cacheWith([listQuery([base])]))[0]!;
    expect(conversationMtime(conv)).toBe(Math.floor(Date.parse("2026-07-02T06:34:01.650334Z") / 1000));

    const noUpdated = extractConversations(
      cacheWith([listQuery([listItem("b", { updated_at: null, created_at: "2026-06-01T00:00:00Z" })])]),
    )[0]!;
    expect(conversationMtime(noUpdated)).toBe(Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000));

    const none = extractConversations(
      cacheWith([listQuery([listItem("c", { updated_at: null, created_at: null })])]),
    )[0]!;
    expect(conversationMtime(none)).toBe(0);
  });
});
