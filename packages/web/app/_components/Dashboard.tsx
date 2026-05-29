"use client";

import { useEffect, useMemo } from "react";
import type { SessionSummary } from "@claude-monitor/core";
import { useSessionStore } from "../../lib/store";
import { groupByProject, type ProjectGroupData } from "../../lib/group";
import { ProjectGroup } from "./ProjectGroup";
import { FilterBar } from "./FilterBar";
import { t } from "../../lib/i18n/t";

export function Dashboard({ initial }: { initial: ProjectGroupData[] }) {
  const setInitial = useSessionStore((s) => s.setInitial);
  const upsert = useSessionStore((s) => s.upsert);
  const remove = useSessionStore((s) => s.remove);
  const setConnected = useSessionStore((s) => s.setConnected);
  const sessions = useSessionStore((s) => s.sessions);
  const connected = useSessionStore((s) => s.connected);

  useEffect(() => {
    const flat = initial.flatMap((g) => g.sessions);
    setInitial(flat);
  }, [initial, setInitial]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("summary", (e) => {
      try {
        upsert(JSON.parse((e as MessageEvent).data) as SessionSummary);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("removed", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { refId: string };
        remove(data.refId);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("heartbeat", () => setConnected(true));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [upsert, remove, setConnected]);

  const groups = useMemo(() => groupByProject([...sessions.values()]), [sessions]);

  return (
    <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <header className="space-y-3">
        <h1 className="text-lg font-semibold text-zinc-100">{t("app.title")}</h1>
        <FilterBar />
        {!connected && <div className="text-xs text-amber-400">{t("app.connectionLost")}</div>}
      </header>

      {groups.length === 0 ? (
        <div className="text-sm text-zinc-500">{t("app.noSessions")}</div>
      ) : (
        groups.map((g) => (
          <ProjectGroup
            key={g.projectKey}
            projectKey={g.projectKey}
            projectLabel={g.projectLabel}
            sessions={g.sessions}
          />
        ))
      )}

      <footer className="text-xs text-zinc-600 pt-4 border-t border-border-subtle">
        {t("app.legend")}: <span className="text-emerald-400">● {t("app.legendLive")}</span>{" "}
        <span className="text-amber-400">○ {t("app.legendIdle")}</span>{" "}
        <span className="text-zinc-500">· {t("app.legendStop")}</span>
        <span className="ml-3">— ETA·총 남은시간 표시 안 함</span>
      </footer>
    </main>
  );
}
