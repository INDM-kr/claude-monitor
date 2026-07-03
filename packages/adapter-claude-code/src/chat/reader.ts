import type { SessionReader, SessionRef, SessionStatus, SessionSummary } from "@claude-monitor/core";
import {
  defaultThresholds,
  deriveSessionStatus,
  statusFromMtime,
  type StatusThresholds,
} from "@claude-monitor/core";
import { conversationMtime, type ChatMessage } from "./parse.js";
import type { ChatStore } from "./store.js";

/** Mirrors parser.ts's LAST_TEXT_MAX / HUMAN_TURN_MAX truncation. */
const TEXT_MAX = 200;

/** Stand-in for a human turn that sent only attachments (no text). */
const ATTACHMENT_TURN_LABEL = "[attachment]";

export interface ChatReaderOptions {
  thresholds?: StatusThresholds;
}

/**
 * Reader for one claude.ai conversation out of the shared {@link ChatStore}.
 * List-only entries carry metadata (title/summary/model/updated_at); entries
 * whose `chat_conversation_tree` happens to be cached (recently opened) also
 * get full turns. There is no process or token telemetry — pid/context/token
 * fields stay null, and the runner is the synthetic "claude-desktop" (same as
 * cowork: the data comes from the Desktop app, not a live CLI process).
 */
export class ChatReader implements SessionReader {
  private cached: SessionSummary | null = null;
  private readonly thresholds: StatusThresholds;

  constructor(
    public readonly ref: SessionRef,
    private readonly store: ChatStore,
    opts: ChatReaderOptions = {},
  ) {
    this.thresholds = opts.thresholds ?? defaultThresholds;
  }

  status(now: number): SessionStatus {
    return statusFromMtime(this.cached?.ref.mtime ?? this.ref.mtime, now, this.thresholds);
  }

  async readIncremental(): Promise<SessionSummary> {
    const snap = await this.store.load();
    const conv = snap.conversations.get(this.ref.id);
    const now = Math.floor(Date.now() / 1000);
    if (!conv) {
      // Evicted from the cache between discovery and read — keep the last good
      // summary if any, else a metadata-less shell (graceful, never throw).
      return this.cached ?? this.shellSummary(now);
    }

    const mtime = conversationMtime(conv);
    const ref: SessionRef = { ...this.ref, mtime };
    const msgs = conv.messages;
    // Tree evicted by react-query GC while the list entry remains: keep the
    // previously extracted turn history instead of wiping the card. Completion
    // evidence (endedTurn/lastText) is only trusted while the conversation
    // hasn't moved on since (same mtime).
    const prev = this.cached;
    const retained = msgs == null && prev != null && prev.userTurns.length > 0 ? prev : null;
    const sameActivity = retained != null && retained.ref.mtime === mtime;
    const turns = retained
      ? { userTurns: retained.userTurns, responses: retained.userResponses ?? [], lastHumanSec: retained.turnStartSec }
      : foldTurns(msgs ?? []);
    // A tree whose last message is the assistant's = turn finished ("waiting").
    // List-only entries have no message evidence — never claim endedTurn.
    const endedTurn = retained
      ? sameActivity && retained.endedTurn
      : msgs != null && msgs.length > 0 && msgs[msgs.length - 1]!.sender === "assistant";
    const ageSec = Math.max(0, now - mtime);
    const status = deriveSessionStatus(ageSec, endedTurn, false, this.thresholds);
    const lastAssistant = [...turns.responses].reverse().find((t) => t) ?? null;
    const lastText = retained
      ? sameActivity
        ? retained.lastText
        : (truncate(conv.summary) ?? retained.lastText)
      : (lastAssistant ?? truncate(conv.summary));

    const summary: SessionSummary = {
      ref,
      status,
      lastTool: null,
      lastActivityDetail: null,
      pendingSubagents: [],
      todo: null,
      lastText,
      // Title stands in for the first prompt on list-only entries (no body in cache).
      firstPrompt: turns.userTurns[0] ?? truncate(conv.name),
      userTurns: turns.userTurns,
      userResponses: turns.responses,
      turnStartSec: turns.lastHumanSec,
      turnTokens: null,
      endedTurn,
      runner: "claude-desktop",
      model: conv.model,
      mode: null,
      version: null,
      context: null,
      pid: null,
      phase: null,
      agentStatus: null,
      metrics: null,
      totalTokens: null,
      updatedAt: now,
    };
    this.cached = summary;
    return summary;
  }

  close(): void {
    this.cached = null;
  }

  private shellSummary(now: number): SessionSummary {
    return {
      ref: this.ref,
      status: statusFromMtime(this.ref.mtime, now, this.thresholds),
      lastTool: null,
      lastActivityDetail: null,
      pendingSubagents: [],
      todo: null,
      lastText: null,
      firstPrompt: null,
      userTurns: [],
      userResponses: [],
      turnStartSec: null,
      turnTokens: null,
      endedTurn: false,
      runner: "claude-desktop",
      model: null,
      mode: null,
      version: null,
      context: null,
      pid: null,
      phase: null,
      agentStatus: null,
      metrics: null,
      totalTokens: null,
      updatedAt: now,
    };
  }
}

function truncate(s: string | null): string | null {
  return s ? s.slice(0, TEXT_MAX) : null;
}

/** Pair human turns with the last assistant text of each turn (same index),
 *  mirroring the shared parser's userTurns/userResponses contract. */
function foldTurns(msgs: ChatMessage[]): {
  userTurns: string[];
  responses: string[];
  lastHumanSec: number | null;
} {
  const userTurns: string[] = [];
  const responses: string[] = [];
  let lastHumanSec: number | null = null;
  for (const m of msgs) {
    if (m.sender === "human") {
      // Attachment-only turns carry no text but ARE turn boundaries — a
      // placeholder keeps the following assistant reply from being
      // misattributed to the previous question and starts the turn clock here.
      userTurns.push((m.text || ATTACHMENT_TURN_LABEL).slice(0, TEXT_MAX));
      responses.push("");
      if (m.createdAt) {
        const ms = Date.parse(m.createdAt);
        if (Number.isFinite(ms)) lastHumanSec = Math.floor(ms / 1000);
      }
    } else if (m.sender === "assistant" && m.text && userTurns.length > 0) {
      responses[userTurns.length - 1] = m.text.slice(0, TEXT_MAX);
    }
  }
  return { userTurns, responses, lastHumanSec };
}
