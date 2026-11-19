import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { openStorage, type Storage } from '../storage.js';
import { discoverProjects } from '../project-discovery.js';
import { usageReport } from '../report.js';
import { archiveProjects, dismissCandidate, mergeCandidates, mergeProject, monitorProjectMap, projectOverview, renameProject } from '../project-management.js';
import { testConfig } from './helpers.js';

const stores:Storage[]=[], directories:string[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});});
async function store(){const c=testConfig();directories.push(c.dataDir);const s=await openStorage(c);stores.push(s);return s;}
const HOME='/Users/me';
function project(s:Storage,id:string,label:string){s.db.prepare('INSERT INTO project VALUES(?,?,NULL)').run(id,label);}
function workspace(s:Storage,id:string,cwd:string,projectId:string|null,identity:string|null=null,source='automatic'){s.db.prepare('INSERT INTO workspace VALUES(?,?,?,?,?,?)').run(id,s.deviceId,cwd,identity,projectId,source);}
let usageCount=0;
function usage(s:Storage,workspaceId:string,tokens=100){usageCount++;s.db.prepare(`INSERT INTO usage_record(id,device_id,provider_id,response_id,run_id,workspace_id,model,first_event_at,snapshot_at,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,validity,cost_eligibility,parser_version)
  VALUES(?,?,'claude-code',?,NULL,?,'m',?,?,?,0,0,0,'valid','eligible','t/1')`).run(`u${usageCount}`,s.deviceId,`r${usageCount}`,workspaceId,Date.parse('2026-09-30T00:00:00Z'),Date.parse('2026-09-30T00:00:00Z'),tokens);}
const report=(s:Storage)=>usageReport(s.db,{period:'custom',from:'2026-09-30',to:'2026-09-30'},Date.parse('2026-10-01T00:00:00Z'));

describe('project management',()=>{
  it('suggests merging unknown-repository projects by name, Conductor repository and parent folder, never two known repositories',async()=>{
    const s=await store();
    project(s,'repo','codegen');workspace(s,'w-repo',`${HOME}/projects/codegen`,'repo','git:github.com/o/codegen');usage(s,'w-repo');
    project(s,'hanoi','codegen');workspace(s,'w-hanoi',`${HOME}/conductor/workspaces/codegen/hanoi`,'hanoi',null,'manual');usage(s,'w-hanoi');
    project(s,'monitor','claude-monitor');workspace(s,'w-monitor',`${HOME}/projects/claude-monitor`,'monitor','git:github.com/o/claude-monitor');
    project(s,'muscat','muscat');workspace(s,'w-muscat',`${HOME}/conductor/workspaces/claude-monitor/muscat`,'muscat');
    project(s,'sub','requirements');workspace(s,'w-sub',`${HOME}/projects/claude-monitor/docs/requirements`,'sub');
    project(s,'web-a','web');workspace(s,'w-web-a',`${HOME}/a/web`,'web-a','git:github.com/o/a-web');
    project(s,'web-b','web');workspace(s,'w-web-b',`${HOME}/b/web`,'web-b','git:github.com/o/b-web');
    project(s,'empty','api');
    project(s,'adapter-1','adapter-claude-code');workspace(s,'w-a1',`${HOME}/conductor/workspaces/claude-monitor/bern/packages/adapter-claude-code`,'adapter-1');usage(s,'w-a1');
    project(s,'adapter-2','adapter-claude-code');workspace(s,'w-a2',`${HOME}/conductor/workspaces/claude-monitor/muscat/packages/adapter-claude-code`,'adapter-2');
    project(s,'notes-1','notes');workspace(s,'w-n1',`${HOME}/one/notes`,'notes-1');
    project(s,'notes-2','notes');workspace(s,'w-n2',`${HOME}/two/notes`,'notes-2');usage(s,'w-n2');
    const candidates=mergeCandidates(s.db);
    expect(candidates.map(c=>[c.reason,c.sourceId,c.targetIds])).toEqual([
      ['same_label','hanoi',['repo']],['conductor_repo','adapter-1',['monitor']],['conductor_repo','adapter-2',['monitor']],['conductor_repo','muscat',['monitor']],
      ['parent_folder','sub',['monitor']],['same_label','notes-1',['notes-2']]]);
    const overview=projectOverview(s.db);
    expect(overview.projects.find(p=>p.id==='empty')).toMatchObject({workspaceCount:0,requestCount:0,workspacePaths:[]});
    dismissCandidate(s.db,{key:candidates[0]!.key});
    expect(mergeCandidates(s.db).map(c=>c.sourceId)).toEqual(['adapter-1','adapter-2','muscat','sub','notes-1']);
    expect(()=>dismissCandidate(s.db,{key:'nope'})).toThrow('invalid_candidate');
  });

  it('merges only when asked: folders and work items move, totals stay, the source is archived and stays joined after git lookups',async()=>{
    const s=await store();
    project(s,'target','booking-app');workspace(s,'w-t',`${HOME}/projects/booking-app`,'target','git:github.com/o/booking-app');usage(s,'w-t',100);
    project(s,'source','monaco');workspace(s,'w-s',`${HOME}/conductor/workspaces/booking-app/monaco`,'source');usage(s,'w-s',40);
    s.db.prepare("INSERT INTO work_item VALUES('work','Task','', 'source','open',1,1,NULL)").run();
    const before=report(s);
    expect(mergeCandidates(s.db).map(c=>c.sourceId)).toEqual(['source']); // suggested, not applied
    expect(s.db.prepare("SELECT project_id FROM workspace WHERE id='w-s'").get()).toEqual({project_id:'source'});
    mergeProject(s.db,{sourceId:'source',targetId:'target'},5);
    const after=report(s);
    expect(after.total.total).toBe(before.total.total);
    expect(after.projects.map(p=>[p.id,p.total])).toEqual([['target','140']]);
    expect(s.db.prepare("SELECT project_id,mapping_source FROM workspace WHERE id='w-s'").get()).toEqual({project_id:'target',mapping_source:'manual'});
    expect(s.db.prepare("SELECT project_id FROM work_item").get()).toEqual({project_id:'target'});
    expect(s.db.prepare("SELECT archived_at FROM project WHERE id='source'").get()).toEqual({archived_at:5n});
    await discoverProjects(s,new Set(),async()=>'git:github.com/o/other');
    expect(s.db.prepare("SELECT project_id FROM workspace WHERE id='w-s'").get()).toEqual({project_id:'target'});
    expect(()=>mergeProject(s.db,{sourceId:'target',targetId:'target'})).toThrow('invalid_merge');
    expect(()=>mergeProject(s.db,{sourceId:'target',targetId:'source'})).toThrow('invalid_merge');
    expect(()=>mergeProject(s.db,{sourceId:'target',targetId:'missing'})).toThrow('project_not_found');
  });

  it('archives and restores only empty projects, and keeps a renamed project name when git identifies the repository',async()=>{
    const s=await store();
    project(s,'empty','api');project(s,'busy','busy');workspace(s,'w-b',`${HOME}/busy`,'busy');
    expect(()=>archiveProjects(s.db,{projectIds:['empty','busy'],archived:true})).toThrow('project_not_empty');
    expect(s.db.prepare("SELECT archived_at FROM project WHERE id='empty'").get()).toEqual({archived_at:null}); // all-or-nothing
    const archived=archiveProjects(s.db,{projectIds:['empty'],archived:true},7);
    expect([archived.projects.map(p=>p.id),archived.archived.map(p=>p.id)]).toEqual([['busy'],['empty']]);
    expect(archiveProjects(s.db,{projectIds:['empty'],archived:false}).archived).toEqual([]);
    renameProject(s.db,{projectId:'busy',label:'  Busy App  '});
    expect(()=>renameProject(s.db,{projectId:'busy',label:' '})).toThrow('invalid_label');
    await discoverProjects(s,new Set(),async()=>'git:github.com/o/busy-repo');
    expect(s.db.prepare("SELECT label FROM project WHERE id='busy'").get()).toEqual({label:'Busy App'});
    project(s,'auto','fresh');workspace(s,'w-a',`${HOME}/fresh`,'auto');
    await discoverProjects(s,new Set(),async()=>'git:github.com/o/fresh-repo');
    expect(s.db.prepare("SELECT label FROM project WHERE id='auto'").get()).toEqual({label:'fresh-repo'});
  });

  it('lists each project\'s folders most used first, and gives the live monitor one key per project, keeping the git key for repository projects',async()=>{
    const s=await store();
    project(s,'repo','booking-app');workspace(s,'w-r',`${HOME}/projects/booking-app`,'repo','git:github.com/o/booking-app');
    workspace(s,'w-m',`${HOME}/conductor/workspaces/booking-app/monaco`,'repo',null,'manual');
    project(s,'local','notes');workspace(s,'w-l',`${HOME}/notes`,'local');
    renameProject(s.db,{projectId:'repo',label:'Booking'});
    usage(s,'w-m');usage(s,'w-m');usage(s,'w-r');
    workspace(s,'w-a',`${HOME}/conductor/workspaces/booking-app/accra`,'repo',null,'manual');usage(s,'w-a');
    // Most requests first, ties by path.
    expect(projectOverview(s.db).projects.map(p=>[p.id,p.workspacePaths])).toEqual([
      ['repo',[`${HOME}/conductor/workspaces/booking-app/monaco`,`${HOME}/conductor/workspaces/booking-app/accra`,`${HOME}/projects/booking-app`]],
      ['local',[`${HOME}/notes`]]]);
    expect(monitorProjectMap(s.db)).toEqual({
      workspaces:{
        [`${HOME}/projects/booking-app`]:{key:'git:github.com/o/booking-app',label:'Booking'},
        [`${HOME}/conductor/workspaces/booking-app/monaco`]:{key:'git:github.com/o/booking-app',label:'Booking'},
        [`${HOME}/conductor/workspaces/booking-app/accra`]:{key:'git:github.com/o/booking-app',label:'Booking'},
        [`${HOME}/notes`]:{key:'project:local',label:'notes'},
      },
      identities:{'git:github.com/o/booking-app':{key:'git:github.com/o/booking-app',label:'Booking'}},
    });
  });
});
