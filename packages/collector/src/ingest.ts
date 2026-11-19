import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, basename, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { codexSessionIdFromPath, initialCodexUsageState, normalizeCodexUsageRecord, normalizeUsageRecord, reconcileUsageObservations, type CodexActivity, type CodexUsageState } from '@claude-monitor/adapter-claude-code';
import type { NormalizedUsageObservation, UsageDiagnostic, UsageRunIdentity } from '@claude-monitor/core';
import { DEFAULTS, type CollectorConfig } from './config.js';
import type { Storage } from './storage.js';
import { discoverProjects } from './project-discovery.js';
import { hookAgentId } from './run-identity.js';

export const encodeObservation = (o: NormalizedUsageObservation): string => JSON.stringify(o, (_,v) => typeof v === 'bigint' ? {integer:v.toString()} : v);
export const decodeObservation = (json: string): NormalizedUsageObservation => JSON.parse(json, (_,v) => v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.integer === 'string' ? BigInt(v.integer) : v);
const id = (s: string) => createHash('sha256').update(s).digest('hex');
type ProviderId = 'claude-code'|'codex';
const CLAUDE_CODE:ProviderId='claude-code', CODEX:ProviderId='codex';
const UNREADABLE=['ENOENT','EACCES','EPERM','ENOTDIR','ELOOP'];
const emptyHash = createHash('sha256').digest('hex');
export interface IngestionProgress { ingestionState: 'indexing'|'watching'|'partial'|'error'; sourceCount:number; lastScanAt:number|null; diagnosticCount:number }
export interface IngestOptions { onProgress?: (status:IngestionProgress)=>void; beforeCommit?:()=>void; afterCommit?:()=>void; stopped?:()=>boolean }

export class LedgerIngestor {
  private scanning = false;
  private readonly discoveredWorkspaces=new Set<string>();
  constructor(readonly store:Storage, readonly config:CollectorConfig, readonly options:IngestOptions={}) {}
  private diagnostic(source:string|null,generation:string|null,offset:number|null,code:string):void {
    const now=Date.now();
    this.store.db.prepare(`INSERT INTO ingestion_diagnostic VALUES(?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at,count=count+1`)
      .run(id(JSON.stringify([source,generation,offset,code])),source,generation,offset,code,now,now);
  }
  private async discover(directory:string, depth=0):Promise<string[]> {
    if(depth>8) return [];
    let entries;
    try { entries=await fs.readdir(directory,{withFileTypes:true}); }
    catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT' && depth===0) return []; throw error; }
    const result:string[]=[];
    for(const e of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if(e.isSymbolicLink()) continue;
      const path=join(directory,e.name);
      if(e.isDirectory()) result.push(...await this.discover(path,depth+1));
      else if(e.isFile() && e.name.endsWith('.jsonl')) result.push(path);
    }
    return result;
  }
  async scan():Promise<IngestionProgress> {
    if(this.scanning) throw new Error('scan_already_running');
    this.scanning=true;
    const progress:IngestionProgress={ingestionState:'indexing',sourceCount:0,lastScanAt:null,diagnosticCount:0};
    this.options.onProgress?.({...progress});
    try {
      const sources:[string,ProviderId][]=(await this.discover(this.config.projectsDir)).map(path=>[path,CLAUDE_CODE]);
      let partial=false;
      if(this.config.codexDir) {
        try { for(const path of await this.discover(this.config.codexDir)) if(codexSessionIdFromPath(path)) sources.push([path,CODEX]); }
        catch(error) {
          if(!UNREADABLE.includes((error as NodeJS.ErrnoException).code??'')) throw error;
          this.diagnostic(null,null,null,'source_discovery_failed'); partial=true;
        }
      }
      progress.sourceCount=sources.length;
      for(const [path,provider] of sources) {
        if(this.options.stopped?.()) break;
        try { partial=(await this.readSource(path,provider))||partial; }
        catch(error) {
          if(!['ENOENT','EACCES','EPERM','EISDIR','ELOOP'].includes((error as NodeJS.ErrnoException).code??'')) throw error;
          this.diagnostic(null,null,null,'source_read_failed'); partial=true;
        }
        await yieldTurn();
      }
      if(!this.options.stopped?.()) await discoverProjects(this.store,this.discoveredWorkspaces,undefined,{rules:this.config.projectRules});
      progress.ingestionState=partial?'partial':'watching';
    } catch(error) {
      if(!['ENOENT','EACCES','EPERM','ENOTDIR','ELOOP'].includes((error as NodeJS.ErrnoException).code??'')) throw error;
      this.diagnostic(null,null,null,'source_discovery_failed'); progress.ingestionState='error';
    }
    finally { this.scanning=false; }
    progress.lastScanAt=Date.now();
    progress.diagnosticCount=Number((this.store.db.prepare('SELECT count(*) AS n FROM ingestion_diagnostic').get() as {n:bigint}).n);
    this.store.db.prepare('UPDATE collector_scan SET last_scan_at=?,source_count=?,state=?,diagnostic_count=? WHERE id=1')
      .run(progress.lastScanAt,progress.sourceCount,progress.ingestionState,progress.diagnosticCount);
    this.options.onProgress?.({...progress});
    return progress;
  }
  private async readSource(path:string,provider:ProviderId):Promise<boolean> {
    const {db,deviceId}=this.store;
    const stat=await fs.lstat(path);
    if(!stat.isFile() || stat.isSymbolicLink()) return false;
    const signature=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
    const sourceId=id(`${deviceId}:${path}`);
    const prior=db.prepare('SELECT stat_signature FROM source WHERE id=?').get(sourceId) as {stat_signature:string}|undefined;
    if(prior?.stat_signature===signature) return false;
    db.prepare(`INSERT INTO source(id,device_id,provider_id,local_path,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(sourceId,deviceId,provider,path,Date.now());
    let gen=db.prepare(`SELECT g.*,c.complete_byte_offset,c.verified_prefix_hash FROM source_generation g JOIN checkpoint c ON c.generation_id=g.id WHERE source_id=? ORDER BY generation DESC LIMIT 1`).get(sourceId) as {id:string;generation:bigint;file_identity:string;complete_byte_offset:bigint;verified_prefix_hash:string}|undefined;
    const handle=await fs.open(path,'r');
    try {
      const identity=`${stat.dev}:${stat.ino}`;
      let offset=Number(gen?.complete_byte_offset??0);
      let hash=createHash('sha256');
      const buffer=Buffer.alloc(DEFAULTS.readChunkBytes);
      let checked=0;
      if(gen && gen.file_identity===identity && stat.size>=offset) {
        while(checked<offset) {
          const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,offset-checked),checked);
          if(!bytesRead) break;
          hash.update(buffer.subarray(0,bytesRead)); checked+=bytesRead;
        }
      }
      if(!gen || gen.file_identity!==identity || stat.size<offset || checked!==offset || hash.copy().digest('hex')!==gen.verified_prefix_hash) {
        const generation=Number(gen?.generation??-1)+1;
        gen={id:randomUUID(),generation:BigInt(generation),file_identity:identity,complete_byte_offset:0n,verified_prefix_hash:emptyHash};
        db.prepare('INSERT INTO source_generation VALUES(?,?,?,?,?,?,?)').run(gen.id,sourceId,generation,identity,stat.size,Math.floor(stat.mtimeMs),emptyHash);
        db.prepare('INSERT INTO checkpoint VALUES(?,0,?,?)').run(gen.id,emptyHash,Date.now());
        offset=0;hash=createHash('sha256');
      }
      // Codex usage lines need the file's thread/turn context; resume it with the checkpoint or re-read from the start.
      let codexState:CodexUsageState|null=null;
      if(provider===CODEX) {
        const saved=offset>0?db.prepare('SELECT context_json FROM source_context WHERE generation_id=?').get(gen.id) as {context_json:string}|undefined:undefined;
        if(offset>0&&!saved) {offset=0;hash=createHash('sha256');}
        codexState=saved?JSON.parse(saved.context_json) as CodexUsageState:initialCodexUsageState();
      }
      let cursor=offset, pending=Buffer.alloc(0), lineStart=offset, skipOversize=false, discardedBytes=0;
      let completePrefixHash=hash.copy().digest('hex');
      let batch:{start:number;end:number;record:unknown;error?:string}[]=[];
      const commit=()=>{
        if(!batch.length) return;
        const items=batch;batch=[];
        const prefixHash=completePrefixHash;
        this.store.transaction(()=>{
          const affected=new Set<string>();
          for(const line of items) {
            if(line.error) {this.diagnostic(sourceId,gen!.id,line.start,line.error);continue;}
            const context={deviceId,sourceId,sourcePath:path,generation:Number(gen!.generation),byteStart:line.start,byteEnd:line.end,ingestedAt:Date.now()};
            let normalized:{observation:NormalizedUsageObservation|null;diagnostics:UsageDiagnostic[]};
            if(codexState) {const step=normalizeCodexUsageRecord(line.record,context,codexState);if(step.activity)this.recordActivity(step.activity);normalized=step;}
            else normalized=normalizeUsageRecord(line.record,context);
            for(const d of normalized.diagnostics) this.diagnostic(sourceId,gen!.id,d.byteStart,d.code);
            const o=normalized.observation;if(!o) continue;
            if(db.prepare('SELECT 1 FROM usage_excluded_response WHERE device_id=? AND provider_id=? AND response_id=?').get(deviceId,o.providerId,o.responseId)) continue;
            const observationId=id(`${gen!.id}:${line.start}`), encoded=encodeObservation(o);
            db.prepare(`INSERT OR IGNORE INTO usage_observation(id,source_generation_id,byte_start,byte_end,record_id,response_id,request_id,event_at,observed_at,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_write_5m,cache_write_1h,service_tier,inference_geo,speed,parser_version,digest,normalized_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(observationId,gen!.id,line.start,line.end,o.recordId,o.responseId,o.requestId,o.eventAt,o.ingestedAt,o.model,o.tokens.input,o.tokens.output,o.tokens.cacheRead,o.tokens.cacheWrite,o.cache5m,o.cache1h,o.serviceTier,o.inferenceGeo,o.speed,o.parserVersion,id(encoded),encoded);
            affected.add(o.responseId);
          }
          for(const responseId of affected) this.reconcile(responseId,provider);
          if(codexState) db.prepare('INSERT INTO source_context VALUES(?,?) ON CONFLICT(generation_id) DO UPDATE SET context_json=excluded.context_json').run(gen!.id,JSON.stringify(codexState));
          db.prepare('UPDATE checkpoint SET complete_byte_offset=?,verified_prefix_hash=?,updated_at=? WHERE generation_id=?').run(items.at(-1)!.end,prefixHash,Date.now(),gen!.id);
          db.prepare('UPDATE metadata SET ingestion_epoch=ingestion_epoch+1 WHERE id=1').run();
          this.options.beforeCommit?.();
        });
        this.options.afterCommit?.();
      };
      while(cursor<stat.size && !this.options.stopped?.()) {
        const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,stat.size-cursor),cursor);
        if(!bytesRead) break;
        cursor+=bytesRead;
        pending=Buffer.concat([pending,buffer.subarray(0,bytesRead)]);
        let newline:number;
        while((newline=pending.indexOf(10))>=0) {
          const bytes=pending.subarray(0,newline+1);hash.update(bytes);
          const end=lineStart+discardedBytes+bytes.length;
          completePrefixHash=hash.copy().digest('hex');
          let record:unknown=null,error:string|undefined;
          if(skipOversize || bytes.length>DEFAULTS.maxLineBytes) error='line_too_large';
          else try { record=JSON.parse(bytes.toString('utf8')); } catch {error='malformed_json';}
          batch.push({start:lineStart,end,record,error});
          pending=pending.subarray(newline+1);lineStart=end;skipOversize=false;discardedBytes=0;
          if(batch.length>=this.config.batchSize) {commit();await yieldTurn();}
        }
        if(pending.length>DEFAULTS.maxLineBytes) {
          // Consume oversized data without retaining transcript contents in memory.
          hash.update(pending);discardedBytes+=pending.length;pending=Buffer.alloc(0);skipOversize=true;
        }
      }
      commit();
      const partial=pending.length>0||skipOversize;
      if(!partial && !this.options.stopped?.()) db.prepare('UPDATE source SET stat_signature=? WHERE id=?').run(signature,sourceId);
      return partial;
    } finally {await handle.close();}
  }
  /** Codex rollout activity keeps one latest observation per run (hooks append; the rollout is re-derivable). */
  private recordActivity(activity:CodexActivity):void {
    if(activity.run.internal) return;
    const runId=this.ensureRun(CODEX,activity.run,this.workspaceFor(activity.cwd));
    this.store.db.prepare(`INSERT INTO runtime_observation(id,run_id,event_name,observed_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET event_name=excluded.event_name,observed_at=excluded.observed_at WHERE excluded.observed_at>=runtime_observation.observed_at`)
      .run(`codex-rollout:${runId}`,runId,activity.eventName,activity.observedAt);
  }
  private workspaceFor(cwd:string|null):string|null {
    if(!cwd) return null;
    const {db,deviceId}=this.store;
    const path=resolve(cwd),workspaceId=id(`${deviceId}:${path}`);
    if(!db.prepare('SELECT id FROM workspace WHERE id=?').get(workspaceId)) {
      const projectId=randomUUID();
      db.prepare('INSERT INTO project VALUES(?,?,NULL)').run(projectId,basename(path)||'Project');
      db.prepare("INSERT INTO workspace VALUES(?,?,?,?,?,'automatic')").run(workspaceId,deviceId,path,null,projectId);
    }
    return workspaceId;
  }
  private ensureRun(providerId:string,run:UsageRunIdentity,workspaceId:string|null):string {
    const {db,deviceId}=this.store;
    const rootNativeSession=run.parentNativeSessionId??run.nativeSessionId;
    const existingRoot=db.prepare("SELECT id FROM run WHERE device_id=? AND provider_id=? AND native_session_id=? AND parent_run_id IS NULL AND native_agent_id IS NULL").get(deviceId,providerId,rootNativeSession) as {id:string}|undefined;
    const rootKey=existingRoot?.id??run.parentKey??run.key;
    if(!existingRoot) db.prepare(`INSERT INTO run VALUES(?,?,?,?,NULL,NULL,?)`).run(rootKey,deviceId,providerId,rootNativeSession,workspaceId);
    let runId=rootKey;
    if(run.parentKey) {
      const childQuery=db.prepare("SELECT id FROM run WHERE device_id=? AND provider_id=? AND native_session_id=? AND parent_run_id=? AND native_agent_id=?");
      let existingChild=childQuery.get(deviceId,providerId,run.nativeSessionId,rootKey,run.nativeAgentId) as {id:string}|undefined;
      // A hook may have created this child first under the bare agent id; adopt it with the transcript identity.
      const bareAgent=hookAgentId(run.nativeAgentId!);
      if(!existingChild&&bareAgent!==run.nativeAgentId){
        existingChild=childQuery.get(deviceId,providerId,run.nativeSessionId,rootKey,bareAgent) as {id:string}|undefined;
        if(existingChild) db.prepare('UPDATE run SET native_agent_id=? WHERE id=?').run(run.nativeAgentId,existingChild.id);
      }
      runId=existingChild?.id??run.key;
      if(!existingChild) db.prepare(`INSERT INTO run VALUES(?,?,?,?,?,?,?)`).run(runId,deviceId,providerId,run.nativeSessionId,run.nativeAgentId,rootKey,workspaceId);
    }
    if(workspaceId){db.prepare('UPDATE run SET workspace_id=? WHERE id=? AND workspace_id IS NULL').run(workspaceId,rootKey);if(runId!==rootKey)db.prepare('UPDATE run SET workspace_id=? WHERE id=? AND workspace_id IS NULL').run(workspaceId,runId);}
    return runId;
  }
  private reconcile(responseId:string,providerId:ProviderId):void {
    const {db,deviceId}=this.store;
    // Response ids are only unique within a provider.
    const rows=db.prepare(`SELECT o.id,o.normalized_json FROM usage_observation o JOIN source_generation g ON g.id=o.source_generation_id JOIN source s ON s.id=g.source_id
      WHERE o.response_id=? AND s.provider_id=? AND o.normalized_json IS NOT NULL`).all(responseId,providerId) as {id:string;normalized_json:string}[];
    const observations=rows.map(r=>decodeObservation(r.normalized_json));
    const result=reconcileUsageObservations(observations);
    for(const d of result.diagnostics) this.diagnostic(d.sourceId,null,d.byteStart,d.code);
    const o=result.records[0];if(!o) return;
    const excluded=db.prepare('SELECT 1 FROM usage_excluded_response WHERE device_id=? AND provider_id=? AND response_id=?').get(deviceId,o.providerId,responseId)
      ||db.prepare('SELECT 1 FROM usage_exclusion WHERE ? >= from_at AND ? < to_at LIMIT 1').get(o.firstEventAt,o.firstEventAt);
    if(excluded) {
      db.prepare('INSERT OR IGNORE INTO usage_excluded_response VALUES(?,?,?,?)').run(deviceId,o.providerId,responseId,Date.now());
      db.prepare('DELETE FROM usage_source_link WHERE usage_id IN (SELECT id FROM usage_record WHERE device_id=? AND provider_id=? AND response_id=?)').run(deviceId,o.providerId,responseId);
      db.prepare('DELETE FROM usage_record WHERE device_id=? AND provider_id=? AND response_id=?').run(deviceId,o.providerId,responseId);
      db.prepare('DELETE FROM usage_observation WHERE response_id=? AND source_generation_id IN (SELECT g.id FROM source_generation g JOIN source s ON s.id=g.source_id WHERE s.device_id=? AND s.provider_id=?)').run(responseId,deviceId,o.providerId);
      return;
    }
    const workspaceId=o.attributionConflict?null:this.workspaceFor(o.cwd);
    const runId=o.run.internal?null:this.ensureRun(o.providerId,o.run,workspaceId);
    const selected=rows.find((_,i)=>observations[i]!.sourceId===o.sourceId && observations[i]!.generation===o.generation && observations[i]!.byteStart===o.byteStart)!.id;
    const usageId=id(o.identityKey);
    db.prepare(`INSERT INTO usage_record VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(device_id,provider_id,response_id) DO UPDATE SET request_id=excluded.request_id,run_id=excluded.run_id,workspace_id=excluded.workspace_id,model=excluded.model,first_event_at=excluded.first_event_at,snapshot_at=excluded.snapshot_at,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cache_read_tokens=excluded.cache_read_tokens,cache_write_tokens=excluded.cache_write_tokens,cache_write_5m=excluded.cache_write_5m,cache_write_1h=excluded.cache_write_1h,validity=excluded.validity,cost_eligibility=excluded.cost_eligibility,parser_version=excluded.parser_version,snapshot_observation_id=excluded.snapshot_observation_id`)
      .run(usageId,deviceId,o.providerId,o.responseId,o.requestId,o.attributionConflict?null:runId,workspaceId,o.model,o.firstEventAt,o.snapshotAt,o.tokens.input,o.tokens.output,o.tokens.cacheRead,o.tokens.cacheWrite,o.cache5m,o.cache1h,o.validity,o.costEligibility,o.parserVersion,selected);
    for(const row of rows) db.prepare('INSERT OR IGNORE INTO usage_source_link VALUES(?,?)').run(usageId,row.id);
    // metadata.parser_version keeps describing the Claude Code parser; each provider row carries its own.
    if(providerId===CLAUDE_CODE) db.prepare('UPDATE metadata SET parser_version=? WHERE id=1').run(o.parserVersion);
    db.prepare("UPDATE provider SET adapter_version=?, capabilities='[\"usage\"]' WHERE id=?").run(o.parserVersion,providerId);
  }
}
