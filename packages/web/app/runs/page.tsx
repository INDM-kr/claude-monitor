"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { RUNTIME_DEFAULTS, type RuntimeReport, type RuntimeRun } from "@claude-monitor/core";
import { LocalApiError, localFetch, setLocalBearer } from "../../lib/local-client";
import { LocalShell } from "../_components/LocalShell";
import "./runs.css";
const pollMs = RUNTIME_DEFAULTS.pollIntervalMs;
const activity: Record<RuntimeRun["activityState"], string> = { working: "작업 진행 관측", tool_requested: "도구 실행 요청", permission_requested: "권한 요청 관측", approval_wait: "승인 필요", input_wait: "입력 필요", idle: "응답 대기", unknown: "활동 미확인" };
const processLabel = { alive: "프로세스 실행 중", exited: "프로세스 종료", unknown: "생존 미확인" };
const outcome = { unknown: "업무 완료 미확인", response_ended: "응답 종료 · 업무 완료 미확인", response_failed: "응답 오류 · 업무 완료 미확인", session_ended: "세션 종료 · 업무 완료 미확인" };
/** Codex rows: a rollout `turn_aborted` arrives as StopFailure — an interrupted turn, not a response error. */
const codexAborted = (run: RuntimeRun) => run.providerId === "codex" && run.lastEventName === "StopFailure";
const time = (value: number | null) => value ? new Date(value).toLocaleTimeString("ko-KR") : "관측 없음";
export default function RunsPage() {
  const [data, setData] = useState<RuntimeReport | null>(null);
  const [error, setError] = useState(false);
  const [auth, setAuth] = useState(false);
  const [revision, setRevision] = useState(0);
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try { const result = await localFetch<RuntimeReport>("/api/runs", undefined, controller.signal);
        if (!controller.signal.aborted) { setData(result); setError(false); setAuth(false); }
      } catch (failure) { if (!controller.signal.aborted) { setError(true); setAuth(failure instanceof LocalApiError && failure.status === 401); } }
      finally { if (!controller.signal.aborted) timer = setTimeout(read, pollMs); }
    }
    void read(); return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const selected = data?.runs.find(run => run.runId === selectedId);
  const runs = data?.runs.filter(run => !onlyWaiting || run.interventionRequired) ?? [];
  return <LocalShell active="runs">
    <header className="runs-heading"><div><p className="runs-eyebrow">LOCAL / LIVE OBSERVATIONS</p><h1>실행 현황</h1><p>실행 중인 프로세스와 최근 활동을 따로 확인합니다.</p></div><span className="runs-updated">{data ? `확인 ${time(data.asOf)}` : "관측 준비 중"}</span></header>
    {auth && <form className="local-auth" onSubmit={event => { event.preventDefault(); setLocalBearer(String(new FormData(event.currentTarget).get("token"))); event.currentTarget.reset(); setRevision(value => value + 1); }}><label>로컬 접근 토큰 <input name="token" type="password" autoComplete="off" required /></label><button className="local-button">연결</button><small>현재 페이지 메모리에만 보관합니다.</small></form>}
    {error && !auth && <p role="alert" className="runs-notice">관측을 갱신하지 못했습니다. 표시된 기록은 현재 상태가 아닐 수 있습니다. <Link href="/settings">진단 확인</Link></p>}
    {data && !data.hookConfigured && <div className="runs-notice"><strong>실행 신호 연결이 필요합니다.</strong><p>사용량 기록만 있는 실행은 생존·대기 상태가 미확인입니다. <Link href="/settings">설정에서 관찰 hook 연결하기</Link></p></div>}
    {data?.hookConfigured && !data.runs.some(run => run.providerId === "claude-code" && run.lastEventAt !== null) && <p className="runs-notice">관찰 신호 수신이 활성화되었습니다. 아직 받은 신호가 없습니다. Claude Code의 hook 연결 상태를 확인해 주세요.</p>}
    <div className="runs-toolbar"><button type="button" aria-pressed={onlyWaiting} onClick={() => setOnlyWaiting(v => !v)}>개입 필요 {error ? "—" : data?.interventionCount ?? "—"}<span>{onlyWaiting ? " · 전체 보기" : " · 모아 보기"}</span></button><p>최근 {data?.runs.length ?? 0}개 / 전체 {data?.total ?? "—"}개</p></div>
    {!data && !error && <p role="status" className="runs-empty">실행 관측을 불러오고 있습니다.</p>}
    {data && runs.length === 0 && <div className="runs-empty"><h2>{onlyWaiting ? "최근 확인된 개입 요청이 없습니다" : "실행 관측이 없습니다"}</h2><p>{onlyWaiting ? "오래된 요청은 개입 필요 수에 포함하지 않습니다." : "Claude Code·Codex 기록을 가져오거나 관찰 hook을 연결하면 여기에 표시됩니다."}</p></div>}
    <div className="runs-list">{runs.map(run => <article key={run.runId} className="runs-row">
      <div className="runs-name"><p>{run.providerId === "codex" && <span className="runs-provider">Codex</span>}{run.projectLabel ?? "미분류 프로젝트"}{run.agentId ? " / 하위 실행" : ""}</p><button className="runs-link" onClick={() => setSelectedId(selectedId === run.runId ? null : run.runId)} aria-expanded={selectedId === run.runId} aria-controls={`evidence-${run.runId}`}>{run.workItems?.[0]?.title ?? run.agentId ?? run.sessionId}{(run.workItems?.length ?? 0) > 1 ? ` 외 ${run.workItems.length - 1}개` : ""}<span> 관측 근거 ↗</span></button></div>
      <div className="runs-state"><strong className={run.interventionRequired && !error ? "runs-attention" : ""}>{error ? "활동 미확인" : codexAborted(run) && run.freshness === "fresh" ? "중단" : activity[run.activityState]}</strong><p>{error ? "생존 미확인" : processLabel[run.processState]}</p></div>
      <div className="runs-fresh"><span>{error ? "갱신 실패" : run.freshness === "fresh" ? "최근 신호" : run.freshness === "stale" ? "관측 지연" : "신호 미연결"}</span><p>{time(run.lastEventAt)}</p></div>
      {selectedId === run.runId && selected && <div id={`evidence-${run.runId}`} className="runs-evidence"><h2>관측 근거</h2><dl><div><dt>실행 식별자</dt><dd>{selected.agentId ?? selected.sessionId}</dd></div><div><dt>연결된 작업</dt><dd>{selected.workItems?.map(work => work.title).join(" · ") || "연결된 작업 없음"}</dd></div><div><dt>최근 이벤트</dt><dd>{selected.lastEventName ?? "지원 신호 없음"}</dd></div><div><dt>도구</dt><dd>{selected.lastToolName ?? "미확인"}</dd></div><div><dt>관측 결과</dt><dd>{codexAborted(selected) ? "응답 중단 · 업무 완료 미확인" : outcome[selected.outcome]}</dd></div><div><dt>근거</dt><dd>{selected.evidence.join(" · ") || "기록 없음"}</dd></div></dl>{selected.providerId === "codex" && <p>Codex 상태는 기록 파일(rollout)의 작업 시작·항목 완료·응답 종료로 판단합니다. 승인·입력 대기와 프로세스 생존은 관측하지 않습니다.</p>}<p>{Math.round(data!.staleAfterMs / 1000)}초 이상 지난 활동은 미확인으로 바뀝니다. 프로세스가 살아 있어도 오래된 대기 요청을 현재 요청으로 표시하지 않습니다.</p><Link href={`/work?runId=${encodeURIComponent(run.runId)}`}>업무에 연결 →</Link></div>}
    </article>)}</div>
    {data?.truncated && <p className="runs-footnote">최근 실행 신호 또는 사용량 갱신 순으로 {data.runs.length}개를 표시합니다. 개입 필요 수는 표시된 실행 범위입니다.</p>}
    <p className="runs-footnote">응답 종료와 세션 종료는 업무 성공을 뜻하지 않습니다. 업무 결과는 작업 화면에서 직접 확인합니다.</p>
  </LocalShell>;
}
