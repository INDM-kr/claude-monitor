import type { SessionSummary } from "@claude-monitor/core";

interface ApiProjects {
  projects: Array<{ sessions: SessionSummary[] }>;
  /** Child (sub-agent) sessions — excluded from `projects` (which is grouped by
   *  root), returned separately so the snapshot stays complete. */
  children?: SessionSummary[];
}

/** /api/sessions 스냅샷을 평탄화해 반환 (재연결 후 누락분 복구용).
 *  roots(projects) + children 둘 다 포함해야 끝난 sub-agent가 재연결 후 사라지지 않음. */
export async function fetchSnapshot(): Promise<SessionSummary[]> {
  const res = await fetch("/api/sessions?all=1", { cache: "no-store" });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const data = (await res.json()) as ApiProjects;
  return [...data.projects.flatMap((p) => p.sessions), ...(data.children ?? [])];
}
