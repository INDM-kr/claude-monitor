import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@claude-monitor/collector", () => ({ getProcessCollector: () => ({ request: rpc }) }));
import { GET, POST } from "../../app/api/work-items/route";
import { GET as settingsGet, POST as settingsPost } from "../../app/api/settings/route";
import { GET as diagnostics, POST as maintenance } from "../../app/api/maintenance/route";
function post(path: string, payload: unknown, extra: Record<string,string> = {}) { return new Request(`http://localhost/${path}`, {method:"POST",headers:{"content-type":"application/json",...extra},body:JSON.stringify(payload)}); }
beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({items:[]}); vi.stubEnv("CM_BEARER_TOKEN",""); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("local work and maintenance API", () => {
  it("protects read and mutation routes with the same Bearer policy and no-store", async () => {
    vi.stubEnv("CM_BEARER_TOKEN","fixture-token");
    expect((await GET(new Request("http://localhost/api/work-items"))).status).toBe(401);
    expect((await POST(post("api/work-items",{action:"create",title:"x"}))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    const response = await GET(new Request("http://localhost/api/work-items",{headers:{authorization:"Bearer fixture-token"}}));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rpc).toHaveBeenCalledWith("work.list",undefined);
  });
  it("rejects cross-origin browser writes, unknown actions, malformed bodies, and user-invented backup names", async () => {
    expect((await POST(post("api/work-items",{action:"create"},{origin:"https://evil.invalid"}))).status).toBe(403);
    expect((await POST(post("api/work-items",{action:"create"},{"sec-fetch-site":"cross-site"}))).status).toBe(403);
    expect((await POST(post("api/work-items",{action:"local.purge"}))).status).toBe(400);
    expect((await POST(new Request("http://localhost/api/work-items",{method:"POST",body:"{}"}))).status).toBe(415);
    expect((await POST(post("api/work-items",{action:"create",title:"a".repeat(17000)}))).status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
    expect((await maintenance(post("api/maintenance",{action:"purge",before:10,backupName:"forged",fingerprint:"fixture",confirmation:"DELETE LOCAL HISTORY"}))).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("local.purge",{before:10,fingerprint:"fixture",confirmation:"DELETE LOCAL HISTORY"});
  });
  it("uses the actual Host header when Next reconstructs an internal URL, without trusting forwarded hosts", async () => {
    const headers = {host:"127.0.0.1:11415",origin:"http://127.0.0.1:11415"};
    expect((await POST(post("api/work-items",{action:"create",title:"Local work"},headers))).status).toBe(200);
    expect((await POST(post("api/work-items",{action:"create",title:"x"},{...headers,origin:"http://other.invalid","x-forwarded-host":"other.invalid"}))).status).toBe(403);
    expect((await POST(post("api/work-items",{action:"create",title:"x"},{host:"rebind.invalid",origin:"http://rebind.invalid"}))).status).toBe(403);
  });
  it("returns useful input/conflict codes without leaking raw errors or arbitrary paths", async () => {
    rpc.mockRejectedValueOnce(Object.assign(new Error("private filepath"),{code:"artifact_required"}));
    expect((await POST(post("api/work-items",{action:"verify"}))).status).toBe(400);
    rpc.mockRejectedValueOnce(Object.assign(new Error("private filepath"),{code:"purge_preview_changed"}));
    expect((await maintenance(post("api/maintenance",{action:"purge"}))).status).toBe(409);
    rpc.mockRejectedValueOnce(new Error("/private/secret SQLITE_ERROR"));
    const response = await settingsGet(new Request("http://localhost/api/settings"));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({error:"collector_unavailable"});
  });
  it("dispatches settings, diagnostics, and backup without allowing caller-selected filesystem destinations", async () => {
    await settingsPost(post("api/settings",{action:"update",retentionDays:30}));
    expect(rpc).toHaveBeenLastCalledWith("local.updateSettings",{retentionDays:30});
    await diagnostics(new Request("http://localhost/api/maintenance"));
    expect(rpc).toHaveBeenLastCalledWith("local.diagnostics",undefined);
    await maintenance(post("api/maintenance",{action:"backup"}));
    expect(rpc).toHaveBeenLastCalledWith("local.backup",{});
  });
});
