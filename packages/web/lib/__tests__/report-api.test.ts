import { afterEach, describe, expect, it, vi } from "vitest";
const rpc=vi.hoisted(()=>vi.fn(async (_method: string, _payload?: unknown): Promise<unknown>=>({total:{total:"1150"}})));
vi.mock("@claude-monitor/collector",()=>({getProcessCollector:()=>({request:rpc,status:()=>({state:"ready"})})}));
import { GET } from "../../app/api/reports/usage/route";
import { GET as CSV } from "../../app/api/reports/usage.csv/route";
import { POST as MAP } from "../../app/api/projects/route";
import { GET as MANAGE_GET, POST as MANAGE } from "../../app/api/projects/manage/route";
afterEach(()=>{vi.unstubAllEnvs();rpc.mockReset();rpc.mockResolvedValue({total:{total:"1150"}});});
describe("report API scope and access",()=>{
  it("denies unauthenticated reads before collector access",async()=>{
    vi.stubEnv("CM_BEARER_TOKEN","secret"); const result=await GET(new Request("http://localhost/api/reports/usage")); expect(result.status).toBe(401);expect(rpc).not.toHaveBeenCalled();
  });
  it("forwards one explicit scope and never accepts arbitrary path parameters",async()=>{
    vi.stubEnv("CM_BEARER_TOKEN","");const result=await GET(new Request("http://localhost/api/reports/usage?period=30&timezone=Asia%2FSeoul&asOf=123&page=2&projectId=alpha&path=%2Fprivate%2Ffile"));
    expect(result.headers.get("cache-control")).toBe("no-store");expect(rpc).toHaveBeenCalledWith("report.usage",{period:"30",timezone:"Asia/Seoul",asOf:123,page:2,projectId:"alpha"});
  });
  it("preserves safe input diagnostics and suppresses raw collector exceptions",async()=>{
    vi.stubEnv("CM_BEARER_TOKEN","");rpc.mockRejectedValueOnce(Object.assign(new Error("private"),{code:"invalid_date"}));let result=await GET(new Request("http://localhost/api/reports/usage"));expect(result.status).toBe(400);expect(await result.json()).toEqual({error:"invalid_date"});
    rpc.mockRejectedValueOnce(new Error("/private/file"));result=await GET(new Request("http://localhost/api/reports/usage"));expect(result.status).toBe(503);expect(await result.json()).toEqual({error:"collector_unavailable"});
  });
  it("CSV uses the same query scope with download content type",async()=>{
    vi.stubEnv("CM_BEARER_TOKEN","");rpc.mockResolvedValueOnce("csv-data");const response=await CSV(new Request("http://localhost/api/reports/usage.csv?period=7&model=known"));expect(rpc).toHaveBeenCalledWith("report.csv",{period:"7",model:"known"});expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");expect(await response.text()).toBe("csv-data");
  });
  it("rejects cross-origin project mutations and honors auth",async()=>{
    vi.stubEnv("CM_BEARER_TOKEN","");const response=await MAP(new Request("http://localhost/api/projects",{method:"POST",headers:{"content-type":"application/json",origin:"https://evil.example"},body:'{"action":"map","workspaceId":"wa","projectId":null}'}));expect(response.status).toBe(403);expect(rpc).not.toHaveBeenCalled();
  });
  it("reports malformed project mapping input as input error rather than service failure",async()=>{
    vi.stubEnv("CM_BEARER_TOKEN","");rpc.mockRejectedValueOnce(Object.assign(new Error("invalid_label"),{code:"invalid_label"}));const response=await MAP(new Request("http://localhost/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:'{"action":"map","label":""}'}));expect(response.status).toBe(400);
  });
  it("routes project management writes to the collector and regroups the live monitor afterwards",async()=>{
    vi.stubEnv("CM_BEARER_TOKEN","");
    const post=(body:string)=>MANAGE(new Request("http://localhost/api/projects/manage",{method:"POST",headers:{"content-type":"application/json"},body}));
    rpc.mockResolvedValueOnce({projects:[],archived:[],candidates:[]}).mockResolvedValueOnce({workspaces:{},identities:{}});
    expect((await post('{"action":"merge","sourceId":"a","targetId":"b"}')).status).toBe(200);
    expect(rpc.mock.calls.map(c=>c[0])).toEqual(["projects.merge","projects.monitorMap"]);
    expect(rpc.mock.calls[0]![1]).toEqual({sourceId:"a",targetId:"b"});
    rpc.mockReset();rpc.mockRejectedValueOnce(Object.assign(new Error("project_not_empty"),{code:"project_not_empty"}));
    const refused=await post('{"action":"archive","projectIds":["a"],"archived":true}');
    expect([refused.status,await refused.json()]).toEqual([400,{error:"project_not_empty"}]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((await post('{"action":"delete","projectId":"a"}')).status).toBe(400);
    rpc.mockResolvedValueOnce({projects:[],archived:[],candidates:[]});
    expect((await MANAGE_GET(new Request("http://localhost/api/projects/manage"))).status).toBe(200);
    expect(rpc).toHaveBeenLastCalledWith("projects.overview",undefined);
  });
});
