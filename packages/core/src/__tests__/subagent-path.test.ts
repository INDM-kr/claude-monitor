import { describe, expect, it } from "vitest";
import { parentInfoFromSubagentPath, subagentChildId } from "../util/subagent-path.js";

const ROOT = "/Users/x/.claude/projects";
const ENC = "-Users-x-conductor-workspaces-proj-lisbon";
const UUID = "613cd51c-826c-4e8c-9ab7-893f23025373";

describe("parentInfoFromSubagentPath", () => {
  it("parses the direct subagents layout", () => {
    const p = `${ROOT}/${ENC}/${UUID}/subagents/agent-a08c943af4af58d5d.jsonl`;
    expect(parentInfoFromSubagentPath(ROOT, p)).toEqual({
      parentUuid: UUID,
      agentId: "agent-a08c943af4af58d5d",
      childId: `${UUID}/agent-a08c943af4af58d5d`,
    });
  });

  it("resolves the SAME parentUuid for the nested workflows layout", () => {
    const p = `${ROOT}/${ENC}/${UUID}/subagents/workflows/wf_ce33ae33-f8f/agent-aa892d5c0fdec3712.jsonl`;
    expect(parentInfoFromSubagentPath(ROOT, p)?.parentUuid).toBe(UUID);
    expect(parentInfoFromSubagentPath(ROOT, p)?.agentId).toBe("agent-aa892d5c0fdec3712");
  });

  it("returns null for a normal top-level session file", () => {
    expect(parentInfoFromSubagentPath(ROOT, `${ROOT}/${ENC}/${UUID}.jsonl`)).toBeNull();
  });

  it("returns null for a non-agent file inside subagents (e.g. meta.json)", () => {
    expect(
      parentInfoFromSubagentPath(ROOT, `${ROOT}/${ENC}/${UUID}/subagents/agent-x.meta.json`),
    ).toBeNull();
  });

  it("subagentChildId composes parent + agent", () => {
    expect(subagentChildId("p", "agent-z")).toBe("p/agent-z");
  });
});
