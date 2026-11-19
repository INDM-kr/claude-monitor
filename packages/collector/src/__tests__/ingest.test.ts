import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULTS, type CollectorConfig } from '../config.js';
import { LedgerIngestor, type IngestOptions } from '../ingest.js';
import { openStorage, type Storage } from '../storage.js';
import { testConfig } from './helpers.js';

const directories:string[]=[], stores:Storage[]=[], children:ChildProcess[]=[];
const fixture=(name:string)=>readFileSync(new URL(`../../../adapter-claude-code/src/__tests__/fixtures/l0/${name}`,import.meta.url));
function config():CollectorConfig {const value=testConfig();directories.push(value.dataDir);mkdirSync(value.projectsDir,{recursive:true});return value;}
async function open(c:CollectorConfig, options:IngestOptions={}) {const store=await openStorage(c);stores.push(store);return {store,ingestor:new LedgerIngestor(store,c,options)};}
const lines=(...records:unknown[])=>records.map(r=>JSON.stringify(r)+'\n').join('');
function record(responseId='response-a', input=10, output=5):any {return {type:'assistant',sessionId:'session-parent',cwd:'/workspace/alpha',timestamp:'2026-09-18T00:00:00.000Z',uuid:`record-${responseId}`,requestId:`request-${responseId}`,message:{id:responseId,model:'fixture-model-a',usage:{input_tokens:input,output_tokens:output,cache_read_input_tokens:0,cache_creation_input_tokens:0}}};}
const total=(store:Storage)=>store.db.prepare("SELECT coalesce(sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),0) n FROM usage_record WHERE validity='valid'").get() as {n:bigint};
const count=(store:Storage,table:string)=>(store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:bigint}).n;
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function touchChanged(path:string) {const st=statSync(path);utimesSync(path,st.atime,new Date(st.mtimeMs+2000));}
afterEach(async()=>{
  for(const child of children.splice(0)) if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
  for(const store of stores.splice(0)) store.close();
  for(const path of directories.splice(0)) rmSync(path,{recursive:true,force:true});
});

describe('incremental ledger collection',()=>{
  it('waits for partial JSON and checkpoints malformed complete lines without blocking later usage',async()=>{
    const c=config(), path=join(c.projectsDir,'parent.jsonl');
    const first=fixture('synthetic-stream.part1.txt'), second=fixture('synthetic-stream.part2.txt');
    writeFileSync(path,first);
    const {store,ingestor}=await open(c);
    expect((await ingestor.scan()).ingestionState).toBe('partial');
    expect(total(store).n).toBe(15n);
    const complete=first.lastIndexOf(10)+1;
    expect(store.db.prepare('SELECT complete_byte_offset,verified_prefix_hash FROM checkpoint').get()).toEqual({complete_byte_offset:BigInt(complete),verified_prefix_hash:hash(first.subarray(0,complete))});
    expect(store.db.prepare('SELECT code,count FROM ingestion_diagnostic').all()).toEqual([{code:'malformed_json',count:1n}]);
    await ingestor.scan();expect(total(store).n).toBe(15n);expect(count(store,'source_generation')).toBe(1n);
    appendFileSync(path,second);
    expect((await ingestor.scan()).ingestionState).toBe('watching');
    expect(total(store).n).toBe(40n);
    expect(store.db.prepare('SELECT complete_byte_offset FROM checkpoint').get()).toEqual({complete_byte_offset:BigInt(first.length+second.length)});
    expect(count(store,'usage_observation')).toBe(2n);
  });
  it('preserves totals across duplicate scan, restart and copied source',async()=>{
    const c=config(), path=join(c.projectsDir,'parent.jsonl');writeFileSync(path,lines(record()));
    const first=await open(c);await first.ingestor.scan();await first.ingestor.scan();expect(total(first.store).n).toBe(15n);
    first.store.close();const second=await open(c);await second.ingestor.scan();
    copyFileSync(path,join(c.projectsDir,'copy.jsonl'));await second.ingestor.scan();
    expect(total(second.store).n).toBe(15n);expect(count(second.store,'usage_record')).toBe(1n);expect(count(second.store,'usage_source_link')).toBe(2n);
  });
  it('retains removed sources and detects truncate, rename rotation and prefix replacement',async()=>{
    const c=config(), path=join(c.projectsDir,'parent.jsonl');writeFileSync(path,lines(record('a'),record('b',20)));
    const {store,ingestor}=await open(c);await ingestor.scan();expect(total(store).n).toBe(40n);
    writeFileSync(path,lines(record('c',30)));touchChanged(path);await ingestor.scan();expect(total(store).n).toBe(75n);
    expect(count(store,'source_generation')).toBe(2n);
    renameSync(path,join(c.projectsDir,'rotated.jsonl'));writeFileSync(path,lines(record('d',40)));await ingestor.scan();
    expect(total(store).n).toBe(120n);expect(count(store,'source_generation')).toBe(4n);
    writeFileSync(path,lines(record('e',50),record('f',60)));touchChanged(path);await ingestor.scan();expect(total(store).n).toBe(240n);
    rmSync(path);rmSync(join(c.projectsDir,'rotated.jsonl'));expect((await ingestor.scan()).sourceCount).toBe(0);expect(total(store).n).toBe(240n);
  });
  it('detects same-size edits and retains conflicting snapshots as excluded evidence',async()=>{
    const c=config(),path=join(c.projectsDir,'parent.jsonl');writeFileSync(path,lines(record('a',10,5)));
    const {store,ingestor}=await open(c);await ingestor.scan();const previous=statSync(path).size;
    writeFileSync(path,lines(record('a',10,9)));expect(statSync(path).size).toBe(previous);touchChanged(path);
    await ingestor.scan();expect(count(store,'source_generation')).toBe(2n);expect(total(store).n).toBe(0n);
    expect(store.db.prepare('SELECT validity FROM usage_record').get()).toEqual({validity:'conflict'});
    expect(store.db.prepare("SELECT code FROM ingestion_diagnostic WHERE code='ambiguous_snapshot'").all()).toHaveLength(1);
  });
  it('commits complete lines in bounded batches and reads append after backfill on the next scan',async()=>{
    const c={...config(),batchSize:2},path=join(c.projectsDir,'parent.jsonl');writeFileSync(path,lines(...Array.from({length:5},(_,i)=>record(String(i)))));
    let appended=false,commits=0;
    const {store,ingestor}=await open(c,{afterCommit:()=>{commits++;if(!appended){appendFileSync(path,lines(record('late',20)));appended=true;}}});
    await ingestor.scan();expect(commits).toBe(3);expect(total(store).n).toBe(75n);
    await ingestor.scan();expect(total(store).n).toBe(100n);expect(count(store,'usage_record')).toBe(6n);
    expect(count(store,'source_generation')).toBe(1n);
  });
  it('bounds oversized partial lines while keeping the exact complete prefix hash',async()=>{
    const c=config(),path=join(c.projectsDir,'parent.jsonl'),first=lines(record());
    writeFileSync(path,first+'x'.repeat(DEFAULTS.maxLineBytes+100));
    const {store,ingestor}=await open(c);expect((await ingestor.scan()).ingestionState).toBe('partial');
    expect(total(store).n).toBe(15n);
    expect(store.db.prepare('SELECT complete_byte_offset,verified_prefix_hash FROM checkpoint').get()).toEqual({complete_byte_offset:BigInt(Buffer.byteLength(first)),verified_prefix_hash:hash(first)});
    appendFileSync(path,'\n'+lines(record('b',20)));await ingestor.scan();
    expect(count(store,'source_generation')).toBe(1n);expect(total(store).n).toBe(40n);
    expect(store.db.prepare("SELECT byte_offset FROM ingestion_diagnostic WHERE code='line_too_large'").get()).toEqual({byte_offset:BigInt(Buffer.byteLength(first))});
  });
  it('reuses runtime-created parent and child run UUIDs without foreign-key failures',async()=>{
    const c=config(),path=join(c.projectsDir,'session-parent','subagents','agent-child.jsonl');mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,lines(record()));
    const {store,ingestor}=await open(c);
    store.db.prepare("INSERT INTO run VALUES('runtime-root',?,'claude-code','session-parent',NULL,NULL,NULL)").run(store.deviceId);
    store.db.prepare("INSERT INTO run VALUES('runtime-child',?,'claude-code','session-parent','agent-child','runtime-root',NULL)").run(store.deviceId);
    await ingestor.scan();expect(total(store).n).toBe(15n);expect(count(store,'run')).toBe(2n);
    expect(store.db.prepare('SELECT run_id FROM usage_record').get()).toEqual({run_id:'runtime-child'});
    expect(store.db.prepare('SELECT count(*) n FROM run WHERE workspace_id IS NOT NULL').get()).toEqual({n:2n});
  });
  it('adopts hook-created child runs that carry the bare agent id Claude hooks report',async()=>{
    const c=config();
    const plain=join(c.projectsDir,'session-parent','subagents','agent-child.jsonl');
    const flow=join(c.projectsDir,'session-parent','subagents','workflows','wf_run1','agent-wchild.jsonl');
    mkdirSync(join(flow,'..'),{recursive:true});writeFileSync(plain,lines(record('response-plain')));writeFileSync(flow,lines(record('response-flow')));
    const {store,ingestor}=await open(c);
    store.db.prepare("INSERT INTO run VALUES('runtime-root',?,'claude-code','session-parent',NULL,NULL,NULL)").run(store.deviceId);
    store.db.prepare("INSERT INTO run VALUES('hook-child',?,'claude-code','session-parent','child','runtime-root',NULL)").run(store.deviceId);
    store.db.prepare("INSERT INTO run VALUES('hook-wchild',?,'claude-code','session-parent','wchild','runtime-root',NULL)").run(store.deviceId);
    await ingestor.scan();
    expect(count(store,'run')).toBe(3n);
    expect(store.db.prepare("SELECT id,native_agent_id FROM run WHERE parent_run_id IS NOT NULL ORDER BY id").all())
      .toEqual([{id:'hook-child',native_agent_id:'agent-child'},{id:'hook-wchild',native_agent_id:'wf_run1/agent-wchild'}]);
    expect(store.db.prepare('SELECT response_id,run_id FROM usage_record ORDER BY response_id').all())
      .toEqual([{response_id:'response-flow',run_id:'hook-wchild'},{response_id:'response-plain',run_id:'hook-child'}]);
    expect(store.db.prepare('SELECT count(*) n FROM run WHERE workspace_id IS NULL').get()).toEqual({n:0n});
  });
  it('removes a response whose late earlier observation moves it into an excluded range, and tombstones later copies',async()=>{
    const c=config(),path=join(c.projectsDir,'parent.jsonl');const current=record();current.timestamp='2026-09-20T00:00:00.000Z';writeFileSync(path,lines(current));
    const {store,ingestor}=await open(c);await ingestor.scan();expect(total(store).n).toBe(15n);
    store.db.prepare('INSERT INTO usage_exclusion VALUES(?,?,?,?)').run('excluded',Date.parse('2026-09-01T00:00:00Z'),Date.parse('2026-09-19T00:00:00Z'),Date.now());
    writeFileSync(join(c.projectsDir,'older.jsonl'),lines(record()));await ingestor.scan();
    expect(count(store,'usage_record')).toBe(0n);expect(count(store,'usage_observation')).toBe(0n);expect(count(store,'usage_source_link')).toBe(0n);expect(count(store,'usage_excluded_response')).toBe(1n);
    current.timestamp='2026-09-21T00:00:00.000Z';appendFileSync(path,lines(current));await ingestor.scan();expect(count(store,'usage_observation')).toBe(0n);expect(total(store).n).toBe(0n);
  });
  it('does not follow symlink sources outside the configured root',async()=>{
    const c=config();const outside=join(c.dataDir,'outside.jsonl');writeFileSync(outside,lines(record()));symlinkSync(outside,join(c.projectsDir,'link.jsonl'));
    const {store,ingestor}=await open(c);expect((await ingestor.scan()).sourceCount).toBe(0);expect(total(store).n).toBe(0n);
  });
  it('surfaces transaction bugs instead of misclassifying them as source errors',async()=>{
    const c=config();writeFileSync(join(c.projectsDir,'parent.jsonl'),lines(record()));
    const {store,ingestor}=await open(c,{beforeCommit:()=>{throw new Error('injected programming error');}});
    await expect(ingestor.scan()).rejects.toThrow('injected programming error');
    expect(total(store).n).toBe(0n);expect(store.db.prepare('SELECT complete_byte_offset FROM checkpoint').get()).toEqual({complete_byte_offset:0n});
    expect(count(store,'ingestion_diagnostic')).toBe(0n);
  });
  for(const scenario of JSON.parse(fixture('manifest.json').toString()).observed) it(`imports observed fixture ${scenario.file} into the real database`,async()=>{
    const c=config(),path=join(c.projectsDir,scenario.source??scenario.file);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,fixture(scenario.file));
    const {store,ingestor}=await open(c);await ingestor.scan();
    expect(total(store).n).toBe(BigInt(scenario.expectedTokens));expect(count(store,'usage_record')).toBe(BigInt(scenario.expectedRequests));
    if(scenario.costEligible===false) expect(store.db.prepare('SELECT cost_eligibility FROM usage_record').get()).toEqual({cost_eligibility:'invalid_cache_split'});
  });
});

for(const phase of ['before','after']) it(`SIGKILL ${phase} commit preserves atomic usage/checkpoint and safely replays`,async()=>{
  const c=config(),path=join(c.projectsDir,'parent.jsonl'),contents=lines(record());writeFileSync(path,contents);
  const child=fork(new URL('./fixtures/ingest-crash.mjs',import.meta.url),[],{execArgv:[],env:{...process.env,CM_DATA_DIR:c.dataDir,CLAUDE_PROJECTS_DIR:c.projectsDir,CM_CODEX_DIR:c.codexDir!,CM_TEST_CRASH_PHASE:phase},stdio:['ignore','pipe','pipe','ipc']});children.push(child);
  await new Promise<void>((resolve,reject)=>{
    let stdout='',stderr='';const timeout=setTimeout(()=>reject(new Error(`boundary_timeout:${stderr}`)),10000);
    child.stderr!.on('data',chunk=>{stderr+=chunk;});
    child.stdout!.on('data',chunk=>{stdout+=chunk;if(stdout.includes(`BOUNDARY:${phase}`)){clearTimeout(timeout);resolve();}});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`boundary_child_exited:${code}:${stderr}`));});
  });
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const {store,ingestor}=await open(c);
  expect(total(store).n).toBe(phase==='before'?0n:15n);
  expect(store.db.prepare('SELECT complete_byte_offset FROM checkpoint').get()).toEqual({complete_byte_offset:phase==='before'?0n:BigInt(Buffer.byteLength(contents))});
  await ingestor.scan();expect(total(store).n).toBe(15n);expect(count(store,'usage_observation')).toBe(1n);
  expect(store.db.prepare('SELECT complete_byte_offset FROM checkpoint').get()).toEqual({complete_byte_offset:BigInt(Buffer.byteLength(contents))});
},15000);
