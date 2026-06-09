import { notFound } from "next/navigation";
import Link from "next/link";
import { readUsageSeries } from "@claude-monitor/adapter-claude-code";
import { getDataSource } from "../../../lib/data-source/local";
import { t } from "../../../lib/i18n/t";
import { UsageTrend } from "../../_components/UsageTrend";
import { StatusBadge } from "../../_components/StatusBadge";
import { ContextBar } from "../../_components/ContextBar";
import { RunnerBadge } from "../../_components/RunnerBadge";

export const dynamic = "force-dynamic";

export default async function SessionDetail({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { adapter?: string };
}) {
  const adapterId = searchParams?.adapter ?? "claude-code";
  const ds = getDataSource();
  const s = await ds.getById(adapterId, params.id);
  if (!s) notFound();
  const series = await readUsageSeries(s.ref.source);

  return (
    <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      <Link href="/" className="text-xs text-cyan-400 hover:underline">{t("detail.back")}</Link>

      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <StatusBadge status={s.status} />
          <h1 className="text-base text-zinc-100">{s.ref.projectLabel}</h1>
          <RunnerBadge runner={s.runner} />
        </div>
        <div className="text-xs text-zinc-500 space-y-0.5">
          <div>{s.ref.workspace}</div>
          <div>{t("detail.source")}: {s.ref.source}</div>
          <div>
            {s.model && <span>{s.model} </span>}
            {s.mode && <span>· {s.mode} </span>}
            {s.version && <span>· v{s.version}</span>}
          </div>
        </div>
        <ContextBar context={s.context} />
      </header>

      <section className="space-y-2">
        <h2 className="text-sm text-zinc-300">{t("detail.usageTrend")}</h2>
        <UsageTrend points={series} />
      </section>

      {s.todo && (
        <section className="space-y-1 text-sm">
          <h2 className="text-zinc-300">{t("detail.todos")} ({s.todo.done}/{s.todo.total})</h2>
          {s.todo.current && <div className="text-amber-300">▸ {s.todo.current}</div>}
          {s.todo.next && <div className="text-zinc-500">· {s.todo.next}</div>}
        </section>
      )}

      {s.pendingSubagents.length > 0 && (
        <section className="space-y-1 text-sm">
          <h2 className="text-zinc-300">{t("detail.subagents")} ({s.pendingSubagents.length})</h2>
          {s.pendingSubagents.map((a) => (
            <div key={a.id} className="text-zinc-500">
              └ {a.desc}
              {a.type && a.type !== a.desc ? ` (${a.type})` : ""}
            </div>
          ))}
        </section>
      )}

      {s.lastText && (
        <section className="space-y-1 text-sm">
          <h2 className="text-zinc-300">{t("detail.lastMessage")}</h2>
          <p className="text-zinc-400 whitespace-pre-wrap">{s.lastText}</p>
        </section>
      )}
    </main>
  );
}
