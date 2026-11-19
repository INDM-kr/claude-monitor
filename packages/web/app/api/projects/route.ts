import { localRead,localWrite } from '../../../lib/local-api';
import { getDataSource } from '../../../lib/data-source/local';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const GET=(request:Request)=>localRead(request,'projects.list');
export async function POST(request:Request){
  const response=await localWrite(request,{map:'projects.update'});
  // Folder remaps regroup the live monitor too.
  if(response.ok)await getDataSource().applyProjectChanges();
  return response;
}
