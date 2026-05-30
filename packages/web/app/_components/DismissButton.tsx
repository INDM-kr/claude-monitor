"use client";

import { EyeOff } from "lucide-react";
import type { SessionSummary } from "@claude-monitor/core";
import { useDismissed, dismissKey } from "../../lib/dismissed";
import { t } from "../../lib/i18n/t";

/** Hide an already-stopped session from the dashboard (non-destructive — transcript untouched). */
export function DismissButton({ session }: { session: SessionSummary }) {
  const dismiss = useDismissed((s) => s.dismiss);
  if (session.status !== "stop") return null;
  return (
    <button
      type="button"
      onClick={() => dismiss(dismissKey(session))}
      className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
      title={t("dismiss.button")}
    >
      <EyeOff size={12} /> {t("dismiss.button")}
    </button>
  );
}
