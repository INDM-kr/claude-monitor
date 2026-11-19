import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { usageRunKey } from "@claude-monitor/core";
import { migrations } from "../schema.js";
import { installLocalWorkSchema } from "../local-work-migration.js";
import { applyLocalMutation, dispatchLocalRequest, getLocalDiagnostics, getLocalSettings, listWorkItems, LOCAL_LIMITS, previewLocalPurge } from "../local-work.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:"); db.defaultSafeIntegers(true); db.pragma("foreign_keys = ON");
  migrations[0].up(db); installLocalWorkSchema(db);
  db.exec(`INSERT INTO device VALUES ('device','Fixture');
    INSERT INTO provider VALUES ('claude-code','fixture','jsonl','[]');
    INSERT INTO metadata VALUES (1,4,'device','Asia/Seoul','fixture',0,0);
    INSERT INTO project VALUES ('alpha','Alpha',NULL);
    INSERT INTO workspace VALUES ('workspace','device','/fixture',NULL,'alpha','manual');
    INSERT INTO run VALUES ('root','device','claude-code','session',NULL,NULL,'workspace');
    INSERT INTO run VALUES ('child','device','claude-code','session','agent','root','workspace');
    INSERT INTO source VALUES ('source','device','claude-code','/private/DO-NOT-EXPORT.jsonl');
    INSERT INTO source_generation VALUES ('generation','source',0,'file',50,1,'digest');
    INSERT INTO checkpoint VALUES ('generation',50,'digest',1);`);
});
afterEach(() => db.close());
function create(title = "Build report") { return (applyLocalMutation(db, "work.create", { title, purpose: "Explain project totals", projectId: "alpha" }, 10) as { id: string }).id; }
function items() { return (listWorkItems(db) as any).items; }
function usage(id: string, run: string, at = 100, output = 50n) {
  db.prepare(`INSERT INTO usage_record (id,device_id,provider_id,response_id,run_id,workspace_id,model,first_event_at,snapshot_at,
    input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,validity,cost_eligibility,parser_version)
    VALUES (?,'device','claude-code',?,?,'workspace','fixture',?,?,100,?,800,200,'valid','eligible','fixture')`).run(id,id,run,at,at,output);
}

describe("manual work and verified results", () => {
  it("preserves a stable title across multiple links and accurately sums each linked run once", () => {
    const id = create(); usage("a", "root"); usage("b", "child", 100, 9007199254740993n);
    applyLocalMutation(db,"work.linkRun",{id,runId:"root"},20);
    applyLocalMutation(db,"work.linkRun",{id,runId:"root"},21);
    applyLocalMutation(db,"work.linkRun",{id,runId:"child"},22);
    expect(items()[0]).toMatchObject({title:"Build report",status:"open",observed_tokens:"9007199254743243",request_count:2});
    expect(items()[0].runs).toHaveLength(2);
    expect(items()[0].history.filter((e: any) => e.kind === "run_linked")).toHaveLength(2);
    const other = create("Review report"); applyLocalMutation(db,"work.linkRun",{id:other,runId:"root"},23);
    expect((listWorkItems(db) as any).usageBasis).toBe("linked_runs_only_not_additive_across_work_items");
    applyLocalMutation(db,"work.unlinkRun",{id,runId:"root"},24);
    expect(items().find((w:any) => w.id===id).request_count).toBe(1);
  });

  it("requires artifacts and explicit human verification, then preserves proof when reopened", () => {
    const id = create();
    expect(() => applyLocalMutation(db,"work.verify",{id,note:"Tested",confirmed:false})).toThrow("human_confirmation_required");
    expect(() => applyLocalMutation(db,"work.verify",{id,note:"Tested",confirmed:true})).toThrow("artifact_required");
    applyLocalMutation(db,"work.artifact",{id,label:"Test result",reference:"/workspace/results.md"},20);
    applyLocalMutation(db,"work.verify",{id,note:"All acceptance checks passed",confirmed:true},30);
    expect(items()[0]).toMatchObject({status:"verified",verified_at:"30"});
    expect(() => applyLocalMutation(db,"work.update",{id,title:"changed"})).toThrow("reopen_before_editing");
    expect(() => applyLocalMutation(db,"work.reopen",{id,note:" "})).toThrow("required_text");
    applyLocalMutation(db,"work.reopen",{id,note:"New edge case"},40);
    expect(items()[0]).toMatchObject({status:"open",verified_at:null});
    expect(items()[0].history.map((e:any) => e.kind)).toEqual(["created","artifact_added","verified","reopened"]);
    expect(items()[0].history[2].note).toBe("All acceptance checks passed");
    expect(items()[0].artifacts).toHaveLength(1);
  });

  it("links and unlinks a canonical workflow child ID longer than a native identifier", () => {
    const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const workflow = "wf_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const agent = `${workflow}/cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
    const rootKey = usageRunKey("device", "claude-code", session);
    const childKey = usageRunKey("device", "claude-code", session, session, agent, workflow);
    expect(childKey.length).toBeGreaterThan(200);
    db.prepare("INSERT INTO run VALUES (?,'device','claude-code',?,NULL,NULL,'workspace')").run(rootKey, session);
    db.prepare("INSERT INTO run VALUES (?,'device','claude-code',?,?,?,'workspace')").run(childKey, session, agent, rootKey);
    usage("workflow-usage", childKey);
    const workId = create();
    applyLocalMutation(db, "work.linkRun", { id: workId, runId: childKey });
    expect(items()[0]).toMatchObject({ request_count: 1, observed_tokens: "1150", runs: [{ id: childKey }] });
    applyLocalMutation(db, "work.unlinkRun", { id: workId, runId: childKey });
    expect(items()[0]).toMatchObject({ request_count: 0, runs: [] });
    expect(() => applyLocalMutation(db, "work.linkRun", { id: workId, runId: "x".repeat(LOCAL_LIMITS.runId + 1) })).toThrow("invalid_text");
  });

  it("rejects unsafe references and invalid foreign IDs transactionally, with no implicit URL or file I/O", () => {
    const id = create();
    for (const reference of ["javascript:alert(1)","file:///etc/passwd","https://user:secret@example.invalid","/a/../secret","//network/share"]) {
      expect(() => applyLocalMutation(db,"work.artifact",{id,label:"x",reference})).toThrow("invalid_artifact_reference");
    }
    expect(() => applyLocalMutation(db,"work.linkRun",{id,runId:"absent"})).toThrow("run_not_found");
    expect(() => applyLocalMutation(db,"work.update",{id,title:"changed",projectId:"missing"})).toThrow("project_not_found");
    expect(items()[0].title).toBe("Build report");
    expect(items()[0].history).toHaveLength(1);
    applyLocalMutation(db,"work.artifact",{id,label:"PR",reference:"https://example.invalid/pull/1"},40);
    expect(items()[0].artifacts[0].kind).toBe("link");
    expect(() => applyLocalMutation(db,"work.create",{title:"\u0000bad"})).toThrow("invalid_text");
  });

  it("retains everything by default and treats retention days as review settings without deletion", () => {
    usage("a","root");
    expect(getLocalSettings(db)).toMatchObject({retention_days:null,auto_delete:"0",policy:"manual_review_no_automatic_deletion"});
    applyLocalMutation(db,"local.updateSettings",{retentionDays:30},1000);
    expect(getLocalSettings(db)).toMatchObject({retention_days:"30",auto_delete:"0"});
    expect(db.prepare("SELECT count(*) n FROM usage_record").get()).toEqual({n:1n});
    expect(() => applyLocalMutation(db,"local.updateSettings",{retentionDays:0})).toThrow("invalid_retention");
    applyLocalMutation(db,"local.updateSettings",{retentionDays:null});
    expect(getLocalSettings(db)).toMatchObject({retention_days:null});
  });

  it("requires a current preview, explicit phrase, and writer backup before a transactional purge", () => {
    const id = create(); usage("old","root",100); usage("edge","root",200);
    db.exec(`INSERT INTO usage_observation(id,source_generation_id,byte_start,byte_end,response_id,event_at,observed_at,parser_version,digest)
      VALUES ('late-revision','generation',30,40,'old',300,400,'fixture','digest');
      UPDATE usage_record SET snapshot_observation_id='late-revision' WHERE id='old';
      INSERT INTO usage_source_link VALUES ('old','late-revision');`);
    applyLocalMutation(db,"work.linkRun",{id,runId:"root"});
    const preview = previewLocalPurge(db,{before:200},1000);
    expect(preview).toMatchObject({requests:1,tokens:"1150",before:200});
    const p = {...preview,confirmation:"DELETE LOCAL HISTORY",backupName:"schema-4-1000-fixture.sqlite"};
    expect(() => applyLocalMutation(db,"local.purge",{...p,confirmation:""},1000)).toThrow("purge_confirmation_required");
    expect(() => applyLocalMutation(db,"local.purge",{...p,backupName:"/secret"},1000)).toThrow("purge_backup_required");
    db.exec("UPDATE usage_record SET output_tokens=99 WHERE id='old'");
    expect(() => applyLocalMutation(db,"local.purge",p,1000)).toThrow("purge_preview_changed");
    const updated = previewLocalPurge(db,{before:200},1000);
    applyLocalMutation(db,"local.purge",{...p,...updated},1000);
    expect(db.prepare("SELECT id FROM usage_record").all()).toEqual([{id:"edge"}]);
    expect(db.prepare("SELECT complete_byte_offset FROM checkpoint").get()).toEqual({complete_byte_offset:50n});
    expect(db.prepare("SELECT to_at FROM usage_exclusion").get()).toEqual({to_at:200n});
    expect(db.prepare("SELECT response_id FROM usage_excluded_response").all()).toEqual([{response_id:"old"}]);
    expect(db.prepare("SELECT count(*) n FROM usage_observation").get()).toEqual({n:0n});
    expect(items()[0]).toMatchObject({title:"Build report",request_count:1,observed_tokens:"1150"});
    usage("replayed-old","root",100);
    expect(items()[0].request_count).toBe(1);
    expect(() => previewLocalPurge(db,{before:2000},1000)).toThrow("invalid_cutoff");
  });

  it("exports only whitelisted aggregate diagnostics and dispatches safe known reads", () => {
    db.exec("INSERT INTO ingestion_diagnostic VALUES ('diag','source','generation',10,'malformed_json',10,20,2)");
    const diagnostics = getLocalDiagnostics(db);
    expect(diagnostics).toMatchObject({sources:1,requests:0,diagnostics:[{code:"malformed_json",count:"2"}]});
    expect(JSON.stringify(diagnostics)).not.toContain("DO-NOT-EXPORT");
    expect(dispatchLocalRequest(db,"local.settings",undefined)).toMatchObject({auto_delete:"0"});
    expect(() => dispatchLocalRequest(db,"local.arbitraryRead",{path:"/secret"})).toThrow("unknown_method");
  });

  it("counts conflict rows for removal but excludes them from preview token totals", () => {
    usage("valid","root",100); usage("conflict","root",100,9999n);
    db.exec("UPDATE usage_record SET validity='conflict' WHERE id='conflict'");
    expect(previewLocalPurge(db,{before:200},1000)).toMatchObject({requests:2,validRequests:1,conflictRequests:1,tokens:"1150"});
  });
});
