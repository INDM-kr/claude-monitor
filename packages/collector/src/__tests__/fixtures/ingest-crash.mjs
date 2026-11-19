import { writeSync } from 'node:fs';
import { loadCollectorConfig } from '../../../dist/config.js';
import { openStorage } from '../../../dist/storage.js';
import { LedgerIngestor } from '../../../dist/ingest.js';
const phase = process.env.CM_TEST_CRASH_PHASE;
const config = loadCollectorConfig();
const storage = await openStorage(config);
const stopAtBoundary = () => {
  // The parent SIGKILLs only this test-owned process at this transaction boundary.
  writeSync(process.stdout.fd, `BOUNDARY:${phase}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const ingestor = new LedgerIngestor(storage, config, phase === 'before' ? { beforeCommit: stopAtBoundary } : { afterCommit: stopAtBoundary });
await ingestor.scan();
throw new Error('crash_boundary_not_reached');
