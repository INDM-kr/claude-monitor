"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LocalShell } from "../_components/LocalShell";
import { LocalApiError, localFetch, setLocalBearer } from "../../lib/local-client";
import "./work.css";

type Run = { id: string; native_session_id: string; native_agent_id: string | null; project_label?: string };
type Work = {
  id: string; title: string; purpose: string; project_id: string | null; project_label: string | null;
  status: "open" | "verified"; updated_at: string; observed_tokens: string; request_count: number;
  runs: Run[]; artifacts: { id: string; label: string; reference: string; kind: string }[];
  history: { kind: string; note: string; created_at: string }[];
};
type Data = { items: Work[]; projects: { id: string; label: string }[]; availableRuns: Run[]; limit: number; runsLimit: number; totalItems: number; totalRuns: number };
const labels: Record<string, string> = { created: "작업 생성", edited: "목적·제목 수정", run_linked: "실행 연결", run_unlinked: "실행 연결 해제", artifact_added: "결과물 추가", verified: "사용자 검증 완료", reopened: "작업 다시 열기" };
const errorLabels: Record<string, string> = { unauthorized: "접근 토큰을 입력해 주세요.", collector_unavailable: "수집기에 연결할 수 없습니다. 설정·진단에서 실행 상태를 확인하세요.", artifact_required: "먼저 결과물을 연결해 주세요.", reopen_before_editing: "완료한 작업은 다시 연 뒤 수정할 수 있습니다.", invalid_artifact_reference: "http(s) 주소 또는 절대 파일 경로를 입력하세요.", run_not_found: "실행을 찾지 못했습니다. 목록을 새로고침해 주세요." };
const date = (value: string) => new Date(Number(value)).toLocaleString("ko-KR");

export default function WorkPage() {
  const [data, setData] = useState<Data | null>(null), [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [auth, setAuth] = useState(false);
  const [creating, setCreating] = useState(false), [editing, setEditing] = useState(false), [filter, setFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [pendingRun, setPendingRun] = useState<string | null>(null);
  const readVersion = useRef(0);
  async function reload(signal?: AbortSignal) {
    const version = ++readVersion.current;
    try { const result = await localFetch<Data>("/api/work-items", undefined, signal); if (version !== readVersion.current || signal?.aborted) return; setData(result); setError(null); setAuth(false); }
    catch (failure) { if (signal?.aborted || version !== readVersion.current) return; fail(failure); }
  }
  function fail(failure: unknown) {
    const code = failure instanceof LocalApiError ? failure.code : "request_failed";
    setAuth(code === "unauthorized"); setError(errorLabels[code] ?? "요청을 처리하지 못했습니다. 입력을 확인하고 다시 시도하세요.");
  }
  useEffect(() => { const controller = new AbortController(); setPendingRun(new URLSearchParams(window.location.search).get("runId")); void reload(controller.signal); return () => controller.abort(); }, []);
  const selected = data?.items.find(item => item.id === selectedId);
  async function mutate(payload: Record<string, unknown>) {
    setBusy(true); setError(null); setMessage("");
    try {
      const result = await localFetch<{ id: string }>("/api/work-items", payload);
      await reload(); setSelectedId(result.id); setCreating(false); setEditing(false); setMessage("저장했습니다.");
    } catch (failure) { fail(failure); } finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>, action: string, extra: Record<string, unknown> = {}) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void mutate({ action, ...Object.fromEntries(form), ...extra });
  }
  return <LocalShell active="work">
    <div className="l3-page">
      <header className="l3-heading"><div><p className="l3-eyebrow">LOCAL WORKSPACE</p><h1>작업과 결과</h1><p>목적부터 결과 확인까지, 여러 실행을 하나의 작업에 연결하세요.</p></div>
        <button className="l3-primary" onClick={() => { setCreating(true); setEditing(false); setSelectedId(null); }}>새 작업</button></header>
      {error && <div role="alert" className="l3-notice l3-error">{error} <button onClick={() => void reload()}>다시 불러오기</button></div>}
      {auth && <form className="l3-inline" onSubmit={event => { event.preventDefault(); setLocalBearer(String(new FormData(event.currentTarget).get("token"))); void reload(); }}><label>로컬 접근 토큰<input name="token" type="password" autoComplete="off" required /></label><button className="l3-primary">연결</button><small>토큰은 이 페이지의 메모리에만 유지합니다.</small></form>}
      <p role="status" className="l3-feedback">{busy ? "저장 중…" : message}</p>
      {pendingRun && data?.availableRuns.some(run => run.id === pendingRun) && <p className="l3-notice">실행 화면에서 선택한 실행을 연결할 수 있습니다. 작업을 선택하거나 새로 만든 뒤 실행 연결을 눌러 주세요.</p>}
      {!data && !error && <p role="status" className="l3-empty">작업 이력을 불러오는 중…</p>}
      {data && <div className="l3-workspace">
        <section className="l3-list" aria-label="작업 목록">
          <div className="l3-list-heading"><h2>내 작업 <span>{data.totalItems}</span></h2><select aria-label="작업 상태 필터" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">전체</option><option value="open">진행 중</option><option value="verified">검증 완료</option></select></div>
          {data.items.filter(item => filter === "all" || item.status === filter).map(item => <button key={item.id} className="l3-work-row" aria-pressed={selectedId === item.id} onClick={() => { setSelectedId(item.id); setCreating(false); setEditing(false); setMessage(""); }}>
            <span className="l3-row-top">{item.project_label ?? "프로젝트 미지정"}<span className={item.status === "verified" ? "l3-verified" : ""}>{item.status === "verified" ? "검증 완료" : "진행 중"}</span></span>
            <strong>{item.title}</strong><span className="l3-row-meta">실행 {item.runs.length}개 · {BigInt(item.observed_tokens).toLocaleString()} 토큰</span>
          </button>)}
          {data.items.length === 0 && <p className="l3-empty">아직 등록한 작업이 없습니다.<br />새 작업에 목적을 적고 실행을 연결하세요.</p>}
          {data.totalItems > data.limit && <p className="l3-help">최근 수정한 {data.limit}개 작업을 표시합니다.</p>}
        </section>
        <section className="l3-detail" aria-label="작업 상세">
          {(creating || (editing && selected)) ? <form key={selected?.id ?? "new"} onSubmit={event => submit(event, creating ? "create" : "update", creating ? {} : { id: selected!.id })} className="l3-form">
            <h2>{creating ? "새 작업" : "작업 수정"}</h2>
            <label>작업 제목<input name="title" maxLength={160} required autoFocus defaultValue={creating ? "" : selected?.title} placeholder="예: 프로젝트 사용량 리포트 개선" /></label>
            <label>목적<textarea name="purpose" maxLength={4000} rows={4} defaultValue={creating ? "" : selected?.purpose} placeholder="어떤 결과를 얻으려는 작업인가요?" /></label>
            <label>프로젝트<select name="projectId" defaultValue={creating ? "" : selected?.project_id ?? ""}><option value="">미지정</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.label}</option>)}</select></label>
            <div className="l3-actions"><button className="l3-primary" disabled={busy}>저장</button><button type="button" onClick={() => { setCreating(false); setEditing(false); }}>취소</button></div>
          </form> : selected ? <>
            <div className="l3-detail-heading"><div><p className="l3-eyebrow">{selected.project_label ?? "프로젝트 미지정"}</p><h2>{selected.title}</h2></div>{selected.status === "open" && <button onClick={() => setEditing(true)}>수정</button>}</div>
            <p className="l3-purpose">{selected.purpose || "목적이 아직 작성되지 않았습니다."}</p>
            <div className="l3-facts"><div><small>작업 상태</small><strong>{selected.status === "verified" ? "사용자 검증 완료" : "진행 중"}</strong></div><div><small>연결된 실행 사용량</small><strong>{BigInt(selected.observed_tokens).toLocaleString()} <small>토큰</small></strong></div><div><small>관측 요청</small><strong>{selected.request_count.toLocaleString()} <small>개</small></strong></div></div>
            <p className="l3-help">연결한 실행만 합산합니다. 하나의 실행을 여러 작업에 연결할 수 있으므로 작업 간 합계는 더하지 않습니다.</p>
            <section className="l3-section"><h3>연결한 실행</h3>
              {selected.runs.map(run => <div className="l3-connected" key={run.id}><div><code>{run.native_session_id}</code>{run.native_agent_id && <small>하위 에이전트 · {run.native_agent_id}</small>}</div>{selected.status === "open" && <button disabled={busy} aria-label={`${run.native_session_id} 연결 해제`} onClick={() => void mutate({ action: "unlinkRun", id: selected.id, runId: run.id })}>해제</button>}</div>)}
              {!selected.runs.length && <p className="l3-help">연결된 실행이 없습니다.</p>}
              {selected.status === "open" && <form className="l3-inline" key={`${selected.id}-${selected.runs.length}`} onSubmit={event => submit(event, "linkRun", { id: selected.id })}><label>실행 선택<select name="runId" required defaultValue={pendingRun && data.availableRuns.some(run => run.id === pendingRun) && !selected.runs.some(run => run.id === pendingRun) ? pendingRun : ""}><option value="" disabled>연결할 실행을 선택하세요</option>{data.availableRuns.filter(run => !selected.runs.some(link => link.id === run.id)).map(run => <option key={run.id} value={run.id}>{run.project_label ?? "미분류"} · {run.native_agent_id ? `하위 ${run.native_agent_id}` : run.native_session_id}</option>)}</select></label><button disabled={busy}>연결</button></form>}
              {data.totalRuns > data.runsLimit && <p className="l3-help">최근 등록한 실행 {data.runsLimit}개를 선택할 수 있습니다.</p>}
            </section>
            <section className="l3-section"><h3>결과물</h3>{selected.artifacts.map(artifact => <div className="l3-artifact" key={artifact.id}>{artifact.kind === "link" ? <a href={artifact.reference} target="_blank" rel="noreferrer">{artifact.label} ↗</a> : <strong>{artifact.label}</strong>}<small>{artifact.reference}</small></div>)}
              {selected.status === "open" && <form className="l3-form l3-compact" onSubmit={event => submit(event, "artifact", { id: selected.id })}><label>결과물 이름<input name="label" required maxLength={160} placeholder="PR, 문서, 테스트 결과 등" /></label><label>주소 또는 파일 경로<input name="reference" required maxLength={2048} placeholder="https://… 또는 /절대/파일/경로" /></label><p className="l3-help">파일 경로는 참조로만 저장하며 파일을 읽거나 업로드하지 않습니다.</p><button disabled={busy}>결과물 연결</button></form>}
            </section>
            <section className="l3-section"><h3>{selected.status === "verified" ? "작업 다시 열기" : "완료 확인"}</h3>
              <p className="l3-help">에이전트의 응답 종료는 작업 완료가 아닙니다. 결과를 확인한 내용을 기록하세요.</p>
              <form className="l3-form l3-compact" key={`${selected.id}-${selected.status}`} onSubmit={event => submit(event, selected.status === "verified" ? "reopen" : "verify", { id: selected.id, ...(selected.status === "open" ? { confirmed: true } : {}) })}>
                <label>{selected.status === "verified" ? "다시 여는 이유" : "검증 내용"}<textarea name="note" required maxLength={4000} rows={3} placeholder={selected.status === "verified" ? "남은 작업이나 재검증 이유" : "무엇을 확인했고 어떤 결과를 얻었나요?"} /></label>
                {selected.status === "open" && <label className="l3-check"><input type="checkbox" required />연결된 결과물을 직접 확인했습니다.</label>}
                <button className="l3-primary" disabled={busy || (selected.status === "open" && !selected.artifacts.length)}>{selected.status === "verified" ? "다시 열기" : "검증 완료로 기록"}</button>
                {selected.status === "open" && !selected.artifacts.length && <p className="l3-help">완료하려면 결과물을 먼저 연결하세요.</p>}
              </form>
            </section>
            <section className="l3-section"><h3>진행 기록</h3><ol className="l3-timeline">{selected.history.map((item, index) => <li key={index}><strong>{labels[item.kind] ?? item.kind}</strong><time>{date(item.created_at)}</time>{item.note && <p>{item.note}</p>}</li>)}</ol></section>
          </> : <div className="l3-empty l3-detail-empty"><h2>작업을 선택하세요</h2><p>실행과 결과물을 연결하고 완료 근거를 남길 수 있습니다.</p></div>}
        </section>
      </div>}
    </div>
  </LocalShell>;
}
