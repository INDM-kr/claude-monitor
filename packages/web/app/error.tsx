"use client";

import { t } from "../lib/i18n/t";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="max-w-3xl mx-auto px-4 py-10 space-y-3 text-center">
      <h1 className="text-zinc-200">{t("errors.title")}</h1>
      <button
        type="button"
        onClick={reset}
        className="text-sm text-cyan-400 border border-cyan-500/40 rounded px-3 py-1 hover:text-cyan-200"
      >
        {t("errors.retry")}
      </button>
    </main>
  );
}
