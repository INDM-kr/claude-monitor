"use client";

import { useState } from "react";
import { Skull } from "lucide-react";
import type { SessionSummary } from "@claude-monitor/core";
import { t } from "../../lib/i18n/t";

export function KillButton({ session }: { session: SessionSummary }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.pid == null) return null; // kill 불가(로컬 프로세스 미발견)

  async function doKill() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${session.ref.id}/kill?adapter=${session.ref.adapterId}`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        setError(body.reason ?? String(res.status));
      } else {
        setConfirming(false);
      }
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <span className="text-zinc-400">{t("kill.confirm")}</span>
        <button type="button" disabled={busy} onClick={doKill} className="text-red-400 hover:text-red-300 px-1">
          {t("kill.yes")}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="text-zinc-500 px-1">
          {t("kill.no")}
        </button>
        {error && <span className="text-red-500">{t("kill.failed")}: {error}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="text-zinc-500 hover:text-red-400"
      title={t("kill.button")}
      aria-label={t("kill.button")}
    >
      <Skull size={14} />
    </button>
  );
}
