import { localRead,localWrite } from '../../../../lib/local-api';
import { getDataSource } from '../../../../lib/data-source/local';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const GET=(request:Request)=>localRead(request,'projects.overview');
export async function POST(request:Request){
  const response=await localWrite(request,{rename:'projects.rename',merge:'projects.merge',archive:'projects.archive',dismiss:'projects.dismiss'});
  // The live monitor groups by the same mapping; regroup open dashboards right away.
  if(response.ok)await getDataSource().applyProjectChanges();
  return response;
}
