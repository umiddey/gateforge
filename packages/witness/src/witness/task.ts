/**
 * Engine task-delivery driver: the
 * `engine-task` counterpart of the HTTP and browser drivers. It
 * produces the delivery the case declares, then reads the queue back
 * until every produced job settles, sampling each transition on the
 * way.
 *
 * Both halves are engine-owned on purpose: the engine grades a
 * background job's attempts, terminal state and idempotency from state
 * IT produced and read, never from what the suite says happened.
 */
import {
  MAX_QUEUE_FIELD_CHARS,
  MAX_QUEUE_SAMPLES,
  TERMINAL_QUEUE_JOB_STATES,
  type QueueJobObservation,
  type QueueJobSample,
  type QueueObservation,
} from '@gate-forge/core';
import type { QueueChannel, QueueDeliveryReceipt } from '../queue/observer.js';

/** Blocking task-driver failure (always a diagnostic, never proof). */
export class TaskDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskDriverError';
  }
}

/** The compiled `deliver` action this driver executes. */
export interface TaskDeliverAction {
  resourceId: string;
  payload: { from: string; value?: unknown; key?: string };
  idempotencyKey: { from: string; value?: unknown; key?: string };
  deliveryId: { from: string; value?: unknown; key?: string };
  count: number;
  schedule: 'serial' | 'concurrent';
}

/** What the driver produced and read for one delivery case. */
export interface TaskDeliveryResult {
  /** The sealed engine observation (graded core-side). */
  observation: QueueObservation;
  /** The resolved values the engine delivered with. */
  submittedValues: Record<string, unknown>;
}

/** Unsafe fixture-key segments (no prototype-chain traversal). */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Resolves one declared input value against the sealed lease subjects.
 *
 * Args:
 *   raw: the compiled InputValue.
 *   subjects: the lease's fixture subjects.
 *   what: field name for diagnostics.
 *
 * Returns:
 *   unknown: the resolved value.
 *
 * @throws TaskDriverError the value uses an unsupported source or does not resolve.
 */
function resolveDeclaredValue(
  raw: { from: string; value?: unknown; key?: string },
  subjects: Record<string, unknown>,
  what: string,
): unknown {
  if (raw.from === 'literal') return raw.value ?? null;
  if (raw.from === 'fixture') {
    if (typeof raw.key !== 'string') throw new TaskDriverError(`${what} fixture reference has no key`);
    const segments = raw.key.split('.');
    if (segments.some((segment) => segment.length === 0 || FORBIDDEN_SEGMENTS.has(segment))) {
      throw new TaskDriverError(`${what} fixture key is forbidden`);
    }
    let current: unknown = subjects;
    for (const segment of segments) {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        throw new TaskDriverError(`${what} fixture key '${raw.key}' does not resolve`);
      }
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new TaskDriverError(`${what} fixture key '${raw.key}' does not resolve`);
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current ?? null;
  }
  throw new TaskDriverError(`${what} uses an unsupported value source '${raw.from}'`);
}

/**
 * Resolves one delivery-identity field: a queue identity must be a
 * bounded non-empty string, or the engine cannot recognize its own job.
 *
 * Args:
 *   raw: the compiled InputValue.
 *   subjects: the lease's fixture subjects.
 *   what: field name for diagnostics.
 *
 * Returns:
 *   string: the resolved identity.
 *
 * @throws TaskDriverError the value is not a bounded non-empty string.
 */
function resolveIdentity(
  raw: { from: string; value?: unknown; key?: string },
  subjects: Record<string, unknown>,
  what: string,
): string {
  const resolved = resolveDeclaredValue(raw, subjects, what);
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new TaskDriverError(`${what} must resolve to a non-empty string`);
  }
  if (resolved.length > MAX_QUEUE_FIELD_CHARS) {
    throw new TaskDriverError(`${what} exceeds the ${String(MAX_QUEUE_FIELD_CHARS)}-character queue bound`);
  }
  return resolved;
}

/**
 * Sleeps for the observer's sampling interval (a bounded read wait, not
 * open-ended polling: the loop is bounded by the terminal timeout).
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/**
 * Produces the declared deliveries and reads the queue back until every
 * produced job reaches a terminal state (or the bound expires).
 *
 * The idempotency key is the SAME for every delivery of one case —
 * that is what makes a duplicate-key case a duplicate — while each
 * delivery gets its own identity, so the engine can tell its own jobs
 * apart.
 *
 * Args:
 *   action: the compiled `deliver` action.
 *   attemptBound: the declared attempt bound (from the case's `attempts` rule).
 *   subjects: the lease's fixture subjects.
 *   channel: the engine's queue channel.
 *   pollIntervalMs: transition-sampling interval.
 *   terminalTimeoutMs: bound on waiting for settlement.
 *
 * Returns:
 *   TaskDeliveryResult: the sealed observation plus delivered values.
 *
 * @throws TaskDriverError on an undeclared queue, an illegal identity,
 *   an unbounded observation, or an over-long sample timeline.
 */
export async function driveTaskDelivery(input: {
  action: TaskDeliverAction;
  attemptBound: number;
  subjects: Record<string, unknown>;
  channel: QueueChannel;
  pollIntervalMs: number;
  terminalTimeoutMs: number;
}): Promise<TaskDeliveryResult> {
  const { action, channel, pollIntervalMs, terminalTimeoutMs } = input;
  const observer = channel.observer;
  const queue = observer.queueFor(action.resourceId);
  const deliveryBase = resolveIdentity(action.deliveryId, input.subjects, 'deliveryId');
  const idempotencyKey = resolveIdentity(action.idempotencyKey, input.subjects, 'idempotencyKey');
  const payloadRaw = resolveDeclaredValue(action.payload, input.subjects, 'payload');
  const payload =
    payloadRaw !== null && typeof payloadRaw === 'object' && !Array.isArray(payloadRaw)
      ? (payloadRaw as Record<string, unknown>)
      : { value: payloadRaw };
  if (!Number.isInteger(input.attemptBound) || input.attemptBound < 1) {
    throw new TaskDriverError("the case declares no 'attempts' rule, so the engine cannot stamp an attempt bound");
  }
  const deliveryIds = Array.from({ length: action.count }, (_unused, index) => `${deliveryBase}#${String(index + 1)}`);
  const pending: Promise<QueueDeliveryReceipt>[] = [];
  const produced: QueueDeliveryReceipt[] = [];
  for (const deliveryId of deliveryIds) {
    const delivery = channel.deliverer.enqueue({
      queue,
      deliveryId,
      idempotencyKey,
      payload,
      maxAttempts: input.attemptBound,
    });
    // A serial schedule waits for each receipt before producing the
    // next delivery; a concurrent one produces them all and awaits.
    if (action.schedule === 'serial') produced.push(await delivery);
    else pending.push(delivery);
  }
  const receipts = [...produced, ...(await Promise.all(pending))];
  const startedAt = Date.now();
  const samples: QueueJobSample[] = [];
  const jobIds = receipts.map((receipt) => receipt.jobId);
  let settled = false;
  while (!settled && Date.now() - startedAt < terminalTimeoutMs) {
    settled = true;
    for (const jobId of jobIds) {
      const job = await observer.readJob(queue, jobId);
      if (job === null) {
        throw new TaskDriverError(`produced job '${jobId}' vanished from queue '${queue}' before it settled`);
      }
      // Every sample is sealed, not only changed ones: a queue that
      // hands the SAME job out again (a lost-worker reclaim) is exactly
      // the transition a "changed only" filter would hide. The record is
      // bounded by MAX_QUEUE_SAMPLES, over which the engine fails
      // closed rather than truncating a timeline.
      samples.push({
        jobId: job.jobId,
        state: job.state,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        atMs: Math.max(0, Date.now() - startedAt),
      });
      if (samples.length > MAX_QUEUE_SAMPLES) {
        throw new TaskDriverError(
          `the delivery produced more than ${String(MAX_QUEUE_SAMPLES)} observations — the timeline is unbounded (fail closed)`,
        );
      }
      if (!TERMINAL_QUEUE_JOB_STATES.has(job.state)) settled = false;
    }
    if (!settled) await delay(pollIntervalMs);
  }
  const listed = await observer.listJobs(queue);
  if (!listed.complete) {
    throw new TaskDriverError(`queue '${queue}' holds more jobs than the engine's bounded list read allows (fail closed)`);
  }
  const producedIds = new Set(deliveryIds);
  const jobs: QueueJobObservation[] = listed.jobs.filter(
    (job) => (job.deliveryId !== null && producedIds.has(job.deliveryId)) || job.idempotencyKey === idempotencyKey,
  );
  const waitedMs = Math.max(0, Date.now() - startedAt);
  const complete = settled && jobs.length === deliveryIds.length;
  return {
    observation: { kind: observer.kind, queue, deliveryIds, jobs, samples, complete, waitedMs },
    submittedValues: {
      resourceId: action.resourceId,
      queue,
      payload,
      deliveryId: deliveryBase,
      idempotencyKey,
      count: action.count,
      schedule: action.schedule,
      maxAttempts: input.attemptBound,
    },
  };
}
