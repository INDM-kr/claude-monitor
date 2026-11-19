import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CollectorError } from './config.js';
import { PRICING } from './pricing.js';

const DAY=86400000;
const MAX_DAYS=366;
export interface ReportInput {period?:string;from?:string;to?:string;timezone?:string;asOf?:number;projectId?:string;model?:string;providerId?:string;page?:number}
export interface ReportScope {from:number;to:number;asOf:number;timezone:string;period:string;projectId:string|null;model:string|null;providerId:string|null}
const DATE_FORMATTER_CACHE_LIMIT=32;
const dateFormatters=new Map<string,Intl.DateTimeFormat>();
/** ICU formatters allocate native memory; reuse one per timezone across rows. */
export function dateAt(time:number,tz:string):string {
  let formatter=dateFormatters.get(tz);
  if(!formatter){
    formatter=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
    dateFormatters.set(tz,formatter);
    if(dateFormatters.size>DATE_FORMATTER_CACHE_LIMIT)dateFormatters.delete(dateFormatters.keys().next().value!);
  }
  return formatter.format(time);
}
function shift(date:string,days:number):string {return new Date(Date.parse(date+'T12:00:00Z')+days*DAY).toISOString().slice(0,10);}
export function zonedMidnight(date:string,tz:string):number {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) throw new CollectorError('invalid_date');
  const target=Date.parse(date+'T00:00:00Z');let guess=target;
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let i=0;i<5;i++) {const p=Object.fromEntries(formatter.formatToParts(guess).map(p=>[p.type,p.value]));const displayed=Date.UTC(+p.year!,+p.month!-1,+p.day!,+p.hour!,+p.minute!,+p.second!);const delta=target-displayed;if(!delta)return guess;guess+=delta;}
  // Some zones skip midnight. Locate first instant of that calendar day.
  let low=target-DAY,high=target+DAY;
  while(high-low>1){const mid=Math.floor((low+high)/2);if(dateAt(mid,tz)<date)low=mid;else high=mid;}
  if(dateAt(high,tz)!==date) throw new CollectorError('invalid_date');return high;
}
export function resolveReportScope(input:ReportInput={},now=Date.now(),defaultTimezone='UTC'):ReportScope {
  const timezone=input.timezone||defaultTimezone;
  try {new Intl.DateTimeFormat('en',{timeZone:timezone});} catch {throw new CollectorError('invalid_timezone');}
  const asOf=input.asOf??now;if(!Number.isSafeInteger(asOf)||asOf>now||asOf<0)throw new CollectorError('invalid_as_of');
  const period=input.period??'7';if(!['today','7','30','custom'].includes(period))throw new CollectorError('invalid_period');
  const today=dateAt(asOf,timezone);
  const start=period==='custom'?input.from:shift(today,-(period==='today'?1:Number(period))+1);
  const end=period==='custom'?input.to:shift(today,1);
  if(!start||!end)throw new CollectorError('invalid_date');
  if(period==='custom'&&end<start)throw new CollectorError('invalid_range');
  const from=zonedMidnight(start,timezone);
  const inclusiveEnd=period==='custom'?(zonedMidnight(end,timezone),shift(end,1)):end;
  const to=Math.min(zonedMidnight(inclusiveEnd,timezone),asOf);
  if(to<from||to-from>MAX_DAYS*DAY+DAY)throw new CollectorError('invalid_range');
  for(const value of [input.projectId,input.model,input.providerId]) if(value!==undefined && (typeof value!=='string'||!value.length||value.length>250))throw new CollectorError('invalid_filter');
  return {from,to,asOf,timezone,period,projectId:input.projectId??null,model:input.model??null,providerId:input.providerId??null};
}
function previousPeriodEnd(to:number,days:number,timezone:string):number {
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const parts=Object.fromEntries(formatter.formatToParts(to).map(p=>[p.type,p.value]));
  const date=shift(dateAt(to,timezone),-days),target=Date.parse(date+'T00:00:00Z')+(Number(parts.hour)*3600+Number(parts.minute)*60+Number(parts.second))*1000+to%1000;
  let guess=target;
  for(let i=0;i<5;i++){const p=Object.fromEntries(formatter.formatToParts(guess).map(p=>[p.type,p.value]));const displayed=Date.UTC(+p.year!,+p.month!-1,+p.day!,+p.hour!,+p.minute!,+p.second!)+guess%1000;const delta=target-displayed;if(!delta)return guess;guess+=delta;}
  return guess;
}
interface LedgerRow {id:string;provider_id:string;response_id:string;request_id:string|null;run_id:string|null;model:string;first_event_at:bigint;snapshot_at:bigint;input_tokens:bigint;output_tokens:bigint;cache_read_tokens:bigint;cache_write_tokens:bigint;cache_write_5m:bigint|null;cache_write_1h:bigint|null;cost_eligibility:string;validity:string;project_id:string|null;project_label:string|null}
interface Amount {input:bigint;output:bigint;cacheRead:bigint;cacheWrite:bigint;total:bigint;requests:number;pricedRequests:number;nanoUsd:bigint;unpriced:Record<string,number>}
const zero=():Amount=>({input:0n,output:0n,cacheRead:0n,cacheWrite:0n,total:0n,requests:0,pricedRequests:0,nanoUsd:0n,unpriced:{}});
const usd=(n:bigint)=>`${n/1000000000n}.${(n%1000000000n).toString().padStart(9,'0')}`;
function add(a:Amount,r:LedgerRow):void {
  a.requests++;a.input+=r.input_tokens;a.output+=r.output_tokens;a.cacheRead+=r.cache_read_tokens;a.cacheWrite+=r.cache_write_tokens;
  a.total+=r.input_tokens+r.output_tokens+r.cache_read_tokens+r.cache_write_tokens;
  const rates=PRICING.rates[r.model];
  const reason=!rates?'unknown_model':r.cost_eligibility!=='eligible'?r.cost_eligibility:null;
  if(reason){a.unpriced[reason]=(a.unpriced[reason]??0)+1;return;}
  a.pricedRequests++;
  a.nanoUsd+=r.input_tokens*BigInt(rates![0]!)+r.output_tokens*BigInt(rates![1]!)+r.cache_read_tokens*BigInt(rates![2]!)+(r.cache_write_5m??0n)*BigInt(rates![3]!)+(r.cache_write_1h??0n)*BigInt(rates![4]!);
}
const dto=(a:Amount)=>({input:a.input.toString(),output:a.output.toString(),cacheRead:a.cacheRead.toString(),cacheWrite:a.cacheWrite.toString(),total:a.total.toString(),requests:a.requests,pricedRequests:a.pricedRequests,costUsd:a.pricedRequests===0&&a.requests>0?null:usd(a.nanoUsd),coverage:a.requests?a.pricedRequests/a.requests:null,unpriced:a.unpriced});
export function installPricing(db:Database.Database):void {
  db.prepare("INSERT OR IGNORE INTO pricing_version VALUES(?,?,?,'standard_equivalent','USD')").run(PRICING.version,PRICING.source,PRICING.retrievedAt);
  for(const [model,rates] of Object.entries(PRICING.rates)) for(const [i,component] of ['input','output','cache_read','cache_write_5m','cache_write_1h'].entries()) db.prepare('INSERT OR IGNORE INTO pricing_rate VALUES(?,?,?,?,?)').run(PRICING.version,model,component,rates[i],1000000000);
}
export function usageReport(db:Database.Database,input:ReportInput={},now=Date.now()) {
  return db.transaction(()=>{
    const metadata=db.prepare('SELECT timezone,mapping_revision,ingestion_epoch FROM metadata WHERE id=1').get() as {timezone:string;mapping_revision:bigint;ingestion_epoch:bigint};
    const scope=resolveReportScope(input,now,metadata.timezone);
    const select=(from:number,to:number)=>db.prepare(`SELECT u.*,w.project_id,p.label AS project_label FROM usage_record u LEFT JOIN workspace w ON w.id=u.workspace_id LEFT JOIN project p ON p.id=w.project_id WHERE u.first_event_at>=? AND u.first_event_at<? AND u.snapshot_at<=? AND (? IS NULL OR coalesce(w.project_id,'unassigned')=?) AND (? IS NULL OR u.model=?) AND (? IS NULL OR u.provider_id=?) ORDER BY u.first_event_at,u.id`).all(from,to,scope.asOf,scope.projectId,scope.projectId,scope.model,scope.model,scope.providerId,scope.providerId) as LedgerRow[];
    const rows=select(scope.from,scope.to),valid=rows.filter(r=>r.validity==='valid');
    const total=zero(),projects=new Map<string,{id:string;label:string;amount:Amount}>(),models=new Map<string,Amount>(),days=new Map<string,Amount>();
    for(let d=dateAt(scope.from,scope.timezone);d<=dateAt(scope.to===scope.asOf?scope.to:scope.to-1,scope.timezone);d=shift(d,1))days.set(d,zero());
    for(const r of valid) {add(total,r);const key=r.project_id??'unassigned';if(!projects.has(key))projects.set(key,{id:key,label:r.project_label??'미분류',amount:zero()});add(projects.get(key)!.amount,r);if(!models.has(r.model))models.set(r.model,zero());add(models.get(r.model)!,r);add(days.get(dateAt(Number(r.first_event_at),scope.timezone))!,r);}
    const startDay=dateAt(scope.from,scope.timezone),endDay=dateAt(scope.to===scope.asOf?scope.to:scope.to-1,scope.timezone);
    const calendarDays=Math.round((Date.parse(endDay)-Date.parse(startDay))/DAY)+1;
    const previousFrom=zonedMidnight(shift(startDay,-calendarDays),scope.timezone);
    const previousTo=previousPeriodEnd(scope.to,calendarDays,scope.timezone);
    const earliest=(db.prepare("SELECT MIN(first_event_at) AS at FROM usage_record WHERE validity='valid'").get() as {at:bigint|null}).at;
    const previousComplete=earliest!==null&&Number(earliest)<=previousFrom;
    const previous=zero();for(const r of select(previousFrom,previousTo))if(r.validity==='valid')add(previous,r);
    const scan=db.prepare('SELECT * FROM collector_scan WHERE id=1').get() as {state:string;last_scan_at:bigint|null;source_count:bigint;diagnostic_count:bigint};
    const diagnostics=db.prepare('SELECT code,count(*) AS count FROM ingestion_diagnostic GROUP BY code ORDER BY code').all() as {code:string;count:bigint}[];
    const page=input.page??0;if(!Number.isSafeInteger(page)||page<0||page>1000000)throw new CollectorError('invalid_page');
    return {scope,mappingRevision:metadata.mapping_revision.toString(),ingestionEpoch:metadata.ingestion_epoch.toString(),pricing:{version:PRICING.version,basis:'standard_equivalent',currency:'USD',source:PRICING.source,retrievedAt:PRICING.retrievedAt},total:dto(total),projects:[...projects.values()].sort((a,b)=>a.amount.total>b.amount.total?-1:a.amount.total<b.amount.total?1:0).map(p=>({id:p.id,label:p.label,...dto(p.amount)})),models:[...models].map(([model,a])=>({model,...dto(a)})),days:[...days].map(([date,a])=>({date,...dto(a)})),previous:{from:previousFrom,to:previousTo,...dto(previous),complete:previousComplete,changePercent:previous.total===0n||!previousComplete||scan.state!=='watching'||diagnostics.length?null:Number((total.total-previous.total)*10000n/previous.total)/100},sourceScope:{provider:scope.providerId??'all',storage:'local_ledger',includesRetainedHistory:true},unpricedCount:total.requests-total.pricedRequests,incompleteUsageCount:Number((db.prepare("SELECT count(*) n FROM (SELECT generation_id,byte_offset FROM ingestion_diagnostic WHERE code IN ('missing_message_id','missing_response_id','missing_session_id','missing_model','missing_timestamp','invalid_timestamp','missing_usage','missing_token','invalid_token','unsafe_token_integer','malformed_json','line_too_large') GROUP BY generation_id,byte_offset)").get() as {n:bigint}).n),quality:{state:scan.state,lastScanAt:scan.last_scan_at===null?null:Number(scan.last_scan_at),sourceCount:Number(scan.source_count),diagnostics:diagnostics.map(d=>({code:d.code,count:Number(d.count)})),conflicts:rows.length-valid.length},requests:{page,pageSize:50,count:rows.length,items:rows.slice(page*50,page*50+50).map(r=>({id:r.id,providerId:r.provider_id,responseId:r.response_id,requestId:r.request_id,runId:r.run_id,model:r.model,eventAt:Number(r.first_event_at),snapshotAt:Number(r.snapshot_at),validity:r.validity,costEligibility:r.cost_eligibility,project:r.project_label??'미분류',...dto((()=>{const a=zero();if(r.validity==='valid')add(a,r);return a;})())}))}};
  })();
}
export type UsageReport=ReturnType<typeof usageReport>;
function csvCell(value:unknown):string {let s=String(value??'');if(/^(?:[\t\r\n]|\s*[=+\-@])/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function reportCsv(report:UsageReport):string {
  const head=['project_id','project','input','output','cache_read','cache_write','total','requests','priced_requests','cost_usd','unpriced_reasons','from','to','timezone','as_of','mapping_revision','pricing_version','basis'];
  return '\uFEFF'+[head,...report.projects.map(p=>[p.id,p.label,p.input,p.output,p.cacheRead,p.cacheWrite,p.total,p.requests,p.pricedRequests,p.costUsd,JSON.stringify(p.unpriced),new Date(report.scope.from).toISOString(),new Date(report.scope.to).toISOString(),report.scope.timezone,new Date(report.scope.asOf).toISOString(),report.mappingRevision,report.pricing.version,report.pricing.basis])].map(r=>r.map(csvCell).join(',')).join('\r\n');
}
export function projectsList(db:Database.Database) {
  return {projects:db.prepare('SELECT id,label FROM project WHERE archived_at IS NULL ORDER BY label,id').all(),workspaces:db.prepare("SELECT w.id,w.project_id AS projectId,w.mapping_source AS mappingSource,w.canonical_cwd AS cwd,p.label AS projectLabel FROM workspace w LEFT JOIN project p ON w.project_id=p.id ORDER BY w.canonical_cwd").all()};
}
export function updateProject(db:Database.Database,input:unknown) {
  if(!input||typeof input!=='object')throw new CollectorError('invalid_project');
  const p=input as {label?:unknown;workspaceId?:unknown;projectId?:unknown};
  return db.transaction(()=>{
    let projectId=p.projectId;
    if(p.label!==undefined){if(typeof p.label!=='string'||!p.label.trim()||p.label.length>120)throw new CollectorError('invalid_label');projectId=randomUUID();db.prepare('INSERT INTO project VALUES(?,?,NULL)').run(projectId,p.label.trim());}
    if(p.workspaceId!==undefined){if(typeof p.workspaceId!=='string'||!db.prepare('SELECT 1 FROM workspace WHERE id=?').get(p.workspaceId))throw new CollectorError('unknown_workspace');if(projectId!==null&&(typeof projectId!=='string'||!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId)))throw new CollectorError('unknown_project');db.prepare("UPDATE workspace SET project_id=?,mapping_source='manual' WHERE id=?").run(projectId,p.workspaceId);db.prepare('UPDATE metadata SET mapping_revision=mapping_revision+1 WHERE id=1').run();}
    else if(p.label===undefined)throw new CollectorError('invalid_project');
    return projectsList(db);
  })();
}
export function requestEvidence(db:Database.Database,input:unknown) {
  const id=(input as {id?:unknown})?.id;if(typeof id!=='string'||id.length>250)throw new CollectorError('invalid_id');
  const observations=db.prepare(`SELECT s.id AS sourceId,g.generation,o.byte_start AS byteStart,o.byte_end AS byteEnd,o.event_at AS eventAt,o.parser_version AS parserVersion,o.digest FROM usage_source_link l JOIN usage_observation o ON o.id=l.observation_id JOIN source_generation g ON g.id=o.source_generation_id JOIN source s ON s.id=g.source_id WHERE l.usage_id=? ORDER BY g.generation,o.byte_start LIMIT 100`).all(id);
  return JSON.parse(JSON.stringify({observations},(_,v)=>typeof v==='bigint'?v.toString():v));
}
