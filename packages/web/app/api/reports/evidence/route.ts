import { reportRead } from '../../../../lib/report-api';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const GET=(request:Request)=>reportRead(request,'report.evidence');
