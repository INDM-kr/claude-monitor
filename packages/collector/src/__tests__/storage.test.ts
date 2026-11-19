import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../config.js";
import { migrations } from "../schema.js";
import { MigrationError, openStorage, restoreBackup, type Storage } from "../storage.js";
import { insertUsage, seedContext, testConfig } from "./helpers.js";

const stores: Storage[] = [];
const directories: string[] = [];
function config() { const c = testConfig(); directories.push(c.dataDir); return c; }
async function open(c = config(), steps = migrations) { const s = await openStorage(c, steps); stores.push(s); return s; }
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("persistent storage", () => {
  it("creates L1 schema and private WAL storage, reopens the same device and data", async () => {
    const c = config(), s = await open(c);
    seedContext(s); insertUsage(s);
    expect(s.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(s.db.pragma("foreign_keys", { simple: true })).toBe(1n);
    expect(s.db.pragma("synchronous", { simple: true })).toBe(2n);
    expect(s.db.pragma("busy_timeout", { simple: true })).toBe(BigInt(c.busyTimeoutMs));
    expect(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name).sort())
      .toEqual(["device","provider","metadata","project","workspace","run","source","source_generation",
        "checkpoint","usage_observation","usage_record","usage_source_link","pricing_version","pricing_rate","ingestion_diagnostic", "collector_scan", "runtime_observation", "runtime_process",
        "work_item", "work_run_link", "work_artifact", "work_event", "local_settings", "usage_exclusion", "usage_excluded_response", "source_context", "project_candidate_dismissal"].sort());
    expect(statSync(c.dataDir).mode & 0o777).toBe(0o700);
    for (const name of [DEFAULTS.databaseFile, DEFAULTS.lockFile, `${DEFAULTS.databaseFile}-wal`, `${DEFAULTS.databaseFile}-shm`]) {
      expect(statSync(join(c.dataDir, name)).mode & 0o077).toBe(0);
    }
    const device = s.deviceId; s.close();
    const reopened = await open(c);
    expect(reopened.deviceId).toBe(device);
    expect(reopened.schemaVersion).toBe(migrations.length);
    expect(reopened.db.prepare("SELECT output_tokens FROM usage_record").get()).toEqual({ output_tokens: 50n });
  });

  it("rolls back usage and checkpoint together, then persists one exact batch", async () => {
    const s = await open(); seedContext(s);
    expect(() => s.transaction(db => {
      insertUsage(s); db.exec("UPDATE checkpoint SET complete_byte_offset=200");
      throw new Error("injected before commit");
    })).toThrow("injected before commit");
    expect(s.db.prepare("SELECT count(*) n FROM usage_record").get()).toEqual({ n: 0n });
    expect(s.db.prepare("SELECT complete_byte_offset n FROM checkpoint").get()).toEqual({ n: 0n });
    s.transaction(db => { insertUsage(s); db.exec("UPDATE checkpoint SET complete_byte_offset=200"); });
    expect(s.db.prepare("SELECT input_tokens+output_tokens+cache_read_tokens+cache_write_tokens total FROM usage_record").get()).toEqual({ total: 1150n });
    expect(s.db.prepare("SELECT complete_byte_offset n FROM checkpoint").get()).toEqual({ n: 200n });
    expect(() => s.transaction(async () => 1)).toThrow("async_transaction_not_allowed");
  });

  it("enforces canonical identity, positive integer tokens, foreign keys and exact 64-bit reads", async () => {
    const s = await open(); seedContext(s); insertUsage(s, 9007199254740993n);
    expect(s.db.prepare("SELECT output_tokens FROM usage_record").get()).toEqual({ output_tokens: 9007199254740993n });
    expect(() => insertUsage(s)).toThrow(/UNIQUE/);
    expect(() => s.db.exec("UPDATE usage_record SET output_tokens=-1")).toThrow(/CHECK/);
    expect(() => s.db.exec("UPDATE usage_record SET output_tokens=1.5")).toThrow(/INTEGER/);
    expect(() => s.db.exec("UPDATE usage_record SET workspace_id='missing'")).toThrow(/FOREIGN KEY/);
    expect(() => s.db.exec("UPDATE checkpoint SET complete_byte_offset=-1")).toThrow(/CHECK/);
    s.db.prepare("INSERT INTO run VALUES ('child',?,'claude-code','session','agent-child','root','workspace')").run(s.deviceId);
    expect(s.db.prepare("SELECT count(*) n FROM run").get()).toEqual({ n: 2n });
  });

  it("backs up committed WAL contents and restores into a new directory without overwriting", async () => {
    const c = config(), s = await open(c); seedContext(s); insertUsage(s);
    s.db.pragma("wal_autocheckpoint=0"); s.db.exec("UPDATE usage_record SET output_tokens=77");
    const backup = await s.backup();
    const destination = config();
    await restoreBackup(backup, destination);
    const recovered = await open(destination);
    expect(recovered.deviceId).toBe(s.deviceId);
    expect(recovered.db.prepare("SELECT output_tokens FROM usage_record").get()).toEqual({ output_tokens: 77n });
    recovered.close();
    await expect(restoreBackup(backup, destination)).rejects.toThrow("restore_destination_not_empty");
    expect(s.db.prepare("SELECT output_tokens FROM usage_record").get()).toEqual({ output_tokens: 77n });
  });

  it("keeps pricing versions immutable, including SQL REPLACE", async () => {
    const s = await open();
    s.db.exec("INSERT INTO pricing_version VALUES ('fixture','https://example.invalid',1,'standard_equivalent','USD')");
    s.db.exec("INSERT INTO pricing_rate VALUES ('fixture','fixture-model','input',2,1000000)");
    expect(() => s.db.exec("UPDATE pricing_rate SET numerator=3")).toThrow("immutable_pricing");
    expect(() => s.db.exec("DELETE FROM pricing_rate")).toThrow("immutable_pricing");
    expect(() => s.db.exec("INSERT OR REPLACE INTO pricing_rate VALUES ('fixture','fixture-model','input',3,1000000)")).toThrow("immutable_pricing");
  });

  it("upgrades versioned data transactionally with a usable pre-migration backup", async () => {
    const c = config(), first = await open(c); seedContext(first); first.close();
    const next = await open(c, [...migrations, { version: migrations.length + 1, up: db => { db.exec("ALTER TABLE project ADD COLUMN color TEXT"); } }]);
    expect(next.schemaVersion).toBe(migrations.length + 1);
    expect(next.db.prepare("SELECT schema_version FROM metadata").get()).toEqual({ schema_version: BigInt(migrations.length + 1) });
    const backup = new Database(next.migrationBackup!, { readonly: true });
    try {
      expect(backup.pragma("user_version", { simple: true })).toBe(migrations.length);
      expect(backup.prepare("SELECT label FROM project").get()).toEqual({ label: "Alpha" });
    } finally { backup.close(); }
    next.close();
    await expect(openStorage(c)).rejects.toThrow("schema_too_new");
  });

  it("failed migration retains the previous schema/data and can restore its backup", async () => {
    const c = config(), first = await open(c); seedContext(first); insertUsage(first); first.close();
    let failure: unknown;
    try {
      await openStorage(c, [...migrations, { version: migrations.length + 1, up: db => {
        db.exec("DELETE FROM usage_record; ALTER TABLE project ADD COLUMN failed_column TEXT");
        throw new Error("injected migration failure");
      } }]);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MigrationError);
    const unchanged = await open(c);
    expect(unchanged.db.prepare("SELECT count(*) n FROM usage_record").get()).toEqual({ n: 1n });
    expect(unchanged.db.prepare("PRAGMA table_info(project)").all().some((r: any) => r.name === "failed_column")).toBe(false);
    const destination = config();
    await restoreBackup((failure as MigrationError).backupPath!, destination);
    const restored = await open(destination);
    expect(restored.schemaVersion).toBe(migrations.length);
    expect(restored.db.prepare("SELECT count(*) n FROM usage_record").get()).toEqual({ n: 1n });
  });

  it("rejects a corrupt or unversioned DB without replacing it", async () => {
    const c = config(), path = join(c.dataDir, DEFAULTS.databaseFile);
    writeFileSync(path, "corrupt fixture", { mode: 0o600 });
    await expect(openStorage(c)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("corrupt fixture");
    const other = config(), dbPath = join(other.dataDir, DEFAULTS.databaseFile);
    writeFileSync(dbPath, "", { mode: 0o600 });
    const unrelated = new Database(dbPath); unrelated.exec("CREATE TABLE user_data(value TEXT)"); unrelated.close();
    await expect(openStorage(other)).rejects.toThrow("unversioned_database");
    expect(existsSync(dbPath)).toBe(true);
  });

  it("rejects non-private directories and symlinks instead of chmodding unrelated paths", async () => {
    const c = config(); chmodSync(c.dataDir, 0o755);
    await expect(openStorage(c)).rejects.toThrow("data_directory_not_private");
    expect(statSync(c.dataDir).mode & 0o777).toBe(0o755);
    const other = config(), target = join(other.dataDir, "unrelated");
    writeFileSync(target, "preserved", { mode: 0o600 });
    symlinkSync(target, join(other.dataDir, DEFAULTS.databaseFile));
    await expect(openStorage(other)).rejects.toThrow("database_file_not_private");
    expect(readFileSync(target, "utf8")).toBe("preserved");
  });
});
