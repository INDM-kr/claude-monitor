#!/usr/bin/env node
// Isolated design spike. Does not open the application's or user's database.
const { createRequire } = require('node:module');
const { resolve, join } = require('node:path');
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

const [driverDir, reportPath] = process.argv.slice(2);
if (!driverDir || !reportPath) throw new Error('Usage: node scripts/verify-l0-storage.cjs DRIVER_DIRECTORY REPORT_JSON');
const isolatedRequire = createRequire(resolve(driverDir, 'package.json'));
const Database = isolatedRequire('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'cm-l0-sqlite-'));
const databasePath = join(dir, 'spike.sqlite');
const checks = [];
let db;
try {
  db = new Database(databasePath);
  assert.equal(db.pragma('journal_mode = WAL', { simple: true }), 'wal');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE workspace(id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE usage_record(
      device TEXT NOT NULL, provider TEXT NOT NULL, message_id TEXT NOT NULL,
      workspace_id TEXT REFERENCES workspace(id), occurred_ms INTEGER NOT NULL,
      input INTEGER NOT NULL CHECK(input >= 0), output INTEGER NOT NULL CHECK(output >= 0),
      cache_read INTEGER NOT NULL CHECK(cache_read >= 0), cache_write INTEGER NOT NULL CHECK(cache_write >= 0),
      PRIMARY KEY(device,provider,message_id)
    );
    CREATE TABLE checkpoint(source_id TEXT PRIMARY KEY, byte_offset INTEGER NOT NULL);
    INSERT INTO workspace VALUES('workspace-a','alpha');
    INSERT INTO workspace VALUES('workspace-b',NULL);
    INSERT INTO checkpoint VALUES('source-a',0);
  `);
  const upsert = db.prepare(`INSERT INTO usage_record VALUES(@device,@provider,@message,@workspace,@occurred,@input,@output,@read,@write)
    ON CONFLICT(device,provider,message_id) DO UPDATE SET output=excluded.output`);
  const advance = db.prepare('UPDATE checkpoint SET byte_offset=? WHERE source_id=?');
  const base = { device:'device-test', provider:'claude-code', message:'message-a', workspace:'workspace-a', occurred:1000, input:100, output:5, read:800, write:200 };
  const ingest = db.transaction((row, offset) => { upsert.run(row); advance.run(offset,'source-a'); });
  ingest(base,100);
  ingest(base,100);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_record').get().n,1);
  checks.push('same-key replay is idempotent');
  ingest({...base,output:50},200);
  const sum = () => db.prepare('SELECT SUM(input+output+cache_read+cache_write) n FROM usage_record').get().n;
  assert.equal(sum(),1150);
  checks.push('snapshot revision replaces output instead of adding it');
  const fail = db.transaction(() => { upsert.run({...base,message:'message-crash'}); advance.run(999,'source-a'); throw new Error('injected-abort'); });
  assert.throws(fail,/injected-abort/);
  assert.equal(sum(),1150);
  assert.equal(db.prepare('SELECT byte_offset n FROM checkpoint').get().n,200);
  checks.push('injected transaction abort rolls back usage and checkpoint together');
  ingest({...base,message:'message-b',workspace:'workspace-b',input:20,output:10,read:0,write:0},300);
  assert.equal(sum(),1180);
  db.prepare('UPDATE workspace SET project_id=? WHERE id=?').run('alpha','workspace-b');
  assert.equal(sum(),1180);
  assert.equal(db.prepare('SELECT SUM(input+output+cache_read+cache_write) n FROM usage_record u JOIN workspace w ON w.id=u.workspace_id WHERE project_id=?').get('alpha').n,1180);
  checks.push('workspace remapping changes attribution but preserves global total');
  assert.throws(() => upsert.run({...base,message:'bad',input:-1}),/CHECK constraint/);
  checks.push('negative token constraint rejects invalid input');
  db.close(); db = new Database(databasePath);
  assert.equal(sum(),1180);
  assert.equal(db.prepare('SELECT byte_offset n FROM checkpoint').get().n,300);
  checks.push('database reopen preserves committed usage and checkpoint');
  const result = {capturedAt:new Date().toISOString(),node:process.version,arch:process.arch,driver:isolatedRequire('better-sqlite3/package.json').version,sqlite:db.prepare('select sqlite_version() version').get().version,status:'pass',checks,limits:'Minimal schema spike only. Full collector, process-kill crash recovery, Next.js packaging and production load not exercised.'};
  mkdirSync(require('node:path').dirname(resolve(reportPath)),{recursive:true});
  writeFileSync(reportPath,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {
  if (db?.open) db.close();
  rmSync(dir,{recursive:true,force:true});
}
