import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRef } from "@claude-monitor/core";
import { ChatReader } from "../chat/reader.js";
import { ChatStore } from "../chat/store.js";
import { CHAT_ADAPTER_ID, CHAT_DISPLAY, CHAT_PROJECT_KEY } from "../chat/constants.js";
import { buildCacheBlob, cacheWith, listItem, listQuery, message, treeQuery } from "./helpers/chat-blob.js";

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function refFor(uuid: string, source: string): SessionRef {
  return {
    id: uuid,
    adapterId: CHAT_ADAPTER_ID,
    workspace: CHAT_DISPLAY,
    workspaceShort: CHAT_DISPLAY,
    projectKey: CHAT_PROJECT_KEY,
    projectLabel: CHAT_DISPLAY,
    owner: "example",
    source,
    mtime: Math.floor(Date.now() / 1000),
  };
}

describe("ChatReader", () => {
  let idbDir: string;
  let blobDir: string;

  beforeEach(async () => {
    idbDir = await fs.mkdtemp(join(tmpdir(), "cm-chat-reader-"));
    blobDir = join(idbDir, "https_claude.ai_0.indexeddb.blob", "1", "00");
    await fs.mkdir(blobDir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(idbDir, { recursive: true, force: true });
  });

  async function writeCache(queries: unknown[]): Promise<void> {
    await fs.writeFile(join(blobDir, "0a1b"), buildCacheBlob(cacheWith(queries)));
  }

  it("maps a list-only conversation: title as prompt, summary as text, no turn claims", async () => {
    const updated = iso(5_000);
    await writeCache([
      listQuery([listItem("c1", { name: "결제 완료", summary: "payments recap", model: "claude-fable-5", updated_at: updated })]),
    ]);
    const store = new ChatStore(idbDir);
    const s = await new ChatReader(refFor("c1", idbDir), store).readIncremental();
    expect(s.firstPrompt).toBe("결제 완료");
    expect(s.lastText).toBe("payments recap");
    expect(s.model).toBe("claude-fable-5");
    expect(s.userTurns).toEqual([]);
    expect(s.endedTurn).toBe(false);
    expect(s.status).toBe("live"); // fresh updated_at, no ended-turn evidence
    expect(s.runner).toBe("claude-desktop");
    expect(s.pid).toBeNull();
    expect(s.context).toBeNull();
    expect(s.ref.mtime).toBe(Math.floor(Date.parse(updated) / 1000));
  });

  it("maps a tree conversation: paired turns, waiting status, turn start", async () => {
    const t0 = iso(60_000);
    const t1 = iso(30_000);
    const tree = {
      ...listItem("c2", { name: "AI 보드게임", updated_at: iso(5_000) }),
      chat_messages: [
        message("human", "ai 보드게임 룰 마스터를 만들고싶어", t0),
        message("assistant", "좋은 아이디어네요 — 아발론부터 시작하죠.", t0),
        message("human", "MVP 범위는?", t1),
        message("assistant", "룰 설명 + 턴 진행 안내요.", t1),
      ],
    };
    await writeCache([treeQuery(tree)]);
    const s = await new ChatReader(refFor("c2", idbDir), new ChatStore(idbDir)).readIncremental();
    expect(s.userTurns).toEqual(["ai 보드게임 룰 마스터를 만들고싶어", "MVP 범위는?"]);
    expect(s.userResponses).toEqual(["좋은 아이디어네요 — 아발론부터 시작하죠.", "룰 설명 + 턴 진행 안내요."]);
    expect(s.firstPrompt).toBe("ai 보드게임 룰 마스터를 만들고싶어");
    expect(s.lastText).toBe("룰 설명 + 턴 진행 안내요.");
    expect(s.endedTurn).toBe(true);
    expect(s.status).toBe("waiting"); // assistant answered, recent
    expect(s.turnStartSec).toBe(Math.floor(Date.parse(t1) / 1000));
  });

  it("keeps endedTurn=false when the human message is last (turn in flight)", async () => {
    const tree = {
      ...listItem("c3", { updated_at: iso(5_000) }),
      chat_messages: [
        message("human", "질문", iso(10_000)),
        message("assistant", "답변", iso(8_000)),
        message("human", "추가 질문", iso(5_000)),
      ],
    };
    await writeCache([treeQuery(tree)]);
    const s = await new ChatReader(refFor("c3", idbDir), new ChatStore(idbDir)).readIncremental();
    expect(s.endedTurn).toBe(false);
    expect(s.status).toBe("live");
    expect(s.userResponses).toEqual(["답변", ""]);
  });

  it("treats attachment-only human turns as turn boundaries (no misattribution)", async () => {
    const t1 = iso(30_000);
    const tree = {
      ...listItem("c6", { updated_at: iso(5_000) }),
      chat_messages: [
        message("human", "explain this code", iso(60_000)),
        message("assistant", "answer ONE", iso(55_000)),
        { ...message("human", "", t1), content: [] }, // image-only turn
        message("assistant", "answer TWO about the image", iso(25_000)),
      ],
    };
    await writeCache([treeQuery(tree)]);
    const s = await new ChatReader(refFor("c6", idbDir), new ChatStore(idbDir)).readIncremental();
    expect(s.userTurns).toEqual(["explain this code", "[attachment]"]);
    expect(s.userResponses).toEqual(["answer ONE", "answer TWO about the image"]);
    expect(s.turnStartSec).toBe(Math.floor(Date.parse(t1) / 1000));
  });

  it("keeps turn history when the tree is evicted but the list entry remains", async () => {
    const updated = iso(5_000);
    const tree = {
      ...listItem("c7", { name: "제목", updated_at: updated }),
      chat_messages: [message("human", "질문", iso(10_000)), message("assistant", "답변", iso(8_000))],
    };
    await writeCache([treeQuery(tree)]);
    const store = new ChatStore(idbDir);
    const reader = new ChatReader(refFor("c7", idbDir), store);
    const first = await reader.readIncremental();
    expect(first.userTurns).toEqual(["질문"]);
    expect(first.endedTurn).toBe(true);

    // tree evicted, same updated_at → everything retained (nothing moved on)
    await fs.rm(join(blobDir, "0a1b"));
    await fs.writeFile(join(blobDir, "0a1c"), buildCacheBlob(cacheWith([listQuery([listItem("c7", { name: "제목", updated_at: updated })])])));
    const second = await reader.readIncremental();
    expect(second.userTurns).toEqual(["질문"]);
    expect(second.userResponses).toEqual(["답변"]);
    expect(second.endedTurn).toBe(true);
    expect(second.lastText).toBe("답변");

    // conversation moved on (newer updated_at) without a cached tree → history
    // kept, but completion evidence dropped
    const newer = iso(1_000);
    await fs.rm(join(blobDir, "0a1c"));
    await fs.writeFile(join(blobDir, "0a1d"), buildCacheBlob(cacheWith([listQuery([listItem("c7", { name: "제목", summary: "새 요약", updated_at: newer })])])));
    const third = await reader.readIncremental();
    expect(third.userTurns).toEqual(["질문"]);
    expect(third.endedTurn).toBe(false);
    expect(third.lastText).toBe("새 요약");
    expect(third.ref.mtime).toBe(Math.floor(Date.parse(newer) / 1000));
  });

  it("stops (not waits) for an old conversation", async () => {
    await writeCache([listQuery([listItem("c4", { updated_at: "2026-04-29T00:00:00Z" })])]);
    const s = await new ChatReader(refFor("c4", idbDir), new ChatStore(idbDir)).readIncremental();
    expect(s.status).toBe("stop");
  });

  it("degrades gracefully when the conversation was evicted from the cache", async () => {
    await writeCache([listQuery([listItem("other")])]);
    const store = new ChatStore(idbDir);
    const reader = new ChatReader(refFor("gone", idbDir), store);
    const s = await reader.readIncremental();
    expect(s.userTurns).toEqual([]);
    expect(s.firstPrompt).toBeNull();
    expect(s.runner).toBe("claude-desktop");
  });

  it("serves the last good summary if the conversation later vanishes", async () => {
    await writeCache([listQuery([listItem("c5", { name: "title", updated_at: iso(5_000) })])]);
    const store = new ChatStore(idbDir);
    const reader = new ChatReader(refFor("c5", idbDir), store);
    const first = await reader.readIncremental();
    expect(first.firstPrompt).toBe("title");
    // blob replaced without c5
    await fs.rm(join(blobDir, "0a1b"));
    await fs.writeFile(join(blobDir, "0a1c"), buildCacheBlob(cacheWith([listQuery([listItem("other")])])));
    const second = await reader.readIncremental();
    expect(second.firstPrompt).toBe("title");
  });
});
