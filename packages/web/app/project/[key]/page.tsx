import { notFound } from "next/navigation";
import Link from "next/link";
import { getProjectActivity } from "../../../lib/project-activity";
import { getDataSource } from "../../../lib/data-source/local";
import { ProjectHeatmap } from "../../_components/ProjectHeatmap";
import { t } from "../../../lib/i18n/t";

export const dynamic = "force-dynamic";

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
function fmtDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export default async function ProjectDetail({ params }: { params: { key: string } }) {
  const projectKey = decodeURIComponent(params.key);
  const activity = await getProjectActivity(projectKey);
  if (!activity) notFound();

  const sessions = (await getDataSource().snapshot())
    .filter((s) => s.ref.projectKey === projectKey && !s.ref.parentId)
    .sort((a, b) => b.ref.mtime - a.ref.mtime);

  return (
    <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <Link href="/" className="text-xs text-cyan-400 hover:underline">{t("detail.back")}</Link>

      <header className="space-y-1">
        <h1 className="break-all font-mono text-base text-zinc-100">📁 {activity.projectLabel}</h1>
        <div className="text-xs text-zinc-500">
          {activity.startSec != null && (
            <span>
              {t("project.since")} {fmtDate(activity.startSec)} ·{" "}
            </span>
          )}
          {t("project.sessions")} {activity.sessionCount} · {t("project.totalTokens")}{" "}
          <span className="text-zinc-300">{fmtCount(activity.totalTokens)}</span>
        </div>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm text-zinc-300">{t("project.activity")}</h2>
        <ProjectHeatmap daily={activity.daily} weekdayHour={activity.weekdayHour} />
      </section>

      <section className="space-y-1">
        <h2 className="text-sm text-zinc-300">
          {t("project.sessionList")} ({sessions.length})
        </h2>
        <ul className="divide-y divide-border-subtle">
          {sessions.map((s) => (
            <li key={s.ref.id}>
              <Link
                href={`/session/${s.ref.id}?adapter=${s.ref.adapterId}`}
                className="flex items-center gap-2 py-1.5 text-sm text-zinc-400 hover:text-zinc-100"
              >
                <span className="flex-1 truncate">
                  {s.userTurns?.[s.userTurns.length - 1] ?? s.firstPrompt ?? s.lastText ?? "—"}
                </span>
                {s.totalTokens != null && s.totalTokens > 0 && (
                  <span className="shrink-0 font-mono text-[11px] text-zinc-600">Σ {fmtCount(s.totalTokens)}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
