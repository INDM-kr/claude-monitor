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

/** Terminal ▓░ bar for a 0-100 percentage (inline-block so it column-aligns). */
function Bar({ pct }: { pct: number }) {
  const filled = Math.max(0, Math.min(CELLS, Math.round((pct / 100) * CELLS)));
  return (
    <span className={clsx("tracking-tight", pctColor(pct))}>
      {"▓".repeat(filled)}
      <span className="text-zinc-700">{"░".repeat(CELLS - filled)}</span>
    </span>
  );
}

function reset(resetSec: number | null, now: number): string {
  if (resetSec == null) return "";
  return `· ${t("usage.reset")} ${fmtClock(resetSec)} (${fmtUntil(resetSec - now)})`;
}

/** One aligned window row: label | value | bar | reset, fixed-width columns. */
function Row({
  label,
  value,
  valueClass,
  valueW = "w-[5ch]",
  pct,
  tail,
}: {
  label: string;
  value: string;
  valueClass?: string;
  valueW?: string;
  pct: number | null;
  tail?: string;
}) {
  return (
    <div className="flex items-baseline px-2 leading-[1.3] whitespace-nowrap">
      <span className="inline-block w-[8ch] shrink-0 text-zinc-500">{label}</span>
      <span
        className={clsx("inline-block shrink-0 text-right tabular-nums", valueW, valueClass)}
      >
        {value}
      </span>
      <span className="ml-2 shrink-0">{pct != null ? <Bar pct={pct} /> : null}</span>
      {tail && <span className="ml-2 shrink-0 text-zinc-600">{tail}</span>}
    </div>
  );
}

/** Account-wide token usage strip: authoritative % from the OAuth endpoint when
 *  available, else an estimate from local transcripts. Two aligned rows. */
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
  const sourceLabel = isApi ? t("usage.real") : t("usage.estimate");

  return (
    <div className="border-y border-border-subtle py-1 font-mono text-[11px]">
      <div className="flex items-baseline gap-2 px-2 pb-0.5 text-zinc-400">
        <span>⚡ {t("usage.title")}</span>
        <span className="text-zinc-600">· {sourceLabel}</span>
      </div>
      {isApi ? (
        <>
          <Row
            label={t("usage.block")}
            value={`${Math.round(r.api!.fiveHour.pct)}%`}
            valueClass={pctColor(r.api!.fiveHour.pct)}
            pct={r.api!.fiveHour.pct}
            tail={reset(r.api!.fiveHour.resetSec, now)}
          />
          <Row
            label={t("usage.week")}
            value={`${Math.round(r.api!.sevenDay.pct)}%`}
            valueClass={pctColor(r.api!.sevenDay.pct)}
            pct={r.api!.sevenDay.pct}
            tail={reset(r.api!.sevenDay.resetSec, now)}
          />
        </>
      ) : (
        <EstimateRows local={r.local} now={now} />
      )}
    </div>
  );
}

function EstimateRows({ local, now }: { local: Local; now: number }) {
  const blockDenom = local.limits.block ?? (local.block.peakPrior > 0 ? local.block.peakPrior : 0);
  const blockPct = blockDenom > 0 ? (local.block.tokens / blockDenom) * 100 : null;
  const weekDenom = local.limits.week ?? 0;
  const weekPct = weekDenom > 0 ? (local.week.tokens / weekDenom) * 100 : null;
  const blockSrc = local.limits.block ? t("usage.limit") : t("usage.peak");
  return (
    <>
      <Row
        label={t("usage.block")}
        value={`${fmtTok(local.block.tokens)} tok`}
        valueClass="text-zinc-300"
        valueW="w-[10ch]"
        pct={blockPct}
        tail={[
          blockPct != null ? `${Math.round(blockPct)}% (${blockSrc})` : "",
          local.block.active ? reset(local.block.resetSec, now) : "",
        ]
          .filter(Boolean)
          .join(" ")}
      />
      <Row
        label={t("usage.week")}
        value={`${fmtTok(local.week.tokens)} tok`}
        valueClass="text-zinc-300"
        valueW="w-[10ch]"
        pct={weekPct}
        tail={weekPct != null ? `${Math.round(weekPct)}% (${t("usage.limit")})` : ""}
      />
    </>
  );
}
