"use client";

import { useEffect, useState } from "react";
import { useSessionStore } from "../../lib/store";
import { t } from "../../lib/i18n/t";

interface UsageWindows {
  block: { tokens: number; resetSec: number | null; active: boolean };
  week: { tokens: number };
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

/** Account-wide token usage strip (estimated from transcripts; 5h block + 7d). */
export function UsageBar() {
  const now = useSessionStore((s) => s.now);
  const [u, setU] = useState<UsageWindows | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/usage", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && d && setU(d))
        .catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!u) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-border-subtle px-2 py-1 font-mono text-[11px] text-zinc-500">
      <span className="text-zinc-400">⚡ {t("usage.title")}</span>
      <span>
        {t("usage.block")}: <span className="text-zinc-300">{fmtTok(u.block.tokens)}</span> tok
        {u.block.active && u.block.resetSec != null && (
          <>
            {" · "}
            {t("usage.reset")} {fmtClock(u.block.resetSec)}{" "}
            <span className="text-zinc-600">({fmtUntil(u.block.resetSec - now)})</span>
          </>
        )}
      </span>
      <span>
        {t("usage.week")}: <span className="text-zinc-300">{fmtTok(u.week.tokens)}</span> tok
      </span>
      <span className="text-zinc-600">· {t("usage.estimate")}</span>
    </div>
  );
}
