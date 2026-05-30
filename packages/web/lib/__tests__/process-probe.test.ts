import { describe, it, expect } from "vitest";
import {
  classifyRunner,
  sessionIdFromCommand,
  contextLimitFromCommand,
  parsePsOutput,
} from "../process-probe";

const CONDUCTOR = "/Users/x/Library/Application Support/com.conductor.app/agent-binaries/claude/2.1.154/claude --resume 5a62fd30-6190-43e8-bf6a-bbbd8c8461f5 --model claude-opus-4-8[1m]";
const CASK = "/opt/homebrew/Caskroom/claude-code/2.1.145/claude --session-id 2f794145-3d65-414c-871d-469420887642 --model opus";
const DESKTOP = "/Applications/Claude.app/Contents/Helpers/x /Users/x/Library/Application Support/Claude/claude-code/2.1.156/claude.app/Contents/MacOS/claude --resume 163f7e2e-aad9-4dad-93f5-c304a8f1d986";

describe("process-probe parsing", () => {
  it("러너 분류", () => {
    expect(classifyRunner(CONDUCTOR)).toBe("conductor");
    expect(classifyRunner(CASK)).toBe("claude-code");
    expect(classifyRunner(DESKTOP)).toBe("claude-desktop");
    expect(classifyRunner("/usr/bin/python foo")).toBe("unknown");
  });

  it("sessionId 추출 (--resume / --session-id)", () => {
    expect(sessionIdFromCommand(CONDUCTOR)).toBe("5a62fd30-6190-43e8-bf6a-bbbd8c8461f5");
    expect(sessionIdFromCommand(CASK)).toBe("2f794145-3d65-414c-871d-469420887642");
    expect(sessionIdFromCommand("claude --foo")).toBeNull();
  });

  it("컨텍스트 한도는 [1m]만 1M, 아니면 null", () => {
    expect(contextLimitFromCommand(CONDUCTOR)).toBe(1_000_000);
    expect(contextLimitFromCommand(CASK)).toBeNull();
  });

  it("parsePsOutput: pid+sessionId 행만 추출, claude 아닌 행 제외", () => {
    const text = [
      ` 2881 ${CONDUCTOR}`,
      `10288 /opt/homebrew/Cellar/php/8.5.6/bin/php -S localhost:8082`,
      ` 6615 ${CASK}`,
    ].join("\n");
    const entries = parsePsOutput(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ sessionId: "5a62fd30-6190-43e8-bf6a-bbbd8c8461f5", pid: 2881, runner: "conductor", contextLimit: 1_000_000 });
    expect(entries[1].pid).toBe(6615);
    expect(entries[1].contextLimit).toBeNull();
  });
});
