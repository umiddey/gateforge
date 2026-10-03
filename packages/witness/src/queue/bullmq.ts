/**
 * BullMQ implementation of the witness queue channel: the engine reads
 * the queue itself over one Redis
 * connection, and produces its own deliveries so a task case grades
 * state the ENGINE created, not state the suite claims.
 *
 * Everything the engine cannot normalize fails closed
 * (`QueueObserverError`): an unrecognized job state, an unbounded
 * field, an unbounded list. A partial read is a diagnostic, never a
 * proof.
 */
import { randomUUID } from 'node:crypto';
import { Queue, type Job } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { Redis } from 'ioredis';
import {
  DEFAULT_QUEUE_LIST_LIMIT,
  MAX_QUEUE_FIELD_CHARS,
  MAX_QUEUE_LIST_LIMIT,
  QUEUE_JOB_STATES,
  type QueueJobObservation,
  type QueueJobState,
  type QueueObserverConfig,
} from '@gate-forge/core';
import {
  QueueObserverError,
  boundedQueueField,
  type QueueChannel,
  type QueueDeliveryReceipt,
  type QueueDeliveryRequest,
  type QueueJobList,
  type QueueStateObserver,
} from './observer.js';

/** BullMQ job states, mapped onto the normalized vocabulary. */
const STATE_MAP: Readonly<Record<string, QueueJobState>> = {
  completed: 'completed',
  failed: 'failed',
  delayed: 'delayed',
  active: 'active',
  waiting: 'waiting',
  'waiting-children': 'waiting',
  prioritized: 'prioritized',
  paused: 'paused',
  'waiting-active': 'active',
};

/** The queue job payload key carrying the engine's delivery identity. */
export const DELIVERY_ID_KEY = 'gateforgeDeliveryId';

/** The queue job payload key carrying the engine's idempotency key. */
export const IDEMPOTENCY_KEY_KEY = 'gateforgeIdempotencyKey';

/**
 * The BullMQ job types a bounded list read covers. A paused queue
 * holds its jobs in BullMQ's paused list, which this read does not
 * enumerate: a paused delivery is therefore invisible here. Every
 * delivered job is read by id first, so a pause still shows up as a
 * non-terminal state there.
 */
const LISTED_JOB_TYPES = [
  'waiting',
  'waiting-children',
  'active',
  'prioritized',
  'delayed',
  'completed',
  'failed',
] as const;

/** The BullMQ job name every engine-produced delivery carries. */
export const BULLMQ_DELIVERY_JOB_NAME = 'gateforge-delivery';

/** The BullMQ connection material (host/port, or a Redis URL). */
export type BullmqConnection = { host: string; port: number } | { url: string };

/**
 * Normalizes one BullMQ state, failing closed on anything unknown.
 *
 * Args:
 *   state: the state BullMQ reported.
 *
 * Returns:
 *   QueueJobState: the normalized state.
 *
 * @throws QueueObserverError the state is not in the normalized vocabulary.
 */
function normalizeState(state: string): QueueJobState {
  const mapped = STATE_MAP[state];
  if (mapped === undefined) {
    throw new QueueObserverError(
      `bullmq reported job state '${state}', which has no normalized meaning (fail closed)`,
    );
  }
  return mapped;
}

/**
 * Projects one BullMQ job into the bounded engine observation. Every
 * field is read from the QUEUE, never from the producer's own report.
 *
 * Args:
 *   job: the BullMQ job handle.
 *   state: its normalized state.
 *
 * Returns:
 *   QueueJobObservation: the bounded observation.
 *
 * @throws QueueObserverError a field is unbounded or the wrong type.
 */
function observeJob(job: Job, state: QueueJobState): QueueJobObservation {
  const attemptsMade = job.attemptsMade;
  const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0 ? job.opts.attempts : null;
  return {
    jobId: boundedQueueField(job.id, 'jobId') ?? '',
    deliveryId: boundedQueueField((job.data as Record<string, unknown>)[DELIVERY_ID_KEY] ?? null, 'deliveryId'),
    idempotencyKey: boundedQueueField((job.data as Record<string, unknown>)[IDEMPOTENCY_KEY_KEY] ?? null, 'idempotencyKey'),
    state,
    attemptsMade:
      typeof attemptsMade === 'number' && Number.isInteger(attemptsMade) && attemptsMade >= 0
        ? attemptsMade
        : (() => {
            throw new QueueObserverError(`bullmq job '${String(job.id)}' reported a non-integer attempt count (fail closed)`);
          })(),
    maxAttempts,
    failedReason: boundedQueueField(job.failedReason, 'failedReason'),
    processedAt: typeof job.processedOn === 'number' && Number.isInteger(job.processedOn) ? job.processedOn : null,
  };
}

/**
 * Opens the BullMQ channel over one connection. One `Queue` handle per
 * declared queue; every handle is closed exactly once.
 *
 * Args:
 *   config: the validated engine-owned configuration.
 *   connection: host/port or URL connection material.
 *
 * Returns:
 *   QueueChannel: the opened observer + deliverer.
 */
export function createBullmqChannel(config: QueueObserverConfig, connection: BullmqConnection): QueueChannel {
  const clientsByName = new Map<string, Redis>();
  const queueByName = new Map<string, Queue>();
  const bindings = new Map<string, string>();
  for (const binding of config.queues) {
    if (bindings.has(binding.taskResourceId)) {
      throw new QueueObserverError(
        `task resource '${binding.taskResourceId}' is bound to more than one queue (fail closed)`,
      );
    }
    bindings.set(binding.taskResourceId, binding.name);
  }
  const queueFor = (name: string): Queue => {
    const existing = queueByName.get(name);
    if (existing !== undefined) return existing;
    // An explicit client instance: BullMQ's CJS dynamic require of
    // ioredis does not resolve in this ESM package, and a constructed
    // client is the documented ESM form.
    // ioredis takes the URL as its first argument (a `{url}` option is
    // ignored and silently falls back to localhost).
    const client =
      'url' in connection
        ? new Redis(connection.url, { maxRetriesPerRequest: null })
        : new Redis({ ...connection, maxRetriesPerRequest: null } as RedisOptions);
    clientsByName.set(name, client);
    const created = new Queue(name, { connection: client });
    queueByName.set(name, created);
    return created;
  };
  const close = async (): Promise<void> => {
    const handles = [...queueByName.values()];
    const clients = [...clientsByName.values()];
    queueByName.clear();
    clientsByName.clear();
    await Promise.all(handles.map((handle) => handle.close()));
    await Promise.all(clients.map((client) => client.quit()));
  };
  const observer: QueueStateObserver = {
    kind: 'bullmq',
    queueFor: (taskResourceId: string): string => {
      const queue = bindings.get(taskResourceId);
      if (queue === undefined) {
        throw new QueueObserverError(
          `task resource '${taskResourceId}' has no declared queue binding (fail closed)`,
        );
      }
      return queue;
    },
    readJob: async (queue: string, jobId: string): Promise<QueueJobObservation | null> => {
      const job = await queueFor(queue).getJob(jobId);
      if (job === undefined) return null;
      return observeJob(job, normalizeState(await job.getState()));
    },
    listJobs: async (queue: string, limit: number = DEFAULT_QUEUE_LIST_LIMIT): Promise<QueueJobList> => {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUEUE_LIST_LIMIT) {
        throw new QueueObserverError(
          `queue list limit ${String(limit)} is outside [1, ${String(MAX_QUEUE_LIST_LIMIT)}] (fail closed)`,
        );
      }
      const jobs = await queueFor(queue).getJobs([...LISTED_JOB_TYPES], 0, limit, false);
      if (jobs.length >= limit) {
        // A full page may be exactly the queue's size, so the read is
        // reported as incomplete rather than pretending it is exact.
        return { jobs: [], complete: false, count: jobs.length };
      }
      const observed: QueueJobObservation[] = [];
      for (const job of jobs) {
        observed.push(observeJob(job, normalizeState(await job.getState())));
      }
      return { jobs: observed, complete: true, count: observed.length };
    },
    close,
  };
  const deliverer = {
    enqueue: async (request: QueueDeliveryRequest): Promise<QueueDeliveryReceipt> => {
      if (request.deliveryId.length === 0 || request.deliveryId.length > MAX_QUEUE_FIELD_CHARS) {
        throw new QueueObserverError('the engine delivery identity is missing or over the bound (fail closed)');
      }
      if (request.idempotencyKey.length === 0 || request.idempotencyKey.length > MAX_QUEUE_FIELD_CHARS) {
        throw new QueueObserverError('the engine idempotency key is missing or over the bound (fail closed)');
      }
      if (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1) {
        throw new QueueObserverError('the declared attempt bound must be a positive integer (fail closed)');
      }
      // BullMQ forbids ':' in a custom job id, so the job id stays
      // engine-generated and the owner's identity rides in the data.
      const job = await queueFor(request.queue).add(
        BULLMQ_DELIVERY_JOB_NAME,
        {
          ...request.payload,
          [DELIVERY_ID_KEY]: request.deliveryId,
          [IDEMPOTENCY_KEY_KEY]: request.idempotencyKey,
        },
        {
          attempts: request.maxAttempts,
          jobId: `gf-${randomUUID()}`,
          // Retained so the engine can read a finished job back: a
          // removed job would leave the case unprovable.
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
      return { jobId: String(job.id), deliveryId: request.deliveryId, idempotencyKey: request.idempotencyKey };
    },
    close,
  };
  return { observer, deliverer };
}
