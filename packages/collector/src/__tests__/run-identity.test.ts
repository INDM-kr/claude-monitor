import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { openStorage, type Storage } from "../storage.js";
import { migrations } from "../schema.js";
import { hookAgentId, mergeSplitChildRuns } from "../run-identity.js";
import { testConfig } from "./helpers.js";

const dirs: string[] = [], stores: Storage[] = [];
async function store() { const c = testConfig(); dirs.push(c.dataDir); const s = await openStorage(c); stores.push(s); return s; }
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const n = (s: Storage, sql: string, ...args: unknown[]) => Number((s.db.prepare(sql).get(...args) as { n: bigint }).n);

describe("subagent run identity", () => {
  it("reduces transcript-derived child ids to the bare id Claude hooks report", () => {
    expect(hookAgentId("agent-a6c61e88")).toBe("a6c61e88");
    expect(hookAgentId("wf_4ef6c773-8ca/agent-a6c61e88")).toBe("a6c61e88");
    expect(hookAgentId("a6c61e88")).toBe("a6c61e88");
  });

  it("is registered as a data-only schema migration", () => {
    expect(migrations.find(step => step.version === 5)!.up.toString()).toContain("mergeSplitChildRuns");
  });

  it("merges a hook-only child into the transcript child and moves its observations, process and work links", async () => {
    const s = await store(); const db = s.db, dev = s.deviceId;
    db.prepare("INSERT INTO run VALUES('root',?,'claude-code','s1',NULL,NULL,NULL)").run(dev);
    db.prepare("INSERT INTO run VALUES('ledger',?,'claude-code','s1','wf_1/agent-x1','root',NULL)").run(dev);
    db.prepare("INSERT INTO run VALUES('hook',?,'claude-code','s1','x1','root',NULL)").run(dev);
    db.prepare("INSERT INTO runtime_observation VALUES('o1','hook','SubagentStart',10,NULL,NULL,NULL,NULL)").run();
    db.prepare("INSERT INTO runtime_process VALUES('hook',123,'identity',10,'alive',11,'matched')").run();
    db.prepare("INSERT INTO work_item VALUES('w1','Work','',NULL,'open',1,1,NULL)").run();
    db.prepare("INSERT INTO work_run_link VALUES('w1','hook',5)").run();
    // Two workflow children share a stem: the hook id cannot be attributed, so it stays.
    db.prepare("INSERT INTO run VALUES('root2',?,'claude-code','s2',NULL,NULL,NULL)").run(dev);
    for (const [id, agent] of [["wa", "wf_a/agent-dup"], ["wb", "wf_b/agent-dup"], ["hook2", "dup"]]) db.prepare("INSERT INTO run VALUES(?,?,'claude-code','s2',?,'root2',NULL)").run(id, dev, agent);

    expect(mergeSplitChildRuns(db)).toBe(1);
    expect(n(s, "SELECT count(*) n FROM run WHERE id='hook'")).toBe(0);
    expect(db.prepare("SELECT run_id FROM runtime_observation WHERE id='o1'").get()).toEqual({ run_id: "ledger" });
    expect(db.prepare("SELECT run_id FROM runtime_process").get()).toEqual({ run_id: "ledger" });
    expect(db.prepare("SELECT run_id FROM work_run_link").get()).toEqual({ run_id: "ledger" });
    expect(n(s, "SELECT count(*) n FROM run WHERE id='hook2'")).toBe(1);
    expect(mergeSplitChildRuns(db)).toBe(0);
  });
});
