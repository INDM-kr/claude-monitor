import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { basename, dirname, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { Storage } from './storage.js';
import { projectRules, type ProjectRules } from './config.js';
import { canonicalIdentity, sshHostName, type HostLookup } from './repository-host.js';
const exec=promisify(execFile);
export const PROJECT_DISCOVERY={timeoutMs:1000,maxBuffer:16384} as const;
export function repositoryIdentity(remote:string):string|null {
  const value=remote.trim();
  try {
    let host:string,path:string;
    if(/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      const url=new URL(value);if(!['https:','http:','ssh:','git:'].includes(url.protocol))return null;
      host=url.hostname;path=url.pathname;
    } else {
      const match=value.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);if(!match)return null;
      host=match[1]!;path=match[2]!.split(/[?#]/)[0]!;
    }
    path=path.replace(/^\/+|\/+$/g,'').replace(/\.git$/i,'');
    if(!host||!path||/[\r\n\u0000]/.test(host+path))return null;
    return `git:${host.toLowerCase()}/${path}`;
  } catch{return null;}
}
export async function resolveRepository(cwd:string):Promise<string|null> {
  try {const {stdout}=await exec('git',['-C',cwd,'config','--local','--get','remote.origin.url'],{timeout:PROJECT_DISCOVERY.timeoutMs,maxBuffer:PROJECT_DISCOVERY.maxBuffer});return repositoryIdentity(stdout);}catch{return null;}
}

const repositoryName=(identity:string)=>identity.slice(identity.lastIndexOf('/')+1).toLowerCase();
const inside=(path:string,root:string)=>path.startsWith(root+sep);
const bumpRevision=(db:Database.Database)=>db.prepare('UPDATE metadata SET mapping_revision=mapping_revision+1 WHERE id=1').run();

/** An automatic project left with no folder and no work item is archived (restorable on /projects), never deleted. */
function archiveIfEmpty(db:Database.Database,projectId:string|null,now:number){
  if(!projectId)return;
  if(db.prepare('SELECT 1 FROM workspace WHERE project_id=? LIMIT 1').get(projectId))return;
  if(db.prepare('SELECT 1 FROM work_item WHERE project_id=? LIMIT 1').get(projectId))return;
  db.prepare('UPDATE project SET archived_at=? WHERE id=? AND archived_at IS NULL').run(now,projectId);
}

/** Folders that hold many projects (home, its direct children, tool and scratch roots) never act as a parent project. */
function isContainer(path:string,rules:ProjectRules,home:string){
  if(path===home||inside(home,path)||dirname(path)===home)return true;
  return [...rules.worktreeRoots,...rules.buckets.flatMap(b=>b.roots)].some(root=>path===root||inside(root,path));
}

/** Project for a folder whose remote is unknown; null keeps the folder's own project. */
function ruleTarget(db:Database.Database,cwd:string,rules:ProjectRules,home:string):string|null {
  // 1. A worktree tool path names its repository: join the one project whose remote has that name.
  for(const root of rules.worktreeRoots){
    if(!inside(cwd,root))continue;
    const repository=cwd.slice(root.length+1).split(sep)[0]!.toLowerCase();
    const owners=new Set((db.prepare(`SELECT DISTINCT w.project_id,w.repository_identity FROM workspace w JOIN project p ON p.id=w.project_id
      WHERE w.repository_identity IS NOT NULL AND p.archived_at IS NULL`).all() as {project_id:string;repository_identity:string}[])
      .filter(r=>repositoryName(r.repository_identity)===repository).map(r=>r.project_id));
    if(owners.size===1)return [...owners][0]!;
  }
  // 2. The nearest folder above it that already belongs to a project.
  const parents=(db.prepare(`SELECT w.canonical_cwd,w.project_id FROM workspace w JOIN project p ON p.id=w.project_id
    WHERE p.archived_at IS NULL AND length(w.canonical_cwd)<length(?) AND substr(?,1,length(w.canonical_cwd)+1)=w.canonical_cwd||?
    ORDER BY length(w.canonical_cwd) DESC`).all(cwd,cwd,sep) as {canonical_cwd:string;project_id:string}[]).filter(p=>!isContainer(p.canonical_cwd,rules,home));
  if(parents[0])return parents[0].project_id;
  // 3. Scratch folders share one project per kind.
  const bucket=rules.buckets.find(b=>b.roots.some(root=>inside(cwd,root)));
  if(bucket){
    const id=`bucket:${bucket.id}`;
    db.prepare('INSERT OR IGNORE INTO project VALUES(?,?,NULL)').run(id,bucket.label);
    db.prepare('UPDATE project SET archived_at=NULL WHERE id=?').run(id);
    return id;
  }
  return null;
}

/** The same repository reached through an SSH alias and through its real host becomes one identity, and one project. */
async function canonicalizeIdentities(store:Storage,hostName:HostLookup,now:number){
  const identities=(store.db.prepare('SELECT DISTINCT repository_identity FROM workspace WHERE repository_identity IS NOT NULL').all() as {repository_identity:string}[]).map(r=>r.repository_identity);
  for(const identity of identities){
    const next=await canonicalIdentity(identity,hostName);if(next===identity)continue;
    store.transaction(db=>{
      db.prepare('UPDATE workspace SET repository_identity=? WHERE repository_identity=?').run(next,identity);
      const owner=db.prepare("SELECT project_id FROM workspace WHERE repository_identity=? AND mapping_source='automatic' AND project_id IS NOT NULL ORDER BY rowid LIMIT 1").get(next) as {project_id:string}|undefined;
      if(owner){
        const moved=db.prepare("SELECT DISTINCT project_id FROM workspace WHERE repository_identity=? AND mapping_source='automatic' AND project_id<>?").all(next,owner.project_id) as {project_id:string}[];
        db.prepare("UPDATE workspace SET project_id=? WHERE repository_identity=? AND mapping_source='automatic'").run(owner.project_id,next);
        for(const m of moved)archiveIfEmpty(db,m.project_id,now);
      }
      bumpRevision(db);
    });
  }
}

export interface DiscoveryOptions { rules?:ProjectRules; hostName?:HostLookup; home?:string; now?:()=>number }

/**
 * Groups automatic folders: the git remote decides first (SSH aliases resolved to the real host); folders without
 * a remote follow the project rules. Manual mappings are never touched. Each folder is checked once per process.
 */
export async function discoverProjects(store:Storage,checked:Set<string>,resolveRemote=resolveRepository,options:DiscoveryOptions={}):Promise<void> {
  const rules=options.rules??projectRules(),hostName=options.hostName??sshHostName,home=options.home??homedir(),now=options.now??Date.now;
  await canonicalizeIdentities(store,hostName,now());
  const rows=(store.db.prepare("SELECT id,canonical_cwd FROM workspace WHERE repository_identity IS NULL AND mapping_source='automatic' ORDER BY rowid").all() as {id:string;canonical_cwd:string}[])
    .filter(row=>!checked.has(row.id))
    // Parents first, so a subfolder can follow the project its parent was just given.
    .sort((a,b)=>a.canonical_cwd.length-b.canonical_cwd.length);
  for(const row of rows){checked.add(row.id);
    const remote=await resolveRemote(row.canonical_cwd);
    const identity=remote?await canonicalIdentity(remote,hostName):null;
    store.transaction(db=>{
      // Manual mapping always wins, including a user change while git was being read.
      const workspace=db.prepare("SELECT project_id FROM workspace WHERE id=? AND mapping_source='automatic'").get(row.id) as {project_id:string|null}|undefined;if(!workspace)return;
      if(identity){
        const candidate=db.prepare("SELECT project_id FROM workspace WHERE repository_identity=? AND mapping_source='automatic' AND project_id IS NOT NULL ORDER BY rowid LIMIT 1").get(identity) as {project_id:string}|undefined;
        db.prepare('UPDATE workspace SET repository_identity=?,project_id=? WHERE id=?').run(identity,candidate?.project_id??workspace.project_id,row.id);
        if(!candidate&&workspace.project_id)db.prepare('UPDATE project SET label=? WHERE id=? AND label=?').run(basename(identity),workspace.project_id,basename(row.canonical_cwd)||'Project');
        if(candidate&&candidate.project_id!==workspace.project_id)archiveIfEmpty(db,workspace.project_id,now());
        bumpRevision(db);
        return;
      }
      const target=ruleTarget(db,row.canonical_cwd,rules,home);
      if(!target||target===workspace.project_id)return;
      db.prepare('UPDATE workspace SET project_id=? WHERE id=?').run(target,row.id);
      archiveIfEmpty(db,workspace.project_id,now());
      bumpRevision(db);
    });
  }
}
