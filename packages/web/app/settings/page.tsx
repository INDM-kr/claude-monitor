"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LocalShell } from "../_components/LocalShell";
import { LocalApiError, localFetch, setLocalBearer } from "../../lib/local-client";
import "../work/work.css";

type Settings = { retention_days: string | null; auto_delete: string; metadata: { schema_version: string; timezone: string; parser_version: string }; exclusions: { from_at: string; to_at: string; created_at: string }[] };
type Diagnostics = { diagnostics: { code: string; count: string; last_seen_at: string }[]; sources: number; requests: number; checkpointUpdatedAt: string | null; metadata: Settings["metadata"] };
type Collector = { state: string; ingestionState: string; diagnostic: string | null };
type Preview = { before: number; requests: number; tokens: string; fingerprint: string };
const formatDate = (value: string | null) => value === null ? "아직 관측 없음" : new Date(Number(value)).toLocaleString("ko-KR");

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null), [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null), [collector, setCollector] = useState<Collector | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [auth, setAuth] = useState(false), [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null), [cutoff, setCutoff] = useState("");
  const readVersion = useRef(0);
  function fail(failure: unknown) {
    const code = failure instanceof LocalApiError ? failure.code : "request_failed";
    setAuth(code === "unauthorized");
    setError(code === "unauthorized" ? "접근 토큰을 입력해 주세요." : code === "purge_preview_changed" ? "미리보기 이후 이력이 바뀌었습니다. 삭제 범위를 다시 확인하세요." : code === "collector_unavailable" ? "수집기가 응답하지 않습니다. 아래 시작·복구 안내를 확인하세요." : "입력을 확인하고 다시 시도해 주세요.");
  }
  async function reload(signal?: AbortSignal) {
    const version = ++readVersion.current;
    const results = await Promise.allSettled([localFetch<Settings>("/api/settings", undefined, signal), localFetch<Diagnostics>("/api/maintenance", undefined, signal), localFetch<Collector>("/api/collector", undefined, signal)]);
    if (signal?.aborted || version !== readVersion.current) return;
    const [config, diag, status] = results;
    if (config.status === "fulfilled") setSettings(config.value);
    if (diag.status === "fulfilled") setDiagnostics(diag.value);
    if (status.status === "fulfilled") setCollector(status.value);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") fail(failure.reason); else { setError(null); setAuth(false); }
  }
  useEffect(() => { const abort = new AbortController(); void reload(abort.signal); return () => abort.abort(); }, []);
  async function action(path: string, payload: unknown, done?: (result: any) => void) {
    setBusy(true); setError(null); setMessage("");
    try { const result = await localFetch(path, payload); done?.(result); await reload(); }
    catch (failure) { fail(failure); } finally { setBusy(false); }
  }
  function retention(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const value = String(new FormData(event.currentTarget).get("days"));
    void action("/api/settings", { action: "update", retentionDays: value ? Number(value) : null }, () => setMessage("보관 검토 주기를 저장했습니다. 자동으로 삭제하지 않습니다."));
  }
  function download() {
    if (!diagnostics) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...diagnostics, generatedAt: new Date().toISOString() }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "claude-monitor-diagnostics.json"; anchor.click(); URL.revokeObjectURL(url);
  }
  return <LocalShell active="settings"><div className="l3-page l3-settings">
    <header className="l3-heading"><div><p className="l3-eyebrow">LOCAL WORKSPACE</p><h1>설정과 진단</h1><p>수집 상태를 확인하고 이력을 안전하게 보관하세요.</p></div><button disabled={busy} onClick={() => void reload()}>새로고침</button></header>
    {error && <div className="l3-notice l3-error" role="alert">{error}</div>}
    {auth && <form className="l3-inline" onSubmit={event => { event.preventDefault(); setLocalBearer(String(new FormData(event.currentTarget).get("token"))); void reload(); }}><label>로컬 접근 토큰<input name="token" type="password" autoComplete="off" required /></label><button className="l3-primary">연결</button><small>현재 페이지 메모리에만 유지합니다.</small></form>}
    <p className="l3-feedback" role="status">{busy ? "처리 중…" : message}</p>
    <section className="l3-settings-section"><div><h2>수집 상태</h2><p>로그 원문이나 인증 정보는 진단 파일에 포함하지 않습니다.</p></div><div>
      <dl className="l3-definition"><div><dt>수집기</dt><dd>{collector?.state ?? "확인 중"}</dd></div><div><dt>가져오기</dt><dd>{collector?.ingestionState ?? "미확인"}</dd></div><div><dt>마지막 체크포인트</dt><dd>{formatDate(diagnostics?.checkpointUpdatedAt ?? null)}</dd></div><div><dt>관측 소스 / 요청</dt><dd>{diagnostics ? `${diagnostics.sources.toLocaleString()}개 / ${diagnostics.requests.toLocaleString()}건` : "미확인"}</dd></div><div><dt>시간대</dt><dd>{settings?.metadata.timezone ?? "미확인"}</dd></div><div><dt>파서 / 저장소 버전</dt><dd>{settings ? `${settings.metadata.parser_version} / ${settings.metadata.schema_version}` : "미확인"}</dd></div></dl>
      {collector?.diagnostic && <p className="l3-notice">진단 코드: {collector.diagnostic}</p>}
      {diagnostics && diagnostics.diagnostics.length > 0 ? <div className="l3-table-scroll"><table className="l3-diagnostics"><thead><tr><th>진단 코드</th><th>횟수</th><th>최근 관측</th></tr></thead><tbody>{diagnostics.diagnostics.map(item => <tr key={item.code}><td><code>{item.code}</code></td><td>{BigInt(item.count).toLocaleString()}</td><td>{formatDate(item.last_seen_at)}</td></tr>)}</tbody></table></div> : diagnostics && <p className="l3-help">기록된 수집 진단이 없습니다. 모든 소스의 호환성을 보증하는 의미는 아닙니다.</p>}
      <button className="l3-download" disabled={!diagnostics} onClick={download}>진단 파일 내려받기</button>
    </div></section>
    <section className="l3-settings-section"><div><h2>백업과 복구</h2><p>작업·검증·프로젝트 매핑을 포함한 로컬 이력의 일관된 복사본을 만듭니다.</p></div><div>
      <button className="l3-primary" disabled={busy || !settings} onClick={() => void action("/api/maintenance", { action: "backup" }, result => setMessage(`백업을 만들었습니다: ${result.backupName} · 데이터 디렉터리의 backups 폴더에서 확인하세요.`))}>지금 백업</button>
      <p className="l3-help" style={{ marginTop: 12 }}>백업은 데이터 디렉터리의 backups 폴더에 저장됩니다. 원본 대화 로그는 백업에 포함되지 않습니다.</p>
      <details><summary>업데이트·복구 절차</summary><ol><li>업데이트 전에 위 버튼으로 백업하고 서버를 종료합니다.</li><li>Node 24.11 이상 24.x, pnpm 10.x를 확인합니다.</li><li>프로젝트 폴더에서 의존성과 빌드를 갱신한 뒤 시작합니다.</li></ol><pre>pnpm install --frozen-lockfile{"\n"}pnpm build{"\n"}pnpm start</pre><p>업데이트 시 필요한 저장소 변경은 이전 버전 백업을 만든 뒤 적용됩니다. 복구는 서버를 종료하고 백업을 <strong>새 데이터 디렉터리</strong>로 복원한 뒤 CM_DATA_DIR을 바꿔 시작하세요. 사용 중인 usage.sqlite 파일만 덮어쓰지 마세요.</p><p style={{ marginTop: 10 }}>정확한 복원 명령: 저장소의 docs/specs/l1-01-storage-runtime.md 및 docs/specs/l3-local-release.md.</p></details>
    </div></section>
    <section className="l3-settings-section"><div><h2>보관과 삭제</h2><p>기본값은 무기한 보관입니다. 검토 주기를 저장해도 자동으로 삭제하지 않습니다.</p></div><div>
      <form onSubmit={retention} className="l3-inline" key={settings?.retention_days ?? "forever"}><label>보관 검토 주기 (일)<input name="days" type="number" min={1} max={3650} defaultValue={settings?.retention_days ?? ""} placeholder="무기한" /></label><button disabled={busy || !settings}>저장</button></form>
      <details><summary>기간 이력 삭제</summary><p>선택한 UTC 날짜 00:00 이전의 사용량을 로컬 원장에서 삭제합니다. 원본 로그·작업·결과물은 유지합니다. 삭제된 사용량은 작업 합계에서도 제외되고 재가져오기로 복원되지 않습니다. 복원하려면 삭제 전 백업을 사용하세요.</p>
        <form className="l3-inline" onSubmit={event => { event.preventDefault(); void action("/api/maintenance", { action: "preview", before: Date.parse(`${cutoff}T00:00:00.000Z`) }, setPreview); }}><label>이 날짜 이전 (UTC)<input type="date" value={cutoff} onChange={event => { setCutoff(event.target.value); setPreview(null); }} required /></label><button disabled={busy || !cutoff}>범위 미리보기</button></form>
        {preview && <div className="l3-preview"><strong>{preview.requests.toLocaleString()}개 요청 · {BigInt(preview.tokens).toLocaleString()} 토큰</strong><p>{new Date(preview.before).toISOString()} 이전 · 삭제 직전에 자동 백업합니다.</p>
          <form className="l3-form l3-compact" onSubmit={event => { event.preventDefault(); const confirmation = new FormData(event.currentTarget).get("confirmation"); void action("/api/maintenance", { action: "purge", before: preview.before, fingerprint: preview.fingerprint, confirmation }, result => { setPreview(null); setMessage(`기간 이력을 삭제했습니다. 복구 백업: ${result.backupName}`); }); }}><label>확인 문구 DELETE LOCAL HISTORY 입력<input name="confirmation" required pattern="DELETE LOCAL HISTORY" autoComplete="off" /></label><button className="l3-danger" disabled={busy}>백업 후 기간 이력 삭제</button></form></div>}
      </details>
      {settings && settings.exclusions.length > 0 && <p className="l3-help">재가져오기 제외 범위 {settings.exclusions.length}개 · 가장 최근 범위 끝: {new Date(Number(settings.exclusions[0]!.to_at)).toISOString()}</p>}
    </div></section>
    <section className="l3-settings-section"><div><h2>시작과 오류 해결</h2><p>이 앱은 한 대의 Mac에서 로컬 Claude Code·Codex 기록을 관측합니다.</p></div><div>
      <details open><summary>첫 실행</summary><p>지원 런타임으로 빌드한 뒤 pnpm start를 실행하고 표시된 로컬 주소를 여세요. 첫 가져오기가 끝나기 전에는 리포트가 일부 기록만 보여줄 수 있습니다.</p><p style={{ marginTop: 10 }}>기본 Claude Code 로그 폴더를 사용합니다. 다른 로그 폴더는 CLAUDE_PROJECTS_DIR(Codex는 CM_CODEX_DIR, 끄려면 CM_ENABLE_CODEX=0), 저장소 위치는 CM_DATA_DIR로 지정한 뒤 앱을 재시작하세요. 웹 API로 임의 파일 경로를 읽지 않습니다.</p></details>
      <details><summary>수집기가 시작되지 않을 때</summary><p>writer_busy는 같은 데이터 디렉터리를 사용하는 다른 앱이 실행 중임을 뜻합니다. 먼저 해당 앱을 정상 종료하세요. 권한 오류는 전용 데이터 디렉터리를 현재 사용자만 읽고 쓸 수 있는지 확인하세요. database_corrupt 또는 schema_too_new이면 현재 파일을 보존하고 백업·지원 버전을 확인하세요.</p></details>
      <details><summary>실행·대기 관측 연결</summary><p>Claude Code의 관찰용 hook을 연결하면 승인·입력 대기 신호를 받을 수 있습니다. 먼저 첫 명령으로 데이터 폴더에 본인만 읽을 수 있는 토큰 파일을 만들면 앱과 hook이 같은 값을 읽습니다(CM_RUNTIME_HOOK_TOKEN 환경변수가 있으면 그 값이 우선). 이어서 두 번째 명령이 출력한 설정을 기존 hook 설정과 병합하세요. 두 명령 모두 Claude 설정을 자동으로 수정하지 않고 토큰 값을 출력하지 않습니다.</p><pre>node scripts/runtime-hook-token.mjs{"\n"}node scripts/runtime-hook-settings.mjs</pre><p>연결 방법과 지원 범위: docs/specs/l2-runtime.md. hook이 없거나 관측이 오래되면 상태를 미확인으로 표시합니다.</p></details>
      <details><summary>실사용 검증</summary><p>브라우저 재열기, 앱 재시작, 절전·복귀, 중복 가져오기 후 합계·실행 상태·완료 이력이 이어지는지 확인합니다. 14일간의 실제 관측은 docs/specs/l3-observation-journal.md에 기록하며 아직 자동으로 통과 처리하지 않습니다.</p></details>
    </div></section>
  </div></LocalShell>;
}
