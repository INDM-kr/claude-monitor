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
      className="text-zinc-500 hover:text-zinc-300"
      title={t("dismiss.button")}
      aria-label={t("dismiss.button")}
    >
      <EyeOff size={14} />
    </button>
  );
}
