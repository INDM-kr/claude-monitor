"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { useSessionStore } from "../../lib/store";
import { t } from "../../lib/i18n/t";

interface Local {
  block: { tokens: number; resetSec: number | null; active: boolean; peakPrior: number };
  week: { tokens: number };
  limits: { block: number | null; week: number | null };
}
interface Api {
  fiveHour: { pct: number; resetSec: number | null };
  sevenDay: { pct: number; resetSec: number | null };
}
interface Resp {
  source: "api" | "estimate";
  api: Api | null;
  local: Local;
}

const CELLS = 10;

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
function fmtUntil(sec: number): string {
  if (sec <= 0) return "0m";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtClock(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function pctColor(pct: number): string {
  return pct >= 90 ? "text-red-400" : pct >= 70 ? "text-amber-400" : "text-emerald-400";
}

/** Terminal ▓░ bar for a 0-100 percentage. */
function Bar({ pct }: { pct: number }) {
  const filled = Math.max(0, Math.min(CELLS, Math.round((pct / 100) * CELLS)));
  return (
    <span className={clsx("tracking-tight", pctColor(pct))}>
      {"▓".repeat(filled)}
      <span className="text-zinc-700">{"░".repeat(CELLS - filled)}</span>
    </span>
  );
}

function Reset({ resetSec, now }: { resetSec: number | null; now: number }) {
  if (resetSec == null) return null;
  return (
    <>
      {" · "}
      {t("usage.reset")} {fmtClock(resetSec)}{" "}
      <span className="text-zinc-600">({fmtUntil(resetSec - now)})</span>
    </>
  );
}

/** Estimate-mode gauge: tokens vs a denominator (config limit or recent peak). */
function EstGauge({ tokens, denom, source }: { tokens: number; denom: number; source: string }) {
  const pct = denom > 0 ? (tokens / denom) * 100 : 0;
  return (
    <>
      {" "}
      <span className="text-zinc-600">/ {fmtTok(denom)}</span> <Bar pct={pct} />{" "}
      <span className={pctColor(pct)}>{Math.round(pct)}%</span>
      <span className="text-zinc-700"> ({source})</span>
    </>
  );
}

/** Account-wide token usage strip: authoritative % from the OAuth endpoint when
 *  available, else an estimate from local transcripts. */
export function UsageBar() {
  const now = useSessionStore((s) => s.now);
  const [r, setR] = useState<Resp | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/usage", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((d) => alive && d && setR(d))
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000); // endpoint is server-cached 5min; 60s UI poll is cheap
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!r) return null;

  if (r.source === "api" && r.api) {
    const { fiveHour, sevenDay } = r.api;
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-border-subtle px-2 py-1 font-mono text-[11px] text-zinc-500">
        <span className="text-zinc-400">⚡ {t("usage.title")}</span>
        <span>
          {t("usage.block")}: <span className={pctColor(fiveHour.pct)}>{Math.round(fiveHour.pct)}%</span>{" "}
          <Bar pct={fiveHour.pct} />
          <Reset resetSec={fiveHour.resetSec} now={now} />
        </span>
        <span>
          {t("usage.week")}: <span className={pctColor(sevenDay.pct)}>{Math.round(sevenDay.pct)}%</span>{" "}
          <Bar pct={sevenDay.pct} />
          <Reset resetSec={sevenDay.resetSec} now={now} />
        </span>
        <span className="text-zinc-600">· {t("usage.real")}</span>
      </div>
    );
  }

  // estimate fallback
  const { block, week, limits } = r.local;
  const blockDenom = limits.block ?? (block.peakPrior > 0 ? block.peakPrior : 0);
  const blockSource = limits.block ? t("usage.limit") : t("usage.peak");
  const weekDenom = limits.week ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-border-subtle px-2 py-1 font-mono text-[11px] text-zinc-500">
      <span className="text-zinc-400">⚡ {t("usage.title")}</span>
      <span>
        {t("usage.block")}: <span className="text-zinc-300">{fmtTok(block.tokens)}</span> tok
        {blockDenom > 0 && <EstGauge tokens={block.tokens} denom={blockDenom} source={blockSource} />}
        {block.active && <Reset resetSec={block.resetSec} now={now} />}
      </span>
      <span>
        {t("usage.week")}: <span className="text-zinc-300">{fmtTok(week.tokens)}</span> tok
        {weekDenom > 0 && <EstGauge tokens={week.tokens} denom={weekDenom} source={t("usage.limit")} />}
      </span>
      <span className="text-zinc-600">· {t("usage.estimate")}</span>
    </div>
  );
}
