import { getProcessCollector } from '@claude-monitor/collector';
import { checkBearer, unauthorized } from './auth/middleware';
export async function reportRead(request:Request,method:string):Promise<Response> {
  if(!checkBearer(request).ok)return unauthorized();
  const p=new URL(request.url).searchParams;
  const payload:Record<string,unknown>={};
  for(const key of ['period','from','to','timezone','projectId','model','providerId','id'])if(p.has(key))payload[key]=p.get(key);
  for(const key of ['asOf','page'])if(p.has(key))payload[key]=Number(p.get(key));
  try {const data=await getProcessCollector().request(method,payload);return method==='report.csv'?new Response(String(data),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="usage.csv"','cache-control':'no-store'}}):Response.json(data,{headers:{'cache-control':'no-store'}});}
  catch(error){const code=(error as {code?:string})?.code??'collector_unavailable';return Response.json({error:code.startsWith('invalid_')?code:'collector_unavailable'},{status:code.startsWith('invalid_')?400:503,headers:{'cache-control':'no-store'}});}
}
