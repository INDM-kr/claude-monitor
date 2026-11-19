import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCollectorConfig } from "../config.js";
import type { Storage } from "../storage.js";

export function testConfig() {
  const dataDir = mkdtempSync(join(tmpdir(), "cm-storage-test-"));
  return loadCollectorConfig({ CM_DATA_DIR: dataDir, CLAUDE_PROJECTS_DIR: join(dataDir, "test-projects"), CM_CODEX_DIR: join(dataDir, "test-codex"), CM_TIMEZONE: "Asia/Seoul" });
}

export function seedContext(store: Storage) {
  store.db.prepare("INSERT INTO project VALUES ('alpha','Alpha',NULL)").run();
  store.db.prepare("INSERT INTO workspace VALUES ('workspace',?,'/workspace/example',NULL,'alpha','manual')").run(store.deviceId);
  store.db.prepare("INSERT INTO run VALUES ('root',?,'claude-code','session',NULL,NULL,'workspace')").run(store.deviceId);
  store.db.prepare("INSERT INTO source(id,device_id,provider_id,local_path) VALUES ('source',?,'claude-code','/example/session.jsonl')").run(store.deviceId);
  store.db.exec(`INSERT INTO source_generation VALUES ('generation','source',0,'file-identity',1000,1,'fingerprint');
    INSERT INTO checkpoint VALUES ('generation',0,'prefix',1)`);
}

export function insertUsage(store: Storage, output: bigint = 50n) {
  store.db.prepare(`INSERT INTO usage_record(
    id,device_id,provider_id,response_id,run_id,workspace_id,model,first_event_at,snapshot_at,
    input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,validity,cost_eligibility,parser_version
  ) VALUES ('usage',?,'claude-code','response','root','workspace','fixture-model',1,1,100,?,800,200,'valid','eligible','fixture/1')`)
    .run(store.deviceId, output);
}
