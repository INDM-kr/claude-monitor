"use client";

import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import type { SessionSummary } from "@claude-monitor/core";
import { useSessionStore } from "../../lib/store";
import { groupByProject, childrenByParent } from "../../lib/group";
import { parseStatuses, sessionMatches } from "../../lib/filter";
import { deriveStatus } from "../../lib/derive-status";
import { ProjectGroup } from "./ProjectGroup";
import { OrphanChildren } from "./OrphanChildren";
import { FilterBar } from "./FilterBar";
import { UsageBar } from "./UsageBar";
import { t } from "../../lib/i18n/t";
import { fetchSnapshot } from "../../lib/sync";
import { useDismissed, dismissKey } from "../../lib/dismissed";

export function Dashboard({
  initial,
  filter,
}: {
  initial: SessionSummary[];
  filter: { maxAgeHours: number | null; all: boolean; filterGlob: string | null };
}) {
  const setInitial = useSessionStore((s) => s.setInitial);
  const upsert = useSessionStore((s) => s.upsert);
  const remove = useSessionStore((s) => s.remove);
  const setConnected = useSessionStore((s) => s.setConnected);
  const tick = useSessionStore((s) => s.tick);
  const sessions = useSessionStore((s) => s.sessions);
  const now = useSessionStore((s) => s.now);
  const connected = useSessionStore((s) => s.connected);
  const dismissed = useDismissed((s) => s.dismissed);
  const hydrateDismissed = useDismissed((s) => s.hydrate);
  const restoreAll = useDismissed((s) => s.restoreAll);

  useEffect(() => hydrateDismissed(), [hydrateDismissed]);

  // Client clock: advances time-relative UI (status decay, "X ago") between SSE
  // events. Without it, a session that stops writing stays "● LIVE / 2s ago".
  useEffect(() => {
    const id = setInterval(() => tick(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [tick]);

  // Expose the live header height as --cm-header-h so the project/session sticky
  // offsets stay correct when the header grows (filter wrap, connection banner).
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () =>
      document.documentElement.style.setProperty("--cm-header-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setInitial(initial);
  }, [initial, setInitial]);

  useEffect(() => {
    let wasErrored = false;
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
    es.onopen = () => {
      setConnected(true);
      if (wasErrored) {
        wasErrored = false;
        fetchSnapshot()
          .then((list) => setInitial(list))
          .catch(() => {
            /* 다음 틱에 재시도 */
          });
      }
    };
    es.onerror = () => {
      wasErrored = true;
      setConnected(false);
    };
    return () => es.close();
  }, [upsert, remove, setConnected, setInitial]);

  const searchParams = useSearchParams();
  const statusParam = searchParams.get("status");
  const visible = useMemo(() => {
    const statuses = parseStatuses(statusParam);
    const opts = {
      maxAgeHours: filter.maxAgeHours,
      all: filter.all,
      filterGlob: filter.filterGlob,
      statuses,
      now,
    };
    return [...sessions.values()].filter((s) => {
      if (dismissed.has(dismissKey(s))) return false;
      // Same filter the server applied on refresh — but with the live clock and
      // the derived status (deriveStatus), so the live view neither drifts from
      // the refresh snapshot nor leaks "stop" sessions into the idle filter.
      return sessionMatches(s, opts, deriveStatus(now, s));
    });
  }, [sessions, dismissed, statusParam, now, filter.maxAgeHours, filter.all, filter.filterGlob]);
  const hiddenCount = sessions.size - visible.length;
  const groups = useMemo(() => groupByProject(visible), [visible]);
  // Child (sub-agent) sessions render nested under their parent card, not as
  // top-level cards. groupByProject already excludes them from the groups.
  const childMap = useMemo(() => childrenByParent(visible), [visible]);
  // Orphans: visible children whose parent isn't a visible root (filtered out
  // by status/age). Surfaced under a synthetic parent header, never dropped.
  const orphans = useMemo(() => {
    const rootIds = new Set(visible.filter((s) => !s.ref.parentId).map((s) => s.ref.id));
    return [...childMap.entries()]
      .filter(([parentId]) => !rootIds.has(parentId))
      .map(([parentId, children]) => ({ parentId, children }));
  }, [visible, childMap]);

  return (
    <main className="max-w-7xl mx-auto px-4 py-6">
      <header ref={headerRef} className="sticky top-0 z-40 -mx-4 -mt-6 mb-6 box-border space-y-3 border-b border-border-subtle bg-[rgb(12_17_23_/_50%)] px-4 pt-6 pb-4 backdrop-blur-[4px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2.5">
            <span className="text-status-live">◐</span>
            <h1 className="text-base font-semibold text-zinc-100">{t("app.title")}</h1>
          </div>
          <UsageBar />
        </div>
        <FilterBar />
        {(!connected || hiddenCount > 0) && (
          <div className="flex items-center gap-3">
            {!connected && <span className="text-xs text-status-waiting">{t("app.connectionLost")}</span>}
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={restoreAll}
                className="text-xs text-zinc-500 underline hover:text-zinc-300"
              >
                {t("dismiss.restoreAll")} ({hiddenCount})
              </button>
            )}
          </div>
        )}
      </header>

      {groups.length === 0 && orphans.length === 0 ? (
        <div className="text-sm text-zinc-500">{t("app.noSessions")}</div>
      ) : (
        <div>
          {groups.map((g) => (
            <ProjectGroup
              key={g.projectKey}
              projectKey={g.projectKey}
              projectLabel={g.projectLabel}
              sessions={g.sessions}
              childrenByParent={childMap}
            />
          ))}
          {orphans.length > 0 && (
            <div className="font-mono text-[12px]">
              <OrphanChildren groups={orphans} />
            </div>
          )}
        </div>
      )}

      <footer className="sticky bottom-0 z-40 -mx-4 -mb-6 mt-6 box-border border-t border-border-subtle bg-[rgb(12_17_23_/_50%)] px-4 pt-4 pb-6 text-xs text-zinc-400 backdrop-blur-[4px]">
        {t("app.legend")}:{" "}
        <span className="text-status-live">● {t("app.legendLive")}</span>{" "}
        <span className="text-status-waiting">◐ {t("app.legendWaiting")}</span>{" "}
        <span className="text-zinc-400">○ {t("app.legendIdle")}</span>{" "}
        <span className="text-zinc-500">· {t("app.legendStop")}</span>
        <span className="ml-3 text-zinc-500">— ETA·총 남은시간 표시 안 함</span>
      </footer>
    </main>
  );
}
