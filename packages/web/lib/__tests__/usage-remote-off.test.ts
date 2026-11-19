import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
const exec = vi.hoisted(() => vi.fn());
const aggregateUsage = vi.hoisted(() => vi.fn(async () => ({ now: 123, sessions: 0 })));
vi.mock("node:child_process", () => ({ exec }));
vi.mock("../usage", () => ({ aggregateUsage }));
import { fetchOAuthUsage } from "../usage-remote";
import { GET } from "../../app/api/usage/route";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); exec.mockClear(); aggregateUsage.mockClear(); });
describe("local-only legacy usage boundary", () => {
  it.each([undefined, "false", "0", ""]) ("does not read Keychain or network when remote setting is %s", async setting => {
    vi.stubEnv("CM_REMOTE_USAGE_ENABLED", setting ?? ""); if (setting === undefined) delete process.env.CM_REMOTE_USAGE_ENABLED; const network = vi.fn(); vi.stubGlobal("fetch", network);
    expect(await fetchOAuthUsage()).toBeNull(); expect(exec).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it("legacy endpoint still returns local usage without touching account credentials", async () => {
    vi.stubEnv("CM_REMOTE_USAGE_ENABLED", "false"); vi.stubEnv("CM_BEARER_TOKEN", ""); const network = vi.fn(); vi.stubGlobal("fetch", network);
    const response = await GET(new Request("http://localhost/api/usage") as NextRequest);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({source:"estimate",api:null,now:123});
    expect(aggregateUsage).toHaveBeenCalledOnce(); expect(exec).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it("unauthorized calls cannot invoke local reads or remote credentials", async () => {
    vi.stubEnv("CM_REMOTE_USAGE_ENABLED", "true"); vi.stubEnv("CM_BEARER_TOKEN", "configured"); const network = vi.fn(); vi.stubGlobal("fetch", network);
    expect((await GET(new Request("http://localhost/api/usage") as NextRequest)).status).toBe(401);
    expect(aggregateUsage).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
});
