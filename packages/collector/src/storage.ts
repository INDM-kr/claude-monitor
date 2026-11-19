import Database from "better-sqlite3";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { assertRuntime, CollectorError, DEFAULTS, type CollectorConfig } from "./config.js";
import { migrations, type Migration } from "./schema.js";

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new CollectorError("data_directory_not_private");
  }
}

function privateFile(path: string, create = true): void {
  try { if (create) closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    throw new CollectorError("database_file_not_private");
  }
}

/** Separate DB: holds an OS-backed exclusive lock without blocking WAL readers. Never unlink it. */
function acquireWriter(config: CollectorConfig): Database.Database {
  privateDirectory(config.dataDir);
  const path = join(config.dataDir, DEFAULTS.lockFile);
  privateFile(path);
  const lock = new Database(path, { timeout: 0 });
  try { lock.exec("BEGIN EXCLUSIVE"); return lock; }
  catch (error) {
    lock.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") throw new CollectorError("writer_busy");
    throw error;
  }
}

export class MigrationError extends CollectorError {
  constructor(readonly backupPath: string | null, cause: unknown) {
    super("migration_failed", { cause });
  }
}

export interface Storage {
  readonly db: Database.Database;
  readonly deviceId: string;
  readonly schemaVersion: number;
  readonly migrationBackup: string | null;
  /** Synchronous work only; usage and its checkpoint belong in this same callback. */
  transaction<T>(work: (db: Database.Database) => T): T;
  backup(): Promise<string>;
  close(): void;
}

async function backupDatabase(db: Database.Database, config: CollectorConfig, version: number): Promise<string> {
  const directory = join(config.dataDir, DEFAULTS.backupsDirectory);
  privateDirectory(directory);
  const path = join(directory, `schema-${version}-${Date.now()}-${randomUUID()}.sqlite`);
  privateFile(path);
  await db.backup(path);
  privateFile(path, false);
  return path;
}

export async function openStorage(config: CollectorConfig, steps: readonly Migration[] = migrations): Promise<Storage> {
  assertRuntime();
  const lock = acquireWriter(config);
  let db: Database.Database | undefined;
  try {
    const path = join(config.dataDir, DEFAULTS.databaseFile);
    privateFile(path);
    db = new Database(path, { timeout: config.busyTimeoutMs });
    // All INTEGER values read through this connection are exact, including large token counts.
    db.defaultSafeIntegers(true);
    const version = Number(db.pragma("user_version", { simple: true }));
    if (!steps.length || steps.some((step, index) => step.version !== index + 1)) {
      throw new CollectorError("invalid_migration_sequence");
    }
    const target = steps.at(-1)!.version;
    if (version > target) throw new CollectorError("schema_too_new");
    if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) {
      throw new CollectorError("unversioned_database");
    }
    if (db.pragma("quick_check", { simple: true }) !== "ok") throw new CollectorError("database_corrupt");
    db.pragma("foreign_keys = ON");
    db.pragma("recursive_triggers = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    const database = db;
    const pending = steps.filter(step => step.version > version);
    const migrationBackup = pending.length && version > 0 ? await backupDatabase(db, config, version) : null;
    if (pending.length) {
      try {
        database.transaction(() => {
          for (const step of pending) {
            step.up(database);
            database.pragma(`user_version = ${step.version}`);
          }
          database.prepare("UPDATE metadata SET schema_version = ? WHERE id = 1").run(target);
        }).immediate();
      } catch (error) { throw new MigrationError(migrationBackup, error); }
    }
    database.transaction(() => {
      if (!database.prepare("SELECT id FROM metadata WHERE id = 1").get()) {
        const deviceId = randomUUID();
        database.prepare("INSERT INTO device VALUES (?, ?)").run(deviceId, "This device");
        database.prepare(`INSERT INTO metadata(id,schema_version,device_id,timezone,parser_version)
          VALUES (1,?,?,?,'not_started')`).run(target, deviceId, config.timezone);
        database.prepare("INSERT INTO provider VALUES ('claude-code','not_started','jsonl','[]')").run();
      }
    }).immediate();
    const metadata = database.prepare("SELECT device_id, schema_version FROM metadata WHERE id=1").get() as { device_id: string; schema_version: bigint };
    if (Number(metadata.schema_version) !== target) throw new CollectorError("schema_metadata_mismatch");
    let closed = false;
    return {
      db: database, deviceId: metadata.device_id, schemaVersion: target, migrationBackup,
      transaction<T>(work: (db: Database.Database) => T): T {
        if (work.constructor.name === "AsyncFunction") throw new CollectorError("async_transaction_not_allowed");
        return database.transaction(() => {
          const result = work(database);
          if (result && typeof (result as { then?: unknown }).then === "function") throw new CollectorError("async_transaction_not_allowed");
          return result;
        }).immediate();
      },
      backup: () => backupDatabase(database, config, target),
      close() {
        if (closed) return;
        // Do not release the lease if closing a still-busy connection fails.
        database.close();
        lock.close();
        closed = true;
      },
    };
  } catch (error) {
    try { db?.close(); } finally { lock.close(); }
    throw error;
  }
}

/** Offline recovery to a NEW directory; never overwrite or erase the original DB/WAL. */
export async function restoreBackup(backupPath: string, destination: CollectorConfig): Promise<void> {
  assertRuntime();
  privateFile(backupPath, false);
  privateDirectory(destination.dataDir);
  const path = join(destination.dataDir, DEFAULTS.databaseFile);
  const rel = relative(realpathSync(destination.dataDir), realpathSync(backupPath));
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new CollectorError("backup_inside_restore_destination");
  const lock = acquireWriter(destination);
  let source: Database.Database | undefined;
  try {
    if ([path, `${path}-wal`, `${path}-shm`].some(existsSync)) throw new CollectorError("restore_destination_not_empty");
    source = new Database(backupPath, { readonly: true, fileMustExist: true });
    if (source.pragma("quick_check", { simple: true }) !== "ok") throw new CollectorError("database_corrupt");
    const version = Number(source.pragma("user_version", { simple: true }));
    if (version < 1 || version > migrations.at(-1)!.version) throw new CollectorError("unsupported_backup_schema");
    privateFile(path);
    await source.backup(path);
  } finally {
    try { source?.close(); } finally { lock.close(); }
  }
}
