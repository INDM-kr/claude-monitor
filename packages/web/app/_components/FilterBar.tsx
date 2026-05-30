"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { t } from "../../lib/i18n/t";
import { parseStatuses } from "../../lib/filter";

const AGE_OPTIONS = [
  { label: "1h", value: "1" },
  { label: "24h", value: "24" },
  { label: "7d", value: "168" },
  { label: "전체", value: "" },
];

export function FilterBar() {
  const router = useRouter();
  const params = useSearchParams();
  const maxAge = params.get("maxAgeHours") ?? "24";
  const filter = params.get("filter") ?? "";
  const selectedStatuses = new Set(parseStatuses(params.get("status")));

  const statusOptions = [
    { label: t("filter.statusLive"), value: "live" },
    { label: t("filter.statusIdle"), value: "idle" },
    { label: t("filter.statusStop"), value: "stop" },
  ];

  const toggleStatus = (value: string) => {
    const next = new Set(selectedStatuses);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update({ status: next.size ? [...next].join(",") : null });
  };

  const update = useCallback(
    (next: Record<string, string | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === "") sp.delete(k);
        else sp.set(k, v);
      }
      router.replace(`/?${sp.toString()}`);
    },
    [params, router],
  );

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <div className="flex items-center gap-1">
        <span className="text-zinc-500">{t("app.maxAge")}:</span>
        {AGE_OPTIONS.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => update({ maxAgeHours: o.value || null, all: o.value ? null : "1" })}
            className={
              (o.value === maxAge ? "text-emerald-400 border-emerald-500/40" : "text-zinc-400 border-zinc-700") +
              " border px-2 py-0.5 rounded text-xs hover:text-zinc-200"
            }
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-zinc-500">{t("filter.status")}:</span>
        <button
          type="button"
          onClick={() => update({ status: null })}
          className={
            (selectedStatuses.size === 0 ? "text-emerald-400 border-emerald-500/40" : "text-zinc-400 border-zinc-700") +
            " border px-2 py-0.5 rounded text-xs hover:text-zinc-200"
          }
        >
          {t("filter.statusAll")}
        </button>
        {statusOptions.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => toggleStatus(o.value)}
            className={
              (selectedStatuses.has(o.value) ? "text-emerald-400 border-emerald-500/40" : "text-zinc-400 border-zinc-700") +
              " border px-2 py-0.5 rounded text-xs hover:text-zinc-200"
            }
          >
            {o.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-zinc-500">
        <span>{t("filter.projectFilter")}:</span>
        <input
          className="bg-bg-soft border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200"
          defaultValue={filter}
          placeholder="*claude-monitor*"
          onBlur={(e) => update({ filter: e.target.value || null })}
          onKeyDown={(e) => {
            if (e.key === "Enter") update({ filter: (e.target as HTMLInputElement).value || null });
          }}
        />
      </label>
    </div>
  );
}
