'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ManagedProject, ProjectOverview } from '@claude-monitor/core';
import { localFetch, LocalApiError } from '../../lib/local-client';

const REASON: Record<string, string> = { same_label: '같은 이름', conductor_repo: 'Conductor 저장소 이름', parent_folder: '상위 폴더' };
const ERROR: Record<string, string> = { project_not_empty: '작업 공간이 있는 프로젝트는 보관할 수 없습니다. 먼저 합치거나 연결을 옮기세요.', invalid_label: '이름은 1~120자로 입력하세요.', invalid_merge: '같은 프로젝트나 보관된 프로젝트로는 합칠 수 없습니다.', invalid_candidate: '후보가 이미 바뀌었습니다. 새로 불러온 목록을 확인하세요.' };
const repo = (p: ManagedProject) => p.repositoryIdentities[0]?.replace(/^git:/, '') ?? null;
/** Same names are common here, so every choice also shows the repository or folder count. */
const nameOf = (p: ManagedProject) => `${p.label} · ${repo(p) ?? `작업 공간 ${p.workspaceCount}`}`;
type Pending = { sourceId: string; targetId: string } | null;
/** Linked folders: the most used one, the rest on demand. Empty projects have none. */
function Paths({ paths }: { paths: string[] }) {
  if (!paths.length) return <small className="local-workspace-path">연결된 폴더 없음</small>;
  const [first, ...rest] = paths;
  return <>
    <small className="local-workspace-path">{first}</small>
    {rest.length > 0 && <details className="local-manage-paths"><summary>외 {rest.length}개 폴더</summary>{rest.map(path => <small key={path} className="local-workspace-path">{path}</small>)}</details>}
  </>;
}

/** Merge, rename and archive ledger projects; the live monitor groups by the same mapping. */
export function ProjectManager({ revision, onChanged }: { revision: number; onChanged: () => void }) {
  const [data, setData] = useState<ProjectOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const controller = new AbortController();
    localFetch<ProjectOverview>('/api/projects/manage', undefined, controller.signal).then(setData).catch(() => { if (!controller.signal.aborted) setError('load_failed'); });
    return () => controller.abort();
  }, [revision]);
  const byId = useMemo(() => new Map([...(data?.projects ?? []), ...(data?.archived ?? [])].map(p => [p.id, p])), [data]);
  const empty = data?.projects.filter(p => p.workspaceCount === 0) ?? [];
  const listed = onlyEmpty ? empty : data?.projects ?? [];

  async function act(action: string, body: Record<string, unknown>) {
    setBusy(true); setError('');
    try { setData(await localFetch<ProjectOverview>('/api/projects/manage', { action, ...body })); setPending(null); setRenaming(null); setSelected(new Set()); onChanged(); }
    catch (e) { setError(e instanceof LocalApiError ? e.code : 'request_failed'); }
    finally { setBusy(false); }
  }
  const confirmRow = (sourceId: string) => {
    if (pending?.sourceId !== sourceId) return null;
    const source = byId.get(sourceId), target = byId.get(pending.targetId);
    if (!source || !target) return null;
    return <div className="local-manage-confirm" role="alert">
      <p>‘{source.label}’의 작업 공간 {source.workspaceCount}개{source.workItemCount ? `와 작업 ${source.workItemCount}개` : ''}를 ‘{nameOf(target)}’로 옮기고 ‘{source.label}’은 보관합니다. 사용량 합계는 바뀌지 않고, 보관된 프로젝트는 아래에서 복원할 수 있습니다(옮긴 작업 공간은 작업 공간 연결에서 다시 옮깁니다).</p>
      <button className="local-button" disabled={busy} onClick={() => void act('merge', pending)}>합치기 확인</button>
      <button className="local-link" onClick={() => setPending(null)}>취소</button>
    </div>;
  };

  if (!data) return <section className="local-manage"><div className="local-section-heading"><h2>프로젝트 관리</h2></div>{error ? <div className="local-notice error" role="alert">프로젝트 목록을 불러오지 못했습니다. <code>{error}</code></div> : <p className="local-subtitle">불러오는 중…</p>}</section>;
  return <section className="local-manage" aria-label="프로젝트 관리">
    <div className="local-section-heading"><h2>프로젝트 관리</h2><small>같은 저장소는 자동으로 합쳐집니다. 저장소를 알 수 없는 프로젝트만 합치기를 제안하며, 확인해야 합쳐집니다. 실시간 모니터 묶음에도 같이 적용됩니다.</small></div>
    {error && <div className="local-notice error" role="alert">{ERROR[error] ?? '요청을 처리하지 못했습니다.'} <code>{error}</code></div>}

    <h3>합치기 후보 <small>{data.candidates.length}개</small></h3>
    {!data.candidates.length ? <p className="local-subtitle">제안할 후보가 없습니다.</p> : <ul className="local-manage-list">{data.candidates.map(c => {
      const source = byId.get(c.sourceId); if (!source) return null;
      const targetId = targets[c.key] ?? c.targetIds[0]!;
      return <li key={c.key}>
        <div className="local-manage-row">
          <div className="local-manage-name">{source.label}<small>작업 공간 {source.workspaceCount} · 요청 {source.requestCount.toLocaleString('ko-KR')} · {REASON[c.reason]}</small><Paths paths={source.workspacePaths} /></div>
          <span aria-hidden="true">→</span>
          {c.targetIds.length > 1
            ? <select aria-label={`${source.label} 합칠 대상`} value={targetId} onChange={e => setTargets({ ...targets, [c.key]: e.target.value })}>{c.targetIds.map(id => byId.get(id) && <option key={id} value={id}>{nameOf(byId.get(id)!)}</option>)}</select>
            : <div className="local-manage-name">{byId.get(targetId) ? nameOf(byId.get(targetId)!) : targetId}{byId.get(targetId) && !repo(byId.get(targetId)!) && <Paths paths={byId.get(targetId)!.workspacePaths} />}</div>}
          <span className="local-manage-actions"><button className="local-button" disabled={busy} onClick={() => setPending({ sourceId: c.sourceId, targetId })}>합치기</button><button className="local-link" disabled={busy} onClick={() => void act('dismiss', { key: c.key })}>무시</button></span>
        </div>
        {confirmRow(c.sourceId)}
      </li>;
    })}</ul>}

    <div className="local-section-heading"><h3>프로젝트 <small>{data.projects.length}개</small></h3>
      <label className="local-manage-toggle"><input type="checkbox" checked={onlyEmpty} onChange={e => { setOnlyEmpty(e.target.checked); setSelected(new Set()); }} /> 빈 프로젝트만 ({empty.length})</label></div>
    {onlyEmpty && <div className="local-manage-row"><button className="local-link" onClick={() => setSelected(new Set(selected.size === empty.length ? [] : empty.map(p => p.id)))}>{selected.size === empty.length && empty.length ? '선택 해제' : '모두 선택'}</button><button className="local-button" disabled={busy || !selected.size} onClick={() => void act('archive', { projectIds: [...selected], archived: true })}>선택한 {selected.size}개 보관</button><small>보관하면 선택 목록에서 숨겨지고 언제든 복원할 수 있습니다.</small></div>}
    <ul className="local-manage-list">{listed.map(p => <li key={p.id}>
      <div className="local-manage-row">
        {onlyEmpty && <input type="checkbox" aria-label={`${p.label} 선택`} checked={selected.has(p.id)} onChange={e => { const next = new Set(selected); if (e.target.checked) next.add(p.id); else next.delete(p.id); setSelected(next); }} />}
        {renaming?.id === p.id
          ? <form className="local-manage-rename" onSubmit={e => { e.preventDefault(); void act('rename', { projectId: p.id, label: renaming.label }); }}><input aria-label="새 이름" value={renaming.label} maxLength={120} onChange={e => setRenaming({ id: p.id, label: e.target.value })} autoFocus /><button className="local-button" disabled={busy}>저장</button><button type="button" className="local-link" onClick={() => setRenaming(null)}>취소</button></form>
          : <div className="local-manage-name">{p.label}<small>{repo(p) ?? '저장소 모름'} · 작업 공간 {p.workspaceCount} · 요청 {p.requestCount.toLocaleString('ko-KR')}{p.workItemCount ? ` · 작업 ${p.workItemCount}` : ''}</small><Paths paths={p.workspacePaths} /></div>}
        {renaming?.id !== p.id && <span className="local-manage-actions">
          <button className="local-link" onClick={() => setRenaming({ id: p.id, label: p.label })}>이름 바꾸기</button>
          {p.workspaceCount > 0 && <select aria-label={`${p.label} 다른 프로젝트로 합치기`} value="" onChange={e => e.target.value && setPending({ sourceId: p.id, targetId: e.target.value })}><option value="">다른 프로젝트로 합치기…</option>{data.projects.filter(t => t.id !== p.id).map(t => <option key={t.id} value={t.id}>{nameOf(t)}</option>)}</select>}
        </span>}
      </div>
      {confirmRow(p.id)}
    </li>)}</ul>

    <details><summary>보관된 프로젝트 {data.archived.length}개</summary>
      <ul className="local-manage-list">{data.archived.map(p => <li key={p.id}><div className="local-manage-row"><div className="local-manage-name">{p.label}<small>{p.archivedAt ? new Date(p.archivedAt).toLocaleString('ko-KR') : ''} 보관</small><Paths paths={p.workspacePaths} /></div><span className="local-manage-actions"><button className="local-link" disabled={busy} onClick={() => void act('archive', { projectIds: [p.id], archived: false })}>복원</button></span></div></li>)}</ul>
    </details>
  </section>;
}
