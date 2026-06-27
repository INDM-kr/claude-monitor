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
// Time remaining until reset, Korean units like Claude Desktop ("4시간 42분 후
// 재설정"). Adds days when the reset is more than a day out (e.g. weekly early in
// the week → "5일 3시간"); minutes are dropped once days are shown.
function fmtUntil(sec: number): string {
  if (sec <= 0) return "0분";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}일 ${h}시간` : `${d}일`;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}
function fmtClock(sec: number, withDay = false): string {
  const d = new Date(sec * 1000);
  // 24h clock (h23) so it never renders AM/PM. The weekly reset prepends the
  // weekday (e.g. "토 22:00") so "오후" isn't mistaken for a daily reset.
  const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return withDay ? `${d.toLocaleDateString("ko-KR", { weekday: "short" })} ${time}` : time;
}
function tone(pct: number | null): { text: string; bar: string } {
  if (pct == null) return { text: "text-zinc-400", bar: "bg-zinc-500" };
  if (pct >= 90) return { text: "text-status-error", bar: "bg-status-error" };
  if (pct >= 70) return { text: "text-status-waiting", bar: "bg-status-waiting" };
  return { text: "text-status-live", bar: "bg-status-live" };
}

/** One window gauge: label · slim bar · value · reset (click to rotate the reset
 *  display through clock / remaining / both). */
function Gauge({
  label,
  pct,
  value,
  title,
  reset,
  onResetClick,
}: {
  label: string;
  pct: number | null;
  value: string;
  title: string;
  reset?: string | null;
  onResetClick?: () => void;
}) {
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
      {reset && (
        <button
          type="button"
          onClick={onResetClick}
          title={t("usage.resetToggle")}
          className="tabular-nums text-zinc-500 hover:text-zinc-300"
        >
          ↻{reset}
        </button>
      )}
    </span>
  );
}

/** Account-wide token quota as a compact header gauge: authoritative % from the
 *  OAuth endpoint when available, else a local-transcript estimate. */
export function UsageBar() {
  const now = useSessionStore((s) => s.now);
  const [r, setR] = useState<Resp | null>(null);
  // Reset display rotates on click: 0 = clock, 1 = time remaining, 2 = both.
  const [resetMode, setResetMode] = useState(0);
  const cycleReset = () => setResetMode((m) => (m + 1) % 3);

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
  // Inline reset label per the rotation mode. isWeek adds the weekday to the clock.
  const fmtReset = (sec: number | null, isWeek: boolean): string | null => {
    if (sec == null) return null;
    const remain = fmtUntil(sec - now);
    const clock = fmtClock(sec, isWeek);
    // Default (mode 0) = time remaining, like Claude Desktop. Click rotates to the
    // reset clock, then both.
    return resetMode === 0 ? remain : resetMode === 1 ? clock : `${remain} · ${clock}`;
  };

  let blockPct: number | null;
  let weekPct: number | null;
  let blockVal: string;
  let weekVal: string;
  let blockTip: string;
  let weekTip: string;
  let blockResetSec: number | null = null;
  let weekResetSec: number | null = null;

  if (isApi) {
    blockPct = Math.round(r.api!.fiveHour.pct);
    weekPct = Math.round(r.api!.sevenDay.pct);
    blockVal = `${blockPct}%`;
    weekVal = `${weekPct}%`;
    blockTip = `${t("usage.block")} ${blockVal}${resetTip(r.api!.fiveHour.resetSec)}`;
    weekTip = `${t("usage.week")} ${weekVal}${resetTip(r.api!.sevenDay.resetSec)}`;
    blockResetSec = r.api!.fiveHour.resetSec;
    weekResetSec = r.api!.sevenDay.resetSec;
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
    // weekResetSec stays null — the local estimate has no fixed weekly reset anchor.
    blockResetSec = L.block.active ? L.block.resetSec : null;
  }
  const blockReset = fmtReset(blockResetSec, false);
  const weekReset = fmtReset(weekResetSec, true);

  return (
    <div
      className="inline-flex items-center gap-3 rounded-full border border-border bg-bg-raised px-3 py-1 font-mono text-[11px]"
      aria-label={t("usage.title")}
    >
      <span className="text-[16px] leading-none" title={isApi ? t("usage.real") : t("usage.estimate")}>⚡️</span>
      <Gauge label="5h" pct={blockPct} value={blockVal} title={blockTip} reset={blockReset} onResetClick={cycleReset} />
      <span className="h-3 w-px bg-border" />
      <Gauge label="7d" pct={weekPct} value={weekVal} title={weekTip} reset={weekReset} onResetClick={cycleReset} />
    </div>
  );
}
