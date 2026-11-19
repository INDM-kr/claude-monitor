import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CollectorController, loadCollectorConfig } from '../packages/collector/dist/index.js';
import { restoreBackup } from '../packages/collector/dist/storage.js';

const root = await mkdtemp(join(tmpdir(), 'cm-l3-verification-'));
const projects = join(root, 'projects'), data = join(root, 'data'), restore = join(root, 'restored');
await mkdir(join(projects, 'fixture'), { recursive: true, mode: 0o700 });
const config = loadCollectorConfig({ CM_DATA_DIR: data, CLAUDE_PROJECTS_DIR: projects, CM_ENABLE_CODEX: '0', CM_TIMEZONE: 'Asia/Seoul', CM_COLLECTOR_POLL_MS: '50' });
const controller = new CollectorController(config);
const results = [], controllers = [controller];
async function check(name, operation) { await operation(); results.push({ name, pass: true }); }
async function until(operation, test, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const result = await operation(); if (test(result)) return result; await delay(50); }
  throw new Error(message);
}
let workId, backupName, runId;
const sourcePath = join(projects, 'fixture', 'session-example.jsonl');
const source = await readFile(new URL('../packages/adapter-claude-code/src/__tests__/fixtures/l0/observed-repeat.jsonl', import.meta.url), 'utf8');
try {
  await writeFile(sourcePath, source);
  await check('worker_import_and_idempotent_manual_run_link', async () => {
    assert.equal((await controller.start()).state, 'ready');
    const work = await until(() => controller.request('work.list'), result => result.availableRuns.length > 0, 'fixture_import_timeout');
    runId = work.availableRuns[0].id;
    const created = await controller.request('work.create', { title: 'L3 fixture work', purpose: 'Verify explicit completion' });
    workId = created.id;
    await controller.request('work.linkRun', { id: workId, runId });
    await controller.request('work.linkRun', { id: workId, runId });
    const linked = (await controller.request('work.list')).items[0];
    assert.equal(linked.observed_tokens, '36062'); assert.equal(linked.runs.length, 1); assert.equal(linked.status, 'open');
  });
  await check('explicit_verification_and_snapshot_backup', async () => {
    await assert.rejects(controller.request('work.verify', { id: workId, note: 'verified', confirmed: true }), /artifact_required/);
    await controller.request('work.artifact', { id: workId, label: 'Fixture result', reference: 'https://example.invalid/result' });
    await controller.request('work.verify', { id: workId, note: 'Compared 36,062 tokens against fixture oracle', confirmed: true });
    backupName = (await controller.request('local.backup')).backupName;
    assert.match(backupName, /^schema-\d+-[\w.-]+\.sqlite$/);
    await access(join(data, 'backups', backupName));
  });
  await check('reopen_and_restart_preserve_history', async () => {
    await controller.request('work.reopen', { id: workId, note: 'Verify restart' });
    await controller.request('local.updateSettings', { retentionDays: 30 });
    const device = controller.status().deviceId;
    await controller.stop(); assert.equal((await controller.start()).state, 'ready'); assert.equal(controller.status().deviceId, device);
    const work = (await controller.request('work.list')).items[0];
    assert.equal(work.title, 'L3 fixture work'); assert.equal(work.status, 'open'); assert.equal(work.artifacts.length, 1);
    assert.deepEqual(work.history.filter(event => ['verified', 'reopened'].includes(event.kind)).map(event => event.kind), ['verified', 'reopened']);
    assert.equal((await controller.request('local.settings')).retention_days, '30');
  });
  await check('backup_first_purge_prevents_late_snapshot_and_copy_resurrection', async () => {
    const preview = await controller.request('local.purgePreview', { before: Date.parse('2026-09-20T00:00:00Z') });
    assert.equal(preview.requests, 1);
    const purged = await controller.request('local.purge', { ...preview, confirmation: 'DELETE LOCAL HISTORY' });
    await access(join(data, 'backups', purged.backupName));
    assert.equal((await controller.request('work.list')).items[0].observed_tokens, '0');
    const before = (await controller.request('local.diagnostics')).checkpointUpdatedAt;
    const changedAt = Date.now();
    const late = JSON.parse(source.trim().split('\n').at(-1));
    late.timestamp = '2026-09-24T00:00:00Z'; late.message.usage.output_tokens = 600; late.uuid = 'record-late';
    await appendFile(sourcePath, `${JSON.stringify(late)}\n`);
    await writeFile(join(projects, 'fixture', 'copy.jsonl'), `${source}${JSON.stringify(late)}\n`);
    await until(() => controller.request('local.diagnostics'), result => result.sources === 2 && result.checkpointUpdatedAt !== before, 'reimport_scan_timeout');
    await until(async () => controller.status(), result => result.ingestionState === 'watching' && result.lastScanAt > changedAt, 'reimport_completion_timeout');
    assert.equal((await controller.request('work.list')).items[0].observed_tokens, '0');
    assert.equal((await controller.request('local.diagnostics')).requests, 0);
  });
  await check('restore_to_new_directory_recovers_verified_work_and_usage', async () => {
    await controller.stop();
    const restoredConfig = loadCollectorConfig({ CM_DATA_DIR: restore, CLAUDE_PROJECTS_DIR: join(root, 'empty-projects'), CM_ENABLE_CODEX: '0', CM_TIMEZONE: 'Asia/Seoul' });
    await restoreBackup(join(data, 'backups', backupName), restoredConfig);
    const recovered = new CollectorController(restoredConfig); controllers.push(recovered);
    assert.equal((await recovered.start()).state, 'ready');
    const item = (await recovered.request('work.list')).items[0];
    assert.equal(item.id, workId); assert.equal(item.status, 'verified'); assert.equal(item.observed_tokens, '36062');
    assert.equal(item.history.some(event => event.kind === 'reopened'), false);
    const diagnostics = JSON.stringify(await recovered.request('local.diagnostics'));
    assert.equal(diagnostics.includes(root), false); assert.equal(diagnostics.includes('session-example'), false);
  });
  const evidence = { capturedAt: new Date().toISOString(), scope: 'temporary_owned_fixture_and_real_worker', node: process.version, platform: `${process.platform}-${process.arch}`, checks: results, fourteenDayObservation: 'not_completed' };
  await writeFile(resolve('docs/specs/evidence/l3-local-verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ pass: true, checks: results.length }));
} finally {
  for (const instance of controllers) await instance.stop();
  await rm(root, { recursive: true, force: true });
}
