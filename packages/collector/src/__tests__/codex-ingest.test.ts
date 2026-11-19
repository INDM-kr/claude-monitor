import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCollectorConfig, type CollectorConfig } from '../config.js';
import { LedgerIngestor } from '../ingest.js';
import { listRuntimeRuns } from '../runtime.js';
import { usageReport } from '../report.js';
import { migrations } from '../schema.js';
import { openStorage, type Storage } from '../storage.js';
import { testConfig } from './helpers.js';

const directories:string[]=[], stores:Storage[]=[];
const ROOT='11111111-1111-7111-8111-111111111111', CHILD='22222222-2222-7222-8222-222222222222', REVIEW='33333333-3333-7333-8333-333333333333', WINDOW='44444444-4444-7444-8444-444444444444';
function config():CollectorConfig {const value=testConfig();directories.push(value.dataDir);mkdirSync(value.projectsDir,{recursive:true});mkdirSync(value.codexDir!,{recursive:true});return value;}
async function open(c:CollectorConfig,steps=migrations) {const store=await openStorage(c,steps);stores.push(store);return {store,ingestor:new LedgerIngestor(store,c)};}
const lines=(...records:unknown[])=>records.map(r=>JSON.stringify(r)+'\n').join('');
const rollout=(c:CollectorConfig,thread:string)=>{const dir=join(c.codexDir!,'2026','09','30');mkdirSync(dir,{recursive:true});return join(dir,`rollout-2026-09-30T16-00-00-${thread}.jsonl`);};
const meta=(id:string,extra:Record<string,unknown>={})=>({timestamp:'2026-09-30T07:00:00.000Z',type:'session_meta',payload:{id,session_id:id,cwd:'/workspace/alpha',originator:'codex-tui',source:'vscode',...extra}});
const turn=(turnId:string,model='gpt-test')=>({timestamp:'2026-09-30T07:00:01.000Z',type:'turn_context',payload:{turn_id:turnId,model,cwd:'/workspace/alpha'}});
const usage=(thread:string,responseId:string,input=1000,cached=400,output=50,turnId='turn-1',ordinal=20)=>({timestamp:'2026-09-30T07:01:00.000Z',ordinal,type:'token_usage_record',payload:{thread_id:thread,turn_id:turnId,session_id:thread,response_id:responseId,usage:{input_tokens:input,cached_input_tokens:cached,cache_write_input_tokens:0,output_tokens:output,reasoning_output_tokens:0,total_tokens:input+output}}});
const event=(type:string,timestamp:string)=>({timestamp,ordinal:30,type:'event_msg',payload:{type}});
const claude=(responseId:string)=>({type:'assistant',sessionId:'claude-session',cwd:'/workspace/alpha',timestamp:'2026-09-30T06:00:00.000Z',uuid:`record-${responseId}`,requestId:`request-${responseId}`,message:{id:responseId,model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}}});
const rows=(store:Storage,sql:string,...args:unknown[])=>store.db.prepare(sql).all(...args) as Record<string,unknown>[];
afterEach(()=>{for(const store of stores.splice(0)) store.close();for(const path of directories.splice(0)) rmSync(path,{recursive:true,force:true});});

describe('Codex usage in the ledger',()=>{
  it('reads CM_ENABLE_CODEX and CM_CODEX_DIR the same way as the monitor',()=>{
    const base={CM_DATA_DIR:'/tmp/cm-config',CM_TIMEZONE:'UTC'};
    expect(loadCollectorConfig({...base,CM_CODEX_DIR:'/data/codex/../codex'}).codexDir).toBe('/data/codex');
    expect(loadCollectorConfig({...base,CM_ENABLE_CODEX:'0'}).codexDir).toBeNull();
    expect(loadCollectorConfig({...base,CM_ENABLE_CODEX:'off'}).codexDir).toBeNull();
    expect(loadCollectorConfig({...base,CM_ENABLE_CODEX:''}).codexDir).toMatch(/\.codex\/sessions$/);
  });

  it('adds the codex provider and reading-state table to an existing v5 ledger',async()=>{
    const c=config();
    const old=await open(c,migrations.filter(step=>step.version<=5));old.store.close();stores.pop();
    const {store}=await open(c);
    expect(rows(store,'SELECT id FROM provider ORDER BY id')).toEqual([{id:'claude-code'},{id:'codex'}]);
    expect(rows(store,"SELECT name FROM sqlite_master WHERE name='source_context'")).toHaveLength(1);
  });

  it('collects Codex responses beside Claude Code in the same workspace project, uncached input like Claude',async()=>{
    const c=config();
    writeFileSync(join(c.projectsDir,'claude.jsonl'),lines(claude('msg_a')));
    writeFileSync(rollout(c,ROOT),lines(meta(ROOT),turn('turn-1'),usage(ROOT,'resp_1')));
    const {store,ingestor}=await open(c);
    expect((await ingestor.scan()).ingestionState).toBe('watching');
    const usageRows=rows(store,'SELECT provider_id,model,input_tokens,cache_read_tokens,output_tokens,workspace_id,run_id FROM usage_record ORDER BY provider_id');
    expect(usageRows.map(r=>[r.provider_id,r.model,r.input_tokens,r.cache_read_tokens,r.output_tokens])).toEqual([['claude-code','claude-sonnet-5',10n,0n,5n],['codex','gpt-test',600n,400n,50n]]);
    expect(usageRows[0]!.workspace_id).toBe(usageRows[1]!.workspace_id);
    expect(rows(store,"SELECT provider_id,native_session_id,parent_run_id FROM run WHERE provider_id='codex'")).toEqual([{provider_id:'codex',native_session_id:ROOT,parent_run_id:null}]);
    expect(rows(store,"SELECT adapter_version FROM provider WHERE id='codex'")).toEqual([{adapter_version:'codex-usage-v1'}]);
    expect(rows(store,'SELECT parser_version FROM metadata')).toEqual([{parser_version:'claude-code-usage-v1'}]);
    const all=usageReport(store.db,{period:'custom',from:'2026-09-30',to:'2026-09-30'},Date.parse('2026-10-01T00:00:00Z'));
    const codex=usageReport(store.db,{period:'custom',from:'2026-09-30',to:'2026-09-30',providerId:'codex'},Date.parse('2026-10-01T00:00:00Z'));
    expect([all.total.requests,all.total.total,all.sourceScope.provider]).toEqual([2,'1065','all']);
    expect([codex.total.requests,codex.total.total,codex.total.costUsd,codex.sourceScope.provider]).toEqual([1,'1050',null,'codex']);
    expect(codex.total.unpriced).toEqual({unknown_model:1});
    expect(codex.requests.items[0]!.providerId).toBe('codex');
  });

  it('nests spawned agents under the top-level thread, keeps review threads out of runs and counts a continued window once',async()=>{
    const c=config();
    writeFileSync(rollout(c,ROOT),lines(meta(ROOT),turn('turn-1'),usage(ROOT,'resp_root')));
    const spawn={source:{subagent:{thread_spawn:{parent_thread_id:ROOT,depth:1}}},parent_thread_id:ROOT,session_id:ROOT,subagent_history_start_ordinal:10};
    writeFileSync(rollout(c,CHILD),lines(meta(CHILD,spawn),turn('turn-1'),usage(ROOT,'resp_root',1000,400,50,'turn-1',5),usage(CHILD,'resp_child',2000,0,100,'turn-1',12)));
    writeFileSync(rollout(c,REVIEW),lines(meta(REVIEW,{source:{subagent:'review'},session_id:ROOT,parent_thread_id:ROOT,subagent_history_start_ordinal:90}),turn('turn-1'),usage(REVIEW,'resp_review',300,0,10)));
    writeFileSync(rollout(c,`${ROOT}_${WINDOW}`),lines(meta(ROOT),turn('turn-2'),usage(ROOT,'resp_window',500,0,20,'turn-2')));
    const {store,ingestor}=await open(c);await ingestor.scan();
    const byResponse=Object.fromEntries(rows(store,'SELECT u.response_id,r.native_session_id,r.native_agent_id,u.run_id IS NULL AS no_run,u.workspace_id IS NOT NULL AS has_workspace,u.validity FROM usage_record u LEFT JOIN run r ON r.id=u.run_id').map(r=>[r.response_id,r]));
    expect(Object.keys(byResponse).sort()).toEqual(['resp_child','resp_review','resp_root','resp_window']);
    expect(byResponse.resp_root).toMatchObject({native_session_id:ROOT,native_agent_id:null,validity:'valid'});
    expect(byResponse.resp_window).toMatchObject({native_session_id:ROOT,native_agent_id:null});
    expect(byResponse.resp_child).toMatchObject({native_session_id:ROOT,native_agent_id:CHILD});
    expect(byResponse.resp_review).toMatchObject({no_run:1n,has_workspace:1n,validity:'valid'});
    expect(rows(store,"SELECT count(*) n FROM run WHERE provider_id='codex'")).toEqual([{n:2n}]);
    expect(rows(store,"SELECT count(*) n FROM usage_source_link l JOIN usage_record u ON u.id=l.usage_id WHERE u.response_id='resp_root'")).toEqual([{n:1n}]);
  });

  it('resumes a growing rollout from its checkpoint with the saved turn context, across restarts',async()=>{
    const c=config(),path=rollout(c,ROOT);
    writeFileSync(path,lines(meta(ROOT),turn('turn-1','model-a'),usage(ROOT,'resp_1')));
    const first=await open(c);await first.ingestor.scan();
    appendFileSync(path,lines(turn('turn-2','model-b'),usage(ROOT,'resp_2',100,0,10,'turn-2')));
    await first.ingestor.scan();
    first.store.close();stores.pop();
    appendFileSync(path,lines(usage(ROOT,'resp_3',100,0,10,'turn-1')));
    const second=await open(c);await second.ingestor.scan();
    expect(rows(second.store,'SELECT response_id,model FROM usage_record ORDER BY response_id')).toEqual([{response_id:'resp_1',model:'model-a'},{response_id:'resp_2',model:'model-b'},{response_id:'resp_3',model:'model-a'}]);
    expect(rows(second.store,'SELECT count(*) n FROM usage_observation')).toEqual([{n:3n}]);
    expect(rows(second.store,'SELECT count(*) n FROM source_context')).toEqual([{n:1n}]);
  });

  it('records rollout activity for the runs page and reports a legacy file without response ids once',async()=>{
    const c=config();
    writeFileSync(rollout(c,ROOT),lines(meta(ROOT),turn('turn-1'),event('task_started','2026-09-30T08:00:00.000Z'),usage(ROOT,'resp_1'),event('item_completed','2026-09-30T08:00:05.000Z'),event('task_complete','2026-09-30T08:00:09.000Z')));
    const legacyCount={timestamp:'2026-03-01T00:00:00.000Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:5}}}};
    writeFileSync(rollout(c,CHILD),lines(meta(CHILD),legacyCount,legacyCount));
    const {store,ingestor}=await open(c);await ingestor.scan();
    expect(rows(store,"SELECT event_name,observed_at FROM runtime_observation WHERE id LIKE 'codex-rollout:%'")).toEqual([{event_name:'Stop',observed_at:BigInt(Date.parse('2026-09-30T08:00:09.000Z'))}]);
    expect(rows(store,"SELECT code,count FROM ingestion_diagnostic")).toEqual([{code:'missing_response_id',count:1n}]);
    const now=Date.parse('2026-09-30T08:00:30.000Z');
    const report=await listRuntimeRuns(store,{now,probe:async()=>{throw new Error('no process probe for rollout runs');},hookConfigured:false});
    const run=report.runs.find(r=>r.providerId==='codex')!;
    expect(run).toMatchObject({sessionId:ROOT,agentId:null,activityState:'idle',outcome:'response_ended',lastEventName:'Stop',processState:'unknown',evidence:['rollout:Stop']});
    await ingestor.scan();
    expect(rows(store,"SELECT count(*) n FROM runtime_observation")).toEqual([{n:1n}]);
  });

  it('keeps collecting Claude Code when the Codex folder cannot be read',async()=>{
    const c=config();
    rmSync(c.codexDir!,{recursive:true,force:true});writeFileSync(c.codexDir!,'not a directory');
    writeFileSync(join(c.projectsDir,'claude.jsonl'),lines(claude('msg_a')));
    const {store,ingestor}=await open(c);
    expect((await ingestor.scan()).ingestionState).toBe('partial');
    expect(rows(store,'SELECT provider_id FROM usage_record')).toEqual([{provider_id:'claude-code'}]);
    expect(rows(store,'SELECT code FROM ingestion_diagnostic')).toEqual([{code:'source_discovery_failed'}]);
  });
});
