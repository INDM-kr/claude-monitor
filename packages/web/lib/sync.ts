import type { SessionSummary } from "@claude-monitor/core";

interface ApiProjects {
  projects: Array<{ sessions: SessionSummary[] }>;
}

/** /api/sessions 스냅샷을 평탄화해 반환 (재연결 후 누락분 복구용) */
export async function fetchSnapshot(): Promise<SessionSummary[]> {
  const res = await fetch("/api/sessions?all=1", { cache: "no-store" });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const data = (await res.json()) as ApiProjects;
  return data.projects.flatMap((p) => p.sessions);
}
