import { describe, it, expect } from "vitest";
import { verifyKillTarget } from "../process-kill";

const SID = "5a62fd30-6190-43e8-bf6a-bbbd8c8461f5";
describe("verifyKillTarget", () => {
  it("claude 프로세스이며 sessionId 포함 시 true", () => {
    expect(verifyKillTarget(`/x/com.conductor.app/agent-binaries/claude --resume ${SID}`, SID)).toBe(true);
  });
  it("sessionId 불일치 시 false", () => {
    expect(verifyKillTarget(`claude --resume 00000000-0000-0000-0000-000000000000`, SID)).toBe(false);
  });
  it("claude 아닌 프로세스는 false (오살 방지)", () => {
    expect(verifyKillTarget(`/usr/bin/python --resume ${SID}`, SID)).toBe(false);
  });
});
