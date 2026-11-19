import type Database from 'better-sqlite3';
import type { CandidateReason, ManagedProject, MergeCandidate, MonitorProject, MonitorProjectMap, ProjectOverview } from '@claude-monitor/core';
import { CollectorError } from './config.js';

/**
 * Project housekeeping on /projects, applied to both the ledger reports and the live monitor.
 * Same repository → one project automatically (project-discovery); without a known repository,
 * merges are only suggested here and happen when the person confirms them.
 */

const CONDUCTOR = /\/conductor\/workspaces\/([^/]+)\/[^/]+(?:\/|$)/;
const LABEL_MAX = 120;
const norm = (label: string) => label.trim().toLowerCase();
const repoName = (identity: string) => identity.slice(identity.lastIndexOf('/') + 1).toLowerCase();

function projects(db: Database.Database): ManagedProject[] {
  const rows = db.prepare(`SELECT p.id,p.label,p.archived_at,
      (SELECT count(*) FROM workspace w WHERE w.project_id=p.id) AS workspaces,
      (SELECT count(*) FROM usage_record u JOIN workspace w ON w.id=u.workspace_id WHERE w.project_id=p.id AND u.validity='valid') AS requests,
      (SELECT count(*) FROM work_item i WHERE i.project_id=p.id) AS work_items,
      (SELECT group_concat(DISTINCT w.repository_identity) FROM workspace w WHERE w.project_id=p.id AND w.repository_identity IS NOT NULL) AS identities
    FROM project p ORDER BY p.label COLLATE NOCASE,p.id`).all() as {id:string;label:string;archived_at:bigint|null;workspaces:bigint;requests:bigint;work_items:bigint;identities:string|null}[];
  // Folder paths grouped here, not with group_concat: a path may contain the separator.
  const folders = db.prepare(`SELECT w.project_id,w.canonical_cwd,count(u.id) AS requests FROM workspace w
      LEFT JOIN usage_record u ON u.workspace_id=w.id AND u.validity='valid' WHERE w.project_id IS NOT NULL GROUP BY w.id`).all() as {project_id:string;canonical_cwd:string;requests:bigint}[];
  const pathsOf = new Map<string, {path:string;requests:number}[]>();
  for (const f of folders) pathsOf.set(f.project_id, [...(pathsOf.get(f.project_id) ?? []), { path: f.canonical_cwd, requests: Number(f.requests) }]);
  const ordered = (id: string) => (pathsOf.get(id) ?? []).sort((a, b) => b.requests - a.requests || a.path.localeCompare(b.path)).map(f => f.path);
  return rows.map(r => ({ id: r.id, label: r.label, archivedAt: r.archived_at === null ? null : Number(r.archived_at),
    workspaceCount: Number(r.workspaces), requestCount: Number(r.requests), workItemCount: Number(r.work_items),
    repositoryIdentities: r.identities ? r.identities.split(',').sort() : [], workspacePaths: ordered(r.id) }));
}

/** Suggestions only for projects whose repository is unknown; two different known repositories are never paired. */
export function mergeCandidates(db: Database.Database, list = projects(db)): MergeCandidate[] {
  const active = list.filter(p => p.archivedAt === null && p.workspaceCount > 0);
  const byId = new Map(active.map(p => [p.id, p]));
  const dismissed = new Set((db.prepare('SELECT candidate_key FROM project_candidate_dismissal').all() as {candidate_key:string}[]).map(r => r.candidate_key));
  const workspaces = db.prepare('SELECT canonical_cwd,project_id FROM workspace WHERE project_id IS NOT NULL').all() as {canonical_cwd:string;project_id:string}[];
  const cwdsOf = new Map<string, string[]>();
  for (const w of workspaces) if (byId.has(w.project_id)) cwdsOf.set(w.project_id, [...(cwdsOf.get(w.project_id) ?? []), w.canonical_cwd]);
  const bigger = (a: ManagedProject, b: ManagedProject) => b.requestCount - a.requestCount || b.workspaceCount - a.workspaceCount || a.id.localeCompare(b.id);
  const out: MergeCandidate[] = [], suggested = new Set<string>();
  const add = (reason: CandidateReason, source: ManagedProject, targets: ManagedProject[]) => {
    const targetIds = targets.filter(t => t.id !== source.id).sort(bigger).map(t => t.id);
    const key = `${source.id}>${targetIds.join('|')}`;
    if (!targetIds.length || suggested.has(source.id) || dismissed.has(key)) return;
    suggested.add(source.id); out.push({ key, reason, sourceId: source.id, targetIds });
  };
  const unknownRepo = active.filter(p => p.repositoryIdentities.length === 0);
  const byLabel = new Map<string, ManagedProject[]>();
  for (const p of active) byLabel.set(norm(p.label), [...(byLabel.get(norm(p.label)) ?? []), p]);
  // 1. Same name as a project whose repository is known.
  for (const group of byLabel.values()) {
    const known = group.filter(p => p.repositoryIdentities.length > 0);
    if (known.length) for (const source of group) if (!source.repositoryIdentities.length) add('same_label', source, known);
  }
  // 2. Conductor worktree folders (often deleted, so git cannot answer) named after a known repository.
  for (const source of unknownRepo) {
    const repos = new Set((cwdsOf.get(source.id) ?? []).map(cwd => cwd.match(CONDUCTOR)?.[1]?.toLowerCase() ?? null));
    if (repos.size !== 1 || repos.has(null)) continue;
    const repo = [...repos][0]!;
    const targets = active.filter(p => p.repositoryIdentities.some(i => repoName(i) === repo));
    if (targets.length) add('conductor_repo', source, targets);
  }
  // 3. Every folder lies inside folders that already belong to one other project.
  for (const source of unknownRepo) {
    const owners = new Set<string>();
    for (const cwd of cwdsOf.get(source.id) ?? []) {
      let owner: string|null = null, depth = -1;
      for (const w of workspaces) if (w.project_id !== source.id && cwd.startsWith(w.canonical_cwd + '/') && w.canonical_cwd.length > depth) { owner = w.project_id; depth = w.canonical_cwd.length; }
      owners.add(owner ?? '');
    }
    if (owners.size === 1 && !owners.has('') && byId.has([...owners][0]!)) add('parent_folder', source, [byId.get([...owners][0]!)!]);
  }
  // 4. Same name with no known repository anywhere: into the busiest of them.
  for (const group of byLabel.values()) {
    const orphans = group.filter(p => !p.repositoryIdentities.length && !suggested.has(p.id)).sort(bigger);
    if (group.every(p => !p.repositoryIdentities.length) && orphans.length > 1) for (const source of orphans.slice(1)) add('same_label', source, [orphans[0]!]);
  }
  return out;
}

export function projectOverview(db: Database.Database): ProjectOverview {
  const list = projects(db);
  return { projects: list.filter(p => p.archivedAt === null), archived: list.filter(p => p.archivedAt !== null), candidates: mergeCandidates(db, list) };
}

function requireProject(db: Database.Database, id: unknown): { id: string; archived_at: bigint|null } {
  if (typeof id !== 'string' || !id || id.length > 250) throw new CollectorError('invalid_project');
  const row = db.prepare('SELECT id,archived_at FROM project WHERE id=?').get(id) as { id: string; archived_at: bigint|null }|undefined;
  if (!row) throw new CollectorError('project_not_found');
  return row;
}
const input = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;

export function renameProject(db: Database.Database, payload: unknown) {
  const { projectId, label } = input(payload);
  return db.transaction(() => {
    requireProject(db, projectId);
    if (typeof label !== 'string' || !label.trim() || label.trim().length > LABEL_MAX) throw new CollectorError('invalid_label');
    db.prepare('UPDATE project SET label=? WHERE id=?').run(label.trim(), projectId);
    return projectOverview(db);
  })();
}

/** Moves every folder and work item of the source into the target; the emptied source is archived, never deleted. */
export function mergeProject(db: Database.Database, payload: unknown, now = Date.now()) {
  const { sourceId, targetId } = input(payload);
  return db.transaction(() => {
    requireProject(db, sourceId);
    const target = requireProject(db, targetId);
    if (sourceId === targetId || target.archived_at !== null) throw new CollectorError('invalid_merge');
    // Manual from here on: a later git lookup must not split what the person joined.
    db.prepare("UPDATE workspace SET project_id=?,mapping_source='manual' WHERE project_id=?").run(targetId, sourceId);
    db.prepare('UPDATE work_item SET project_id=? WHERE project_id=?').run(targetId, sourceId);
    db.prepare('UPDATE project SET archived_at=? WHERE id=?').run(now, sourceId);
    db.prepare('UPDATE metadata SET mapping_revision=mapping_revision+1 WHERE id=1').run();
    return projectOverview(db);
  })();
}

/** Archive hides empty projects from lists; restore brings them back. Projects with folders stay visible. */
export function archiveProjects(db: Database.Database, payload: unknown, now = Date.now()) {
  const { projectIds, archived } = input(payload);
  if (!Array.isArray(projectIds) || !projectIds.length || projectIds.length > 500 || typeof archived !== 'boolean') throw new CollectorError('invalid_project');
  return db.transaction(() => {
    for (const id of projectIds) {
      requireProject(db, id);
      if (archived && db.prepare('SELECT 1 FROM workspace WHERE project_id=? LIMIT 1').get(id)) throw new CollectorError('project_not_empty');
      db.prepare('UPDATE project SET archived_at=? WHERE id=?').run(archived ? now : null, id);
    }
    return projectOverview(db);
  })();
}

export function dismissCandidate(db: Database.Database, payload: unknown, now = Date.now()) {
  const { key } = input(payload);
  return db.transaction(() => {
    if (typeof key !== 'string' || !mergeCandidates(db).some(c => c.key === key)) throw new CollectorError('invalid_candidate');
    db.prepare('INSERT OR IGNORE INTO project_candidate_dismissal VALUES(?,?)').run(key, now);
    return projectOverview(db);
  })();
}

/**
 * Live-monitor grouping from the ledger mapping. A project reached through a repository keeps the
 * monitor's own `git:host/path` key (bookmarks and filters stay valid); others get `project:<id>`.
 */
export function monitorProjectMap(db: Database.Database): MonitorProjectMap {
  const rows = db.prepare(`SELECT w.canonical_cwd,w.repository_identity,p.id,p.label FROM workspace w JOIN project p ON p.id=w.project_id ORDER BY w.rowid`).all() as {canonical_cwd:string;repository_identity:string|null;id:string;label:string}[];
  const identityProject = new Map<string, string>();
  for (const r of rows) if (r.repository_identity && !identityProject.has(r.repository_identity)) identityProject.set(r.repository_identity, r.id);
  const projectKey = new Map<string, string>();
  for (const [identity, id] of identityProject) if (!projectKey.has(id)) projectKey.set(id, identity);
  const labels = new Map(rows.map(r => [r.id, r.label]));
  const entry = (id: string): MonitorProject => ({ key: projectKey.get(id) ?? `project:${id}`, label: labels.get(id)! });
  const workspaces: Record<string, MonitorProject> = {}, identities: Record<string, MonitorProject> = {};
  for (const r of rows) workspaces[r.canonical_cwd] = entry(r.id);
  for (const [identity, id] of identityProject) identities[identity] = entry(id);
  return { workspaces, identities };
}
