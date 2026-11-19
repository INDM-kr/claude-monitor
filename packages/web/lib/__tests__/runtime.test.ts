import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeHookToken } from "@claude-monitor/collector/runtime-token";
const rpc = vi.hoisted(() => vi.fn(async () => ({ accepted: true })));
vi.mock("@claude-monitor/collector", () => ({ getProcessCollector: () => ({ request: rpc }) }));
import { POST } from "../../app/api/runtime/events/route";
import { GET } from "../../app/api/runs/route";
const request = (body: string, token = "test-hook-token") => new Request("http://localhost/api/runtime/events", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body });
afterEach(() => { vi.unstubAllEnvs(); rpc.mockClear(); });
describe("runtime API boundaries", () => {
  it("requires opt-in token even when normal local reads have no bearer configured", async () => {
    vi.stubEnv("CM_RUNTIME_HOOK_TOKEN", ""); expect((await POST(request("{}"))).status).toBe(503); expect(rpc).not.toHaveBeenCalled();
    vi.stubEnv("CM_RUNTIME_HOOK_TOKEN", "test-hook-token"); expect((await POST(request("{}", "wrong"))).status).toBe(401); expect(rpc).not.toHaveBeenCalled();
  });
  it("uses the private token file when the environment variable is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-web-hook-token-")); chmodSync(dir, 0o700);
    const saved = process.env.CM_RUNTIME_HOOK_TOKEN; delete process.env.CM_RUNTIME_HOOK_TOKEN;
    try {
      vi.stubEnv("CM_DATA_DIR", dir);
      expect((await POST(request("{}"))).status).toBe(503);
      const token = readFileSync(createRuntimeHookToken(process.env).path, "utf8");
      expect((await POST(request("{}", "wrong"))).status).toBe(401);
      expect((await POST(request('{"eventName":"Stop"}', token))).status).toBe(200);
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      if (saved !== undefined) process.env.CM_RUNTIME_HOOK_TOKEN = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("accepts authenticated JSON and bounds malformed/large input before RPC", async () => {
    vi.stubEnv("CM_RUNTIME_HOOK_TOKEN", "test-hook-token");
    expect((await POST(request("{"))).status).toBe(400); expect((await POST(request(" ".repeat(17000)))).status).toBe(413); expect(rpc).not.toHaveBeenCalled();
    const response = await POST(request('{"eventName":"Stop"}')); expect(response.status).toBe(200); expect(rpc).toHaveBeenCalledWith("runtime.record", { eventName: "Stop" });
  });
  it("applies configured bearer to runtime reads", async () => {
    vi.stubEnv("CM_BEARER_TOKEN", "reader"); expect((await GET(new Request("http://localhost/api/runs"))).status).toBe(401);
    const response = await GET(new Request("http://localhost/api/runs", { headers: { authorization: "Bearer reader" } })); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("does not leak collector exception details", async () => {
    vi.stubEnv("CM_RUNTIME_HOOK_TOKEN", "test-hook-token"); rpc.mockRejectedValueOnce(new Error("secret path"));
    const response = await POST(request("{}")); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "collector_unavailable" });
  });
});
