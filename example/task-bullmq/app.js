/**
 * Example BullMQ application: a queue plus
 * one or more worker processes over a real Redis, with a supervisor
 * that replaces a worker that died mid-job.
 *
 * The three defect flags are the application's own failures, the ones a
 * background-job contract exists to catch:
 *   - `breakRetry`        the delivery never recovers (the retry bound
 *                         ends the job as `failed`);
 *   - `breakIdempotency`  a repeated idempotency key writes a second
 *                         side effect;
 *   - `restartWorker` off a lost worker is never replaced, so the queue
 *                         can only fail the stalled job.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKER_ENTRY = fileURLToPath(new URL('./worker.js', import.meta.url));

/**
 * Boots the queue application and its worker supervisor.
 *
 * Args:
 *   connection: Redis connection material (host/port or url).
 *   scopeFile: absolute path of the outbox mirror the adapter reads.
 *   breakRetry: when true the worker never completes a delivery.
 *   breakIdempotency: when true the worker repeats side effects.
 *   restartWorker: when true a worker lost mid-job is replaced once.
 *
 * Returns:
 *   Promise<{queueName, stop}>: the queue the engine delivers to and
 *   the supervisor's stop.
 */
export async function startTaskQueueApp(options) {
  const queueName = `gf-task-${randomUUID()}`;
  if (!existsSync(options.scopeFile)) {
    writeFileSync(options.scopeFile, `${JSON.stringify({ checkpoint: 'c0', rows: [] }, null, 2)}\n`);
  }
  let child = null;
  let stopped = false;
  let replacements = 0;
  const spawnWorker = (kill) => {
    child = spawn(
      process.execPath,
      [
        WORKER_ENTRY,
        JSON.stringify({
          connection: options.connection,
          queue: queueName,
          scopeFile: options.scopeFile,
          kill,
          ...(options.breakRetry === true ? { breakRetry: true } : {}),
          ...(options.breakIdempotency === true ? { breakIdempotency: true } : {}),
        }),
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.on('exit', () => {
      if (stopped) return;
      // The first worker is the one that dies mid-job; its replacement
      // completes the reclaimed delivery exactly once.
      if (kill && options.restartWorker === true && replacements < 1) {
        replacements += 1;
        // A supervisor does not replace a worker instantly: the delay
        // keeps the reclaimed job visibly waiting, which is what the
        // engine's timeline samples.
        const wait = setTimeout;
        wait(() => {
          if (!stopped) spawnWorker(false);
        }, options.restartDelayMs ?? 800);
      }
    });
  };
  spawnWorker(true);
  // Readiness wait for the worker to attach to the queue before the
  // run starts delivering.
  await new Promise((settled) => setTimeout(settled, 400));
  return {
    queueName,
    stop: async () => {
      stopped = true;
      child?.kill('SIGKILL');
    },
  };
}
