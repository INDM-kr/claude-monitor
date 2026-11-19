#!/usr/bin/env node
/** Reproducible private snapshot / independent reconciliation / HTTP benchmarks.
 * Requires pnpm build. Original transcripts are read only. All private copies,
 * databases and process output are deleted in finally; reports contain aggregates.
 */
import { promises as fs } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { loadCollectorConfig } from '../packages/collector/dist/config.js';
import { openStorage } from '../packages/collector/dist/storage.js';
import { LedgerIngestor } from '../packages/collector/dist/ingest.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sum=rows=>rows.reduce((a,r)=>a.map((v,i)=>v+BigInt(r.tokens[i])),[0n,0n,0n,0n]);
const strings=values=>values.map(String);
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(p*values.length)-1];
const stats=values=>({samples:values.length,minMs:Math.min(...values),p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),maxMs:Math.max(...values)});
function config(dataDir,projectsDir){return loadCollectorConfig({CM_DATA_DIR:dataDir,CLAUDE_PROJECTS_DIR:projectsDir,CM_ENABLE_CODEX:'0',CM_TIMEZONE:'Asia/Seoul'});}
if(process.argv[2]==='--cold'){
  const [dataDir,projectsDir]=process.argv.slice(3);const store=await openStorage(config(dataDir,projectsDir));
  const started=performance.now();const progress=await new LedgerIngestor(store,config(dataDir,projectsDir)).scan();
  const elapsedMs=performance.now()-started;const sizes={};for(const name of ['usage.sqlite','usage.sqlite-wal'])sizes[name]=(await fs.stat(join(dataDir,name)).catch(()=>({size:0}))).size;
  const value={elapsedMs,peakRssBytes:process.resourceUsage().maxRSS*1024,files:progress.sourceCount,diagnostics:progress.diagnosticCount,sizes};
  store.close();process.stdout.write(JSON.stringify(value));process.exit(0);
}
let server, leasePath;
const temporary=await fs.mkdtemp(join(tmpdir(),'cm-l1-ledger-'));
await fs.chmod(temporary,0o700);
const sourceRoot=resolve(process.env.CLAUDE_PROJECTS_DIR||join(process.env.HOME,'.claude','projects'));
const snapshot=join(temporary,'snapshot'),working=join(temporary,'working');
const evidence=join(root,'docs','specs','evidence');
const reconciliation={recordedAt:new Date().toISOString(),status:'running',privacy:'Only aggregate counts/hashes; source snapshots and comparison rows remain private and are removed.',checks:[]};
const measurements={recordedAt:reconciliation.recordedAt,status:'running',environment:{node:process.version,arch:process.arch,platform:platform(),release:release(),cpu:cpus()[0]?.model,cores:cpus().length,memoryBytes:totalmem(),powerAndConcurrentLoad:'Not controlled; OS cache was not cleared.'},cold:[],query:[],append:[],limitations:['Append measurements stop at HTTP report visibility, not browser rendering. Browser scenario is verified separately.','No 10x scale experiment in this run.']};
try {
  const captured=[];
  async function copyTree(src,dst,relative=''){
    await fs.mkdir(dst,{recursive:true,mode:0o700});
    for(const entry of (await fs.readdir(src,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory())await copyTree(join(src,entry.name),join(dst,entry.name),join(relative,entry.name));
      else if(entry.isFile()&&entry.name.endsWith('.jsonl')){
        // Capture a bounded byte range from one open descriptor. Append may occur
        // in the original, but both sides subsequently read this fixed copy.
        const handle=await fs.open(join(src,entry.name),'r');
        try {const st=await handle.stat();const data=Buffer.alloc(st.size);let offset=0;while(offset<data.length){const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
          const bytes=data.subarray(0,offset);await fs.writeFile(join(dst,entry.name),bytes,{mode:0o600});captured.push({relative:join(relative,entry.name),bytes:bytes.length,complete:bytes.length===0||bytes.at(-1)===10,digest:createHash('sha256').update(bytes).digest('hex')});
        } finally {await handle.close();}
      }
    }
  }
  await copyTree(sourceRoot,snapshot);
  assert(captured.length>0,'no_source_files');
  const sourceHash=createHash('sha256').update(captured.map(f=>`${f.relative}:${f.digest}\n`).join('')).digest('hex');
  reconciliation.input={files:captured.length,bytes:captured.reduce((n,f)=>n+f.bytes,0),snapshotHash:sourceHash};measurements.input=reconciliation.input;
  await fs.cp(snapshot,working,{recursive:true});
  async function executeOracle(input,output){const run=spawnSync('python3',[join(root,'scripts/verify-l1-oracle.py'),input,output],{encoding:'utf8'});assert.equal(run.status,0,'independent_oracle_failed');return JSON.parse(await fs.readFile(output,'utf8'));}
  const fixtureDirectory=join(root,'packages/adapter-claude-code/src/__tests__/fixtures/l0');
  const manifest=JSON.parse(await fs.readFile(join(fixtureDirectory,'manifest.json'),'utf8'));
  for(const [index,golden] of manifest.observed.entries()){
    const folder=join(temporary,`golden-${index}`),path=join(folder,golden.source??golden.file);await fs.mkdir(dirname(path),{recursive:true,mode:0o700});await fs.copyFile(join(fixtureDirectory,golden.file),path);
    const result=await executeOracle(folder,join(temporary,`golden-${index}.json`)),valid=result.records.filter(r=>r.validity==='valid');
    assert.equal(valid.length,golden.expectedRequests,'oracle_golden_request_count');assert.equal(sum(valid).reduce((a,v)=>a+v,0n).toString(),String(golden.expectedTokens),'oracle_golden_tokens');
  }
  reconciliation.checks.push('independent_python_oracle_observed_golden_4');
  const oracle=await executeOracle(snapshot,join(temporary,'oracle.json'));
  for(let index=0;index<3;index++){
    const dataDir=join(temporary,`db-${index}`);
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--cold',dataDir,working],{cwd:root,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    const [code]=await once(child,'exit');assert.equal(code,0,`cold_index_failed_${index}`);
    measurements.cold.push(JSON.parse(stdout));process.stdout.write(`Cold index ${index+1}/3: ${measurements.cold.at(-1).elapsedMs.toFixed(0)} ms\n`);
  }
  const dataDir=join(temporary,'db-2'),store=await openStorage(config(dataDir,working));
  const rows=store.db.prepare(`SELECT u.response_id,u.model,u.first_event_at,u.snapshot_at,u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_write_tokens,u.validity,u.cost_eligibility,w.canonical_cwd FROM usage_record u LEFT JOIN workspace w ON w.id=u.workspace_id ORDER BY u.response_id`).all();
  assert.equal(rows.length,oracle.records.length,'canonical_request_count');
  for(let index=0;index<rows.length;index++){
    const actual=rows[index],expected=oracle.records[index];
    assert.deepEqual({responseId:actual.response_id,model:actual.model,firstEventAt:Number(actual.first_event_at),snapshotAt:Number(actual.snapshot_at),tokens:strings([actual.input_tokens,actual.output_tokens,actual.cache_read_tokens,actual.cache_write_tokens]),validity:actual.validity,costEligibility:actual.cost_eligibility,cwd:actual.canonical_cwd},
      {responseId:expected.responseId,model:expected.model,firstEventAt:expected.firstEventAt,snapshotAt:expected.snapshotAt,tokens:expected.tokens,validity:expected.validity,costEligibility:expected.costEligibility,cwd:expected.cwd?resolve(expected.cwd):null},`canonical_projection_mismatch_${index}`);
  }
  const actualDiagnostics=Object.fromEntries(store.db.prepare('SELECT code,count(*) n FROM ingestion_diagnostic GROUP BY code ORDER BY code').all().map(r=>[r.code,Number(r.n)]));
  assert.deepEqual(actualDiagnostics,Object.fromEntries(Object.entries(oracle.diagnostics).filter(([,n])=>n!==0)),'diagnostic_accounting');
  const valid=oracle.records.filter(r=>r.validity==='valid');
  reconciliation.canonical={requests:rows.length,validRequests:valid.length,excludedConflicts:rows.length-valid.length,tokens:strings(sum(valid)),diagnostics:actualDiagnostics,sourceCounts:oracle.counts};
  reconciliation.checks.push('independent_python_vs_canonical_each_request','exact_components_model_first_event_snapshot_validity_attribution','invalid_and_conflict_diagnostic_accounting');
  const mapping=new Map(store.db.prepare('SELECT canonical_cwd,project_id FROM workspace').all().map(r=>[r.canonical_cwd,r.project_id]));
  store.close();
  const available=net.createServer();await new Promise(resolve=>available.listen(0,'127.0.0.1',resolve));const port=available.address().port;await new Promise(resolve=>available.close(resolve));
  server=spawn(process.execPath,[join(root,'scripts/web.mjs'),'start'],{cwd:root,env:{...process.env,CM_DATA_DIR:dataDir,CLAUDE_PROJECTS_DIR:working,CM_ENABLE_CODEX:'0',CM_TIMEZONE:'Asia/Seoul',CM_BEARER_TOKEN:'',CM_REMOTE_USAGE_ENABLED:'false',HOSTNAME:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let privateOutput='';server.stdout.on('data',chunk=>{privateOutput+=chunk;});server.stderr.on('data',chunk=>{privateOutput+=chunk;});
  const base=`http://127.0.0.1:${port}`;
  async function request(path){const response=await fetch(base+path);assert.equal(response.status,200,'http_response_status');return response.json();}
  for(let i=0;i<600;i++){if(server.exitCode!==null)throw new Error('production_server_exited');try{const state=await request('/api/collector');if(state.state==='ready'&&['watching','partial'].includes(state.ingestionState))break;}catch{}await sleep(100);if(i===599)throw new Error('production_server_start_timeout');}
  const asOf=Date.now();
  const dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
  const components=row=>[row.input,row.output,row.cacheRead,row.cacheWrite];
  function parseCsv(text){const records=[];let row=[],cell='',quoted=false;const content=text.replace(/^\uFEFF/,'');for(let i=0;i<content.length;i++){const char=content[i];if(char==='"'){if(quoted&&content[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&char===','){row.push(cell);cell='';}else if(!quoted&&(char==='\r'||char==='\n')){if(char==='\r'&&content[i+1]==='\n')i++;row.push(cell);records.push(row);row=[];cell='';}else cell+=char;}if(cell||row.length){row.push(cell);records.push(row);}return records;}
  const validateReport=report=>{
    const scope=report.scope;
    const expected=valid.filter(r=>r.firstEventAt>=scope.from&&r.firstEventAt<scope.to&&r.snapshotAt<=scope.asOf&&(!scope.model||r.model===scope.model)&&(!scope.projectId||(mapping.get(r.cwd?resolve(r.cwd):null)??'unassigned')===scope.projectId));
    const actual=[report.total.input,report.total.output,report.total.cacheRead,report.total.cacheWrite];
    assert.deepEqual(actual,strings(sum(expected)),'report_component_reconciliation');assert.equal(report.total.requests,expected.length,'report_request_reconciliation');
    assert.equal(report.projects.length,new Set(expected.map(r=>mapping.get(r.cwd?resolve(r.cwd):null)??'unassigned')).size,'project_group_completeness');
    for(const group of report.projects){const selected=expected.filter(r=>(mapping.get(r.cwd?resolve(r.cwd):null)??'unassigned')===group.id);assert.deepEqual(components(group),strings(sum(selected)),'project_components_reconciliation');assert.equal(group.total,sum(selected).reduce((a,v)=>a+v,0n).toString(),'project_reconciliation');}
    assert.equal(report.models.length,new Set(expected.map(r=>r.model)).size,'model_group_completeness');
    for(const group of report.models){const selected=expected.filter(r=>r.model===group.model);assert.deepEqual(components(group),strings(sum(selected)),'model_components_reconciliation');assert.equal(group.total,sum(selected).reduce((a,v)=>a+v,0n).toString(),'model_reconciliation');}
    for(const group of report.days)assert.deepEqual(components(group),strings(sum(expected.filter(r=>dayFormatter.format(r.firstEventAt)===group.date))),'day_components_reconciliation');
    assert.equal(report.days.reduce((n,row)=>n+BigInt(row.total),0n).toString(),report.total.total,'day_sum_reconciliation');
  };
  for(const period of ['today','7','30']){
    const basePath=`/api/reports/usage?period=${period}&asOf=${asOf}&timezone=Asia%2FSeoul`;
    const report=await request(basePath);validateReport(report);
    const csvStarted=performance.now(),csvResponse=await fetch(base+basePath.replace('/usage?','/usage.csv?'));assert.equal(csvResponse.status,200,'csv_status');const csvText=await csvResponse.text();
    const csv=parseCsv(csvText),csvHeader=csv.shift();assert.equal(csv.length,report.projects.length,'csv_project_count');
    for(const row of csv){const project=report.projects.find(p=>p.id===row[0]);assert(project,'csv_project_identity');assert.deepEqual(row.slice(2,6),components(project),'csv_project_components');assert.equal(row[6],project.total,'csv_total');assert.equal(row[14],new Date(report.scope.asOf).toISOString(),'csv_as_of');}
    (measurements.csv??=[]).push({period,bytes:Buffer.byteLength(csvText),elapsedMs:performance.now()-csvStarted});
    const combos=[['all',basePath]];
    if(report.projects.length)combos.push(['project',basePath+'&projectId='+encodeURIComponent(report.projects[0].id)]);
    if(report.models.length)combos.push(['model',basePath+'&model='+encodeURIComponent(report.models[0].model)]);
    for(const [filter,path] of combos){
      const response=await request(path);validateReport(response);
      for(let i=0;i<5;i++)await request(path);
      const times=[];for(let i=0;i<30;i++){const started=performance.now();await request(path);times.push(performance.now()-started);}
      measurements.query.push({period,filter,...stats(times),pass:percentile(times,.95)<=1000});
    }
  }
  reconciliation.checks.push('today_7_30_http_scope_components_projects_models_day_sums','project_and_model_filter_http_reconciliation','independent_per_day_project_model_component_totals','production_csv_same_scope_component_totals');
  // Synthetic append changes only the working copy, never the immutable snapshot.
  const targets=captured.filter(file=>file.complete).sort((a,b)=>b.bytes-a.bytes).slice(0,10).map(f=>join(working,f.relative));
  const appendFixture=index=>({type:'assistant',sessionId:'l1-benchmark-session',cwd:'/workspace/l1-benchmark',timestamp:new Date().toISOString(),requestId:`l1-benchmark-${index}`,message:{id:`l1-benchmark-${index}`,model:'fixture-model-benchmark',usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}}});
  const totalPath='/api/reports/usage?period=today&timezone=Asia%2FSeoul';
  let expectedTotal=BigInt((await request(totalPath)).total.total),counter=0;
  for(const width of [1,Math.min(10,targets.length)]){
    const times=[];
    for(let sample=0;sample<30;sample++){
      const started=performance.now();
      for(let file=0;file<width;file++){await fs.appendFile(targets[file],JSON.stringify(appendFixture(counter++))+'\n');expectedTotal+=15n;}
      for(let retry=0;;retry++){
        if(BigInt((await request(totalPath)).total.total)===expectedTotal)break;
        if(performance.now()-started>30000)throw new Error('append_visibility_timeout');await sleep(50);
      }
      times.push(performance.now()-started);
    }
    measurements.append.push({changedFiles:width,boundary:'producer append completed -> production HTTP report includes usage',...stats(times),pass:percentile(times,.95)<=5000});
    process.stdout.write(`Append ${width} file(s): p95 ${percentile(times,.95).toFixed(0)} ms\n`);
  }
  reconciliation.status='passed';measurements.status=[...measurements.query,...measurements.append].every(row=>row.pass)?'passed_measured_boundaries':'failed';
  if(process.env.CM_VERIFY_KEEP_FOR_BROWSER==='true'){
    const scratch=join(root,'.scratch');await fs.mkdir(scratch,{recursive:true});
    leasePath=join(scratch,'l1-benchmark-ready.json');const releasePath=join(scratch,`l1-benchmark-release-${process.pid}`);
    await fs.writeFile(leasePath,JSON.stringify({pid:process.pid,base,workingDir:working,dataDir,targets,releasePath,input:reconciliation.input},null,2),{mode:0o600,flag:'wx'});
    await fs.mkdir(evidence,{recursive:true});await fs.writeFile(join(evidence,'l1-reconciliation.json'),JSON.stringify(reconciliation,null,2)+'\n');await fs.writeFile(join(evidence,'l1-performance.json'),JSON.stringify(measurements,null,2)+'\n');
    process.stdout.write('Backend measurements complete; browser lease ready in .scratch/l1-benchmark-ready.json\n');
    const deadline=Date.now()+15*60*1000;
    while(!(await fs.stat(releasePath).catch(()=>null))){if(Date.now()>deadline)throw new Error('browser_lease_timeout');await sleep(500);}
    await fs.rm(releasePath,{force:true});
  }
} catch(error){reconciliation.status='failed';measurements.status='failed';reconciliation.failure=error instanceof Error?error.message.split('\n')[0]:'verification_failed';throw new Error(reconciliation.failure);}
finally{
  if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await Promise.race([once(server,'exit'),sleep(10000)]);if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await once(server,'exit');}}
  await fs.mkdir(evidence,{recursive:true});await fs.writeFile(join(evidence,'l1-reconciliation.json'),JSON.stringify(reconciliation,null,2)+'\n');await fs.writeFile(join(evidence,'l1-performance.json'),JSON.stringify(measurements,null,2)+'\n');
  await fs.rm(temporary,{recursive:true,force:true});
  if(leasePath)await fs.rm(leasePath,{force:true});
}
process.stdout.write(JSON.stringify({reconciliation:reconciliation.status,performance:measurements.status})+'\n');
