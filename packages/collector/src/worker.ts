import { parentPort, workerData } from 'node:worker_threads';
import { basename } from 'node:path';
import { diagnosticCode, type CollectorConfig } from './config.js';
import { openStorage, type Storage } from './storage.js';
import { LedgerIngestor } from './ingest.js';
import { installPricing, usageReport, reportCsv, projectsList, updateProject, requestEvidence, type ReportInput } from './report.js';
import { handleRuntimeRequest } from './runtime.js';
import { dispatchLocalRequest, LocalWorkError } from './local-work.js';
import { archiveProjects, dismissCandidate, mergeProject, monitorProjectMap, projectOverview, renameProject } from './project-management.js';
if(!parentPort) throw new Error('collector_worker_requires_parent');
const port=parentPort, config=workerData as CollectorConfig;
let store:Storage|undefined,stopping=false,scanFailed=false,timer:ReturnType<typeof setTimeout>|undefined;
let scanning:Promise<unknown>|null=null;
let requests=Promise.resolve();
async function dispatch(method:string,payload:unknown):Promise<unknown> {
  if(!store||stopping)throw new Error('collector_unavailable');
  const db=store.db;
  if(method==='report.usage')return usageReport(db,payload as ReportInput);
  if(method==='report.csv')return reportCsv(usageReport(db,payload as ReportInput));
  if(method==='report.evidence')return requestEvidence(db,payload);
  if(method==='projects.list')return projectsList(db);
  if(method==='projects.update')return updateProject(db,payload);
  if(method==='projects.overview')return projectOverview(db);
  if(method==='projects.rename')return renameProject(db,payload);
  if(method==='projects.merge')return mergeProject(db,payload);
  if(method==='projects.archive')return archiveProjects(db,payload);
  if(method==='projects.dismiss')return dismissCandidate(db,payload);
  if(method==='projects.monitorMap')return monitorProjectMap(db);
  if(method.startsWith('runtime.'))return handleRuntimeRequest(store,method,payload);
  if(method==='local.backup')return {backupName:basename(await store.backup())};
  if(method==='local.purge')return dispatchLocalRequest(db,method,{...(payload as object),backupName:basename(await store.backup())});
  if(method.startsWith('work.')||method.startsWith('local.'))return dispatchLocalRequest(db,method,payload);
  throw new LocalWorkError('unknown_method');
}
port.on('message',(message:{type?:string;requestId?:number;method?:string;payload?:unknown})=>{
  if(message.type==='stop') {
    stopping=true;if(timer)clearTimeout(timer);
    void Promise.all([scanning,requests]).finally(()=>{if(store)store.close();port.close();});
  } else if(message.type==='request') {
    requests=requests.then(async()=>{
      try {const result=await dispatch(message.method!,message.payload);port.postMessage({type:'response',requestId:message.requestId,result});}
      catch(error) {
        const code=(error as {code?:string})?.code??(error instanceof Error&&/^(invalid_runtime_|runtime_)/.test(error.message)?error.message:'request_failed');
        port.postMessage({type:'response',requestId:message.requestId,error:code});
      }
    });
  }
});
try {
  store=await openStorage(config);installPricing(store.db);
  if(stopping){store.close();port.close();}
  else {
    port.postMessage({type:'ready',deviceId:store.deviceId,schemaVersion:store.schemaVersion});
    const ingestor=new LedgerIngestor(store,config,{stopped:()=>stopping,onProgress:progress=>port.postMessage({type:'progress',progress})});
    const scan=()=>{scanning=ingestor.scan().catch(error=>{scanFailed=true;store!.db.prepare("UPDATE collector_scan SET state='error' WHERE id=1").run();port.postMessage({type:'progress',progress:{ingestionState:'error',diagnostic:diagnosticCode(error)}});}).finally(()=>{scanning=null;if(!stopping&&!scanFailed)timer=setTimeout(scan,config.pollMs);});};
    scan();
  }
} catch(error){port.postMessage({type:'error',diagnostic:diagnosticCode(error)});port.close();}
