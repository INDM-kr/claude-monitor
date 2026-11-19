import {describe,expect,it,afterEach} from 'vitest';
import {rmSync} from 'node:fs';
import {testConfig} from './helpers.js';
import {openStorage} from '../storage.js';
import {repositoryIdentity,discoverProjects} from '../project-discovery.js';
const directories:string[]=[];
afterEach(()=>{for(const d of directories.splice(0))rmSync(d,{force:true,recursive:true});});
it('keeps only repository host/path, stripping user credentials/query/fragment and refusing local remotes',()=>{
 for(const value of ['https://user:private@example.test/owner/repo.git?secret=private#private','ssh://git@example.test/owner/repo.git','git@example.test:owner/repo.git?secret=private'])expect(repositoryIdentity(value)).toBe('git:example.test/owner/repo');
 for(const value of ['/private/repo','file:///private/repo','bad'])expect(repositoryIdentity(value)).toBeNull();
});
it('groups clones on one stable project while preserving manual mappings and stable IDs',async()=>{
 const c=testConfig();directories.push(c.dataDir);const s=await openStorage(c);
 try{
 for(let n=0;n<3;n++){s.db.prepare('INSERT INTO project VALUES(?,?,NULL)').run('p'+n,'Project '+n);s.db.prepare('INSERT INTO workspace VALUES(?,?,?,?,?,?)').run('w'+n,s.deviceId,'/workspace/'+n,null,'p'+n,n===2?'manual':'automatic');}
 await discoverProjects(s,new Set(),async()=> 'git:example.test/team/repo');
 expect(s.db.prepare('SELECT project_id,repository_identity FROM workspace ORDER BY id').all()).toEqual([{project_id:'p0',repository_identity:'git:example.test/team/repo'},{project_id:'p0',repository_identity:'git:example.test/team/repo'},{project_id:'p2',repository_identity:null}]);
 expect(s.db.prepare('SELECT mapping_revision FROM metadata').get()).toEqual({mapping_revision:2n});
 }finally{s.close();}
});

describe('project rules for folders without a remote',()=>{
 const HOME='/Users/me';
 const rules={worktreeRoots:[`${HOME}/orca/workspaces`,`${HOME}/conductor/workspaces`],buckets:[{id:'codex-scratch',label:'Codex 임시 작업',roots:[`${HOME}/Documents/Codex`]},{id:'temporary',label:'임시·테스트',roots:['/private/tmp']}]};
 const remotes:Record<string,string>={[`${HOME}/projects/shop`]:'git:github.com/o/shop',[`${HOME}/projects/app`]:'git:github-work/o/app',[`${HOME}/clone/app`]:'git:github.com/o/app'};
 const resolveRemote=async(cwd:string)=>remotes[cwd]??null;
 const hostName=async(alias:string)=>alias==='github-work'?'github.com':null;
 async function store(){const c=testConfig();directories.push(c.dataDir);const s=await openStorage(c);
  const add=(id:string,cwd:string,source='automatic',identity:string|null=null)=>{s.db.prepare('INSERT INTO project VALUES(?,?,NULL)').run('p-'+id,cwd.split('/').pop());s.db.prepare('INSERT INTO workspace VALUES(?,?,?,?,?,?)').run(id,s.deviceId,cwd,identity,'p-'+id,source);};
  return {s,add};}
 const projectOf=(s:Awaited<ReturnType<typeof store>>['s'],id:string)=>(s.db.prepare('SELECT project_id FROM workspace WHERE id=?').get(id) as {project_id:string}).project_id;
 const archived=(s:Awaited<ReturnType<typeof store>>['s'],id:string)=>(s.db.prepare('SELECT archived_at FROM project WHERE id=?').get(id) as {archived_at:bigint|null}).archived_at!==null;

 it('joins worktree tool paths, parent folders and scratch buckets; archives the emptied automatic projects; leaves manual and unmatched folders alone',async()=>{
  const {s,add}=await store();
  try{
   add('repo',`${HOME}/projects/shop`);
   add('orca',`${HOME}/orca/workspaces/shop`);                       // worktree tool parent folder, no remote
   add('gone',`${HOME}/conductor/workspaces/shop/belmopan/server`);   // deleted worktree subfolder
   add('uig',`${HOME}/conductor/workspaces/uig/baton-rouge`);             // no project has that repository
   add('site',`${HOME}/projects/acme/consulting`);
   add('fonts',`${HOME}/projects/acme/consulting/public/fonts`);      // parent folder
   add('codex-a',`${HOME}/Documents/Codex/2026-09-21/new-chat`);
   add('codex-b',`${HOME}/Documents/Codex/2026-10-09/site`);
   add('tmp',`/private/tmp/probe`);
   add('alone',`${HOME}/projects/notes`);
   add('manual',`${HOME}/orca/workspaces/shop/other`,'manual');
   s.db.prepare("INSERT INTO work_item VALUES('keep','Task','', 'p-codex-b','open',1,1,NULL)").run();
   await discoverProjects(s,new Set(),resolveRemote,{rules,hostName,home:HOME,now:()=>7});
   expect(projectOf(s,'orca')).toBe('p-repo');expect(projectOf(s,'gone')).toBe('p-repo');
   expect(projectOf(s,'fonts')).toBe('p-site');
   expect(projectOf(s,'codex-a')).toBe('bucket:codex-scratch');expect(projectOf(s,'codex-b')).toBe('bucket:codex-scratch');
   expect(projectOf(s,'tmp')).toBe('bucket:temporary');
   expect(s.db.prepare("SELECT label FROM project WHERE id LIKE 'bucket:%' ORDER BY id").all()).toEqual([{label:'Codex 임시 작업'},{label:'임시·테스트'}]);
   for(const id of ['uig','alone','site'])expect(projectOf(s,id)).toBe('p-'+id);
   expect(projectOf(s,'manual')).toBe('p-manual');
   expect(['p-orca','p-gone','p-fonts','p-codex-a','p-tmp'].map(id=>archived(s,id))).toEqual([true,true,true,true,true]);
   expect(archived(s,'p-codex-b')).toBe(false); // still holds a work item
   expect(archived(s,'p-uig')).toBe(false);
   // Idempotent: a second pass in a new process changes nothing.
   const before=s.db.prepare('SELECT id,project_id FROM workspace ORDER BY id').all();
   await discoverProjects(s,new Set(),resolveRemote,{rules,hostName,home:HOME,now:()=>8});
   expect(s.db.prepare('SELECT id,project_id FROM workspace ORDER BY id').all()).toEqual(before);
  }finally{s.close();}
 });

 it('treats an SSH alias host as its real host, for stored and newly read remotes, so one repository stays one project',async()=>{
  const {s,add}=await store();
  try{
   add('stored',`${HOME}/old/app`,'automatic','git:github-work/o/app');
   add('alias',`${HOME}/projects/app`);
   add('https',`${HOME}/clone/app`);
   add('home-child',`${HOME}/projects`);              // a container folder is never a parent
   add('below',`${HOME}/projects/notes`);
   await discoverProjects(s,new Set(),resolveRemote,{rules,hostName,home:HOME,now:()=>7});
   expect(s.db.prepare("SELECT id,repository_identity,project_id FROM workspace WHERE id IN ('stored','alias','https') ORDER BY id").all()).toEqual([
    {id:'alias',repository_identity:'git:github.com/o/app',project_id:'p-stored'},
    {id:'https',repository_identity:'git:github.com/o/app',project_id:'p-stored'},
    {id:'stored',repository_identity:'git:github.com/o/app',project_id:'p-stored'}]);
   expect(archived(s,'p-alias')).toBe(true);expect(archived(s,'p-https')).toBe(true);
   expect(projectOf(s,'below')).toBe('p-below');
  }finally{s.close();}
 });
});
