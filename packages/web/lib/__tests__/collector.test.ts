import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../collector", () => ({ collectorStatus: () => ({ state: "ready", ingestionState: "not_started", schemaVersion: 1, deviceId: "fixture-device", workerId: 1, diagnostic: null }) }));
import { GET } from "../../app/api/collector/route";

afterEach(() => { vi.unstubAllEnvs(); });
describe("collector status API", () => {
  it("returns no-store lifecycle status without implying ingestion completed", async () => {
    vi.stubEnv("CM_BEARER_TOKEN", "");
    const response = await GET(new Request("http://localhost/api/collector"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ state: "ready", ingestionState: "not_started" });
  });
  it("applies the existing Bearer policy", async () => {
    vi.stubEnv("CM_BEARER_TOKEN", "fixture-token");
    expect((await GET(new Request("http://localhost/api/collector"))).status).toBe(401);
    expect((await GET(new Request("http://localhost/api/collector", { headers: { Authorization: "Bearer fixture-token" } }))).status).toBe(200);
  });
});
