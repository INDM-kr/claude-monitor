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
function tone(pct: number | null): { text: string; bar: string } {
  if (pct == null) return { text: "text-zinc-400", bar: "bg-zinc-500" };
  if (pct >= 90) return { text: "text-status-error", bar: "bg-status-error" };
  if (pct >= 70) return { text: "text-status-waiting", bar: "bg-status-waiting" };
  return { text: "text-status-live", bar: "bg-status-live" };
}

/** One window gauge: label · slim bar · value. Reset time lives in the tooltip. */
function Gauge({ label, pct, value, title }: { label: string; pct: number | null; value: string; title: string }) {
  const c = tone(pct);
  return (
    <span className="inline-flex items-center gap-2" title={title}>
      <span className="text-zinc-500">{label}</span>
      <span className="h-[5px] w-[52px] overflow-hidden rounded-full border border-border bg-track">
        <span
          className={clsx("block h-full rounded-full transition-[width] duration-500", c.bar)}
          style={{ width: `${pct == null ? 0 : Math.max(pct, 4)}%` }}
        />
      </span>
      <span className={clsx("min-w-[3.4ch] text-right tabular-nums", c.text)}>{value}</span>
    </span>
  );
}

/** Account-wide token quota as a compact header gauge: authoritative % from the
 *  OAuth endpoint when available, else a local-transcript estimate. */
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
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!r) return null;
  const isApi = r.source === "api" && r.api;
  const resetTip = (sec: number | null) =>
    sec == null ? "" : ` · ${t("usage.reset")} ${fmtClock(sec)} (${fmtUntil(sec - now)})`;

  let blockPct: number | null;
  let weekPct: number | null;
  let blockVal: string;
  let weekVal: string;
  let blockTip: string;
  let weekTip: string;

  if (isApi) {
    blockPct = Math.round(r.api!.fiveHour.pct);
    weekPct = Math.round(r.api!.sevenDay.pct);
    blockVal = `${blockPct}%`;
    weekVal = `${weekPct}%`;
    blockTip = `${t("usage.block")} ${blockVal}${resetTip(r.api!.fiveHour.resetSec)}`;
    weekTip = `${t("usage.week")} ${weekVal}${resetTip(r.api!.sevenDay.resetSec)}`;
  } else {
    const L = r.local;
    const bDenom = L.limits.block ?? (L.block.peakPrior > 0 ? L.block.peakPrior : 0);
    const wDenom = L.limits.week ?? 0;
    blockPct = bDenom > 0 ? Math.round((L.block.tokens / bDenom) * 100) : null;
    weekPct = wDenom > 0 ? Math.round((L.week.tokens / wDenom) * 100) : null;
    blockVal = blockPct != null ? `${blockPct}%` : fmtTok(L.block.tokens);
    weekVal = weekPct != null ? `${weekPct}%` : fmtTok(L.week.tokens);
    blockTip = `${t("usage.block")} ${blockVal} (${t("usage.estimate")})${L.block.active ? resetTip(L.block.resetSec) : ""}`;
    weekTip = `${t("usage.week")} ${weekVal}`;
  }

  return (
    <div
      className="inline-flex items-center gap-3 rounded-full border border-border bg-bg-raised px-3 py-1 font-mono text-[11px]"
      aria-label={t("usage.title")}
    >
      <span className="text-status-waiting" title={isApi ? t("usage.real") : t("usage.estimate")}>⚡</span>
      <Gauge label="5h" pct={blockPct} value={blockVal} title={blockTip} />
      <span className="h-3 w-px bg-border" />
      <Gauge label="7d" pct={weekPct} value={weekVal} title={weekTip} />
    </div>
  );
}
