/**
 * Example BullMQ worker (plan 20260925-2011 Phase 3): a real queue
 * worker in its own process, so a case can prove a LOST worker (the
 * stall scenario exits mid-job) instead of a simulated one.
 *
 * The engine stamps two keys into every delivery's job data; the app
 * reads them exactly as it would read its own delivery envelope:
 *   `gateforgeDeliveryId`      the engine's delivery identity
 *   `gateforgeIdempotencyKey`  the engine's idempotency key
 *
 * Every executed delivery appends one row to the harness-owned outbox
 * file, deduplicated by idempotency key — the application-side effect
 * the reviewed adapter snapshots back.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

const DELIVERY_ID_KEY = 'gateforgeDeliveryId';
const IDEMPOTENCY_KEY_KEY = 'gateforgeIdempotencyKey';

const config = JSON.parse(process.argv[2]);

/** Reads the outbox mirror (absent before the first write). */
function readOutbox() {
  if (!existsSync(config.scopeFile)) return { checkpoint: 'c0', rows: [] };
  return JSON.parse(readFileSync(config.scopeFile, 'utf8'));
}

const worker = new Worker(
  config.queue,
  async (job) => {
    const data = job.data;
    if (config.kill === true && data.kill === true) {
      // Hold the job past its lock, then vanish: the queue has to
      // reclaim it from a worker that stopped holding it.
      await new Promise((hold) => setTimeout(hold, config.holdMs ?? 400));
      process.exit(1);
    }
    // The reclaimed attempt stays in flight long enough for the
    // engine's timeline to observe the queue handing it out again.
    if (data.holdMs !== undefined) {
      await new Promise((hold) => setTimeout(hold, data.holdMs));
    }
    if (config.breakRetry === true) throw new Error('delivery attempt failed');
    if (data.succeedOn !== undefined && job.attemptsMade + 1 < data.succeedOn) {
      throw new Error(`flaky attempt ${String(job.attemptsMade + 1)} of ${String(data.succeedOn)}`);
    }
    const key = data[IDEMPOTENCY_KEY_KEY];
    const store = readOutbox();
    const known = store.rows.some((row) => row.key === key);
    if (known && config.breakIdempotency !== true) return { deduplicated: true, delivery: data[DELIVERY_ID_KEY] };
    // Row identity is per key: a repeated key produces exactly one row.
    const occurrence = store.rows.filter((row) => row.key === key).length + 1;
    const rows = [...store.rows, { id: `${String(key)}-${String(occurrence)}`, key }];
    writeFileSync(config.scopeFile, `${JSON.stringify({ checkpoint: `c${String(rows.length)}`, rows }, null, 2)}\n`);
    return { recorded: true, delivery: data[DELIVERY_ID_KEY] };
  },
  {
    // An explicit client: BullMQ's ESM entry cannot load ioredis itself.
    connection: new Redis(config.connection.url, { maxRetriesPerRequest: null }),
    // Short locks so a lost worker is reclaimed inside a test's bound
    // (BullMQ's 30s default would outlive the run).
    lockDuration: 1000,
    stalledInterval: 500,
  },
);

worker.on('failed', () => {});
