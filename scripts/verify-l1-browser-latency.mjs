#!/usr/bin/env node
import {readFile,writeFile,open,realpath} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=resolve(new URL('..',import.meta.url).pathname);
const lease=JSON.parse(await readFile(join(root,'.scratch/l1-benchmark-ready.json'),'utf8'));
const browser=process.env.GSTACK_BROWSER_BIN||join(homedir(),'.claude/skills/gstack/browse/dist/browse');
const run=async(...args)=>(await exec(browser,args,{cwd:root,maxBuffer:1024*1024,timeout:20000})).stdout;
const working=await realpath(lease.workingDir);
for(const path of lease.targets){const rel=relative(working,await realpath(path));if(rel.startsWith('..')||rel==='')throw new Error('invalid_owned_target');}
if(new URL(lease.base).hostname!=='127.0.0.1')throw new Error('invalid_fixture_origin');
const require=createRequire(new URL('../packages/collector/package.json',import.meta.url));
const Database=require('better-sqlite3');const db=new Database(join(lease.dataDir,'usage.sqlite'),{readonly:true,fileMustExist:true});
const seen=db.prepare('SELECT count(*) AS count FROM usage_record WHERE response_id=?');
const samples=[];let counter=0;
const prefix=`l1-ui-${Date.now()}`;
try {
 await run('goto',lease.base+'/usage?period=30&timezone=UTC');
 const baseline=await(await fetch(lease.base+'/api/reports/usage?period=30&timezone=UTC')).json();let expected=BigInt(baseline.total.total);
 await run('js',`(async()=>{for(let i=0;i<750;i++){if(document.querySelector('[data-testid="exact-total"]')?.textContent.replaceAll(',','').startsWith('${expected} tokens'))return true;await new Promise(r=>setTimeout(r,20));}throw new Error('initial_render_timeout')})()`);
 for(const width of [1,10]) {
  const series=[];
  for(let n=0;n<30;n++){
   const ids=[];const started=Date.now();
   for(let file=0;file<width;file++){
    const id=`${prefix}-${counter++}`;ids.push(id);
    const record={type:'assistant',sessionId:'l1-ui-session',cwd:'/workspace/l1-ui',timestamp:new Date().toISOString(),requestId:id,message:{id,model:'fixture-ui-latency',usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}}};
    const fd=await open(lease.targets[file],'a');try{await fd.write(JSON.stringify(record)+'\n');await fd.sync();}finally{await fd.close();}expected+=15n;
   }
   const flushed=Date.now();
   const visible=run('js',`(async()=>{for(let i=0;i<750;i++){if(document.querySelector('[data-testid="exact-total"]')?.textContent.replaceAll(',','').startsWith('${expected} tokens'))return {at:Date.now()};await new Promise(r=>setTimeout(r,20));}throw new Error('display_timeout')})()`);
   let committed;
   while(Date.now()-started<15000){if(ids.every(id=>seen.get(id).count===1)){committed=Date.now();break;}await sleep(20);}
   if(!committed)throw new Error('commit_timeout');
   const display=JSON.parse(await visible).at;
   series.push({writeMs:flushed-started,flushToCommitMs:committed-flushed,flushToDisplayMs:display-flushed,commitToDisplayMs:Math.max(0,display-committed)});
  }
  const percentile=key=>[...series.map(s=>s[key])].sort((a,b)=>a-b)[Math.ceil(series.length*.95)-1];
  const result={files:width,samples:series.length,p95FlushToCommitMs:percentile('flushToCommitMs'),p95FlushToDisplayMs:percentile('flushToDisplayMs'),p95CommitToDisplayMs:percentile('commitToDisplayMs'),maximumMs:Math.max(...series.map(s=>s.flushToDisplayMs)),measurements:series};
  samples.push(result);console.log(JSON.stringify({files:width,p95FlushToDisplayMs:result.p95FlushToDisplayMs}));
 }
 const result={status:samples.every(s=>s.p95FlushToDisplayMs<=5000)?'passed':'failed',measuredAt:new Date().toISOString(),input:lease.input,scope:'real immutable local source snapshot plus owned synthetic appends; production Next UI; no raw contents or paths recorded',pollIntervalMs:2000,method:'30 repetitions each on 1 and 10 existing files; fsync then canonical SQLite visibility and DOM exact-total; monotonic wall-clock on one Mac',samples};
 await writeFile(join(root,'docs/specs/evidence/l1-browser-latency.json'),JSON.stringify(result,null,2)+'\n');
 if(result.status!=='passed')throw new Error('browser_latency_slo_failed');
} finally {db.close();}
