#!/usr/bin/env node
/** Optional request-count scale experiment, separate from the real-source SLO.
 * Synthesizes 110,000 valid responses (empty content), in owned temporary paths.
 * Source byte volume is intentionally reported: this is not a 10x transcript
 * byte-size simulation. Query samples call the compiled query service directly.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { loadCollectorConfig } from '../packages/collector/dist/config.js';
import { openStorage } from '../packages/collector/dist/storage.js';
import { LedgerIngestor } from '../packages/collector/dist/ingest.js';
import { usageReport,installPricing } from '../packages/collector/dist/report.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await fs.mkdtemp(join(tmpdir(),'cm-l1-scale-'));
await fs.chmod(temporary,0o700);
const config=loadCollectorConfig({CM_DATA_DIR:join(temporary,'data'),CLAUDE_PROJECTS_DIR:join(temporary,'projects'),CM_ENABLE_CODEX:'0',CM_TIMEZONE:'UTC'});
const COUNT=110000,PER_FILE=1000,SAMPLES=5;
const report={rssMetric:'Node process.resourceUsage().maxRSS (KiB) converted to bytes; self-process high-water mark, not a sum of samples',initialCurrentRssBytes:process.memoryUsage().rss,recordedAt:new Date().toISOString(),status:'running',seed:'l1-request-scale-v1',validResponses:COUNT,sourceBytes:0,sourceFiles:0,queryBoundary:'compiled service direct call; not HTTP',limitations:['Synthetic request-count scale only; empty content and smaller source bytes than a 10x transcript-volume workload.','Five warm samples are exploratory and do not establish support or a latency guarantee.','Peak RSS includes fixture generation and ingestion in one process.']};
let store;
try {
  await fs.mkdir(config.projectsDir,{recursive:true,mode:0o700});const timestamp=Date.now()-60000;
  for(let file=0;file<COUNT/PER_FILE;file++){
    let contents='';for(let line=0;line<PER_FILE;line++){const index=file*PER_FILE+line;contents+=JSON.stringify({type:'assistant',sessionId:`scale-session-${file}`,cwd:`/workspace/scale-${file%10}`,timestamp:new Date(timestamp-(index%30)*86400000).toISOString(),requestId:`scale-request-${index}`,message:{id:`scale-response-${index}`,model:'fixture-model-scale',content:[],usage:{input_tokens:100,output_tokens:50,cache_read_input_tokens:800,cache_creation_input_tokens:200,cache_creation:{ephemeral_5m_input_tokens:200,ephemeral_1h_input_tokens:0}}}})+'\n';}
    report.sourceBytes+=Buffer.byteLength(contents);report.sourceFiles++;await fs.writeFile(join(config.projectsDir,`scale-${file}.jsonl`),contents,{mode:0o600});
  }
  store=await openStorage(config);installPricing(store.db);const started=performance.now();await new LedgerIngestor(store,config).scan();report.coldIndexMs=performance.now()-started;report.coldPeakRssBytes=process.resourceUsage().maxRSS*1024;report.coldCurrentRssBytes=process.memoryUsage().rss;
  assert.equal(Number(store.db.prepare("SELECT count(*) n FROM usage_record WHERE validity='valid'").get().n),COUNT,'scale_request_count');
  const asOf=Date.now(),query=()=>usageReport(store.db,{period:'30',timezone:'UTC',asOf});
  const first=query();assert.equal(first.total.total,String(BigInt(COUNT)*1150n),'scale_exact_total');assert.equal(first.total.requests,COUNT,'scale_report_requests');
  const samples=[];report.queryCurrentRssBytes=[];for(let index=0;index<SAMPLES;index++){const start=performance.now();query();samples.push(performance.now()-start);report.queryCurrentRssBytes.push(process.memoryUsage().rss);}samples.sort((a,b)=>a-b);
  report.query={warmups:1,samples:SAMPLES,minMs:samples[0],p50Ms:samples[Math.ceil(SAMPLES*.5)-1],p95Ms:samples[Math.ceil(SAMPLES*.95)-1],maxMs:samples.at(-1)};
  report.peakRssBytes=process.resourceUsage().maxRSS*1024;report.storage={};for(const name of ['usage.sqlite','usage.sqlite-wal'])report.storage[name]=(await fs.stat(join(config.dataDir,name)).catch(()=>({size:0}))).size;
  report.status='measured';
} catch(error){report.status='failed';report.failure=error instanceof Error?error.message.split('\n')[0]:'scale_verification_failed';throw new Error(report.failure);}
finally {if(store)store.close();await fs.rm(temporary,{recursive:true,force:true});await fs.writeFile(join(root,'docs/specs/evidence/l1-scale.json'),JSON.stringify(report,null,2)+'\n');}
process.stdout.write(JSON.stringify(report)+'\n');
