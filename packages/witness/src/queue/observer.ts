/**
 * Witness-owned queue-state observer (plan 20260925-2011 Phase 3): the
 * engine's INDEPENDENT trusted read of a background job's delivery
 * state. A task contract is a claim about the queue, so the engine must
 * read the queue itself — a suite-submitted "the job succeeded" is never
 * proof, exactly like a suite-submitted HTTP status.
 *
 * The shape follows the DB/evidence adapters: a narrow read interface,
 * one implementation per queue library, and a fail-closed rule for
 * everything unexpected.
 *
 * - `readJob` reads ONE job by id (state, attempts, bounded fields);
 * - `listJobs` reads a BOUNDED slice of one queue and reports whether
 *   the read was exhaustive (a truncated list can never prove a set);
 * - unknown states, over-bound fields, and over-bound lists raise
 *   `QueueObserverError` — a blocking diagnostic, never a partial
 *   observation;
 * - `enqueue` is the engine's WRITE side: the engine produces the
 *   delivery it will later grade, so a task case never grades the
 *   suite's own enqueue.
 *
 * The channel is opened ONLY from the engine-owned configuration
 * (`GATEFORGE_QUEUE_OBSERVER` + `GATEFORGE_QUEUE_OBSERVER_CONFIG` in the
 * witness process, supplied by the supervisor from the repository's
 * `queueObserver` block). With no configuration there is no channel and
 */
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_QUEUE_LIST_LIMIT,
  DEFAULT_QUEUE_POLL_INTERVAL_MS,
  DEFAULT_QUEUE_TERMINAL_TIMEOUT_MS,
  MAX_QUEUE_FIELD_CHARS,
  MAX_QUEUE_LIST_LIMIT,
  QUEUE_OBSERVER_CONFIG_ENV,
  QUEUE_OBSERVER_ENV,
  parseQueueObserverConfigJson,
  type QueueBinding,
  type QueueJobObservation,
  type QueueJobState,
  type QueueObserverConfig,
} from '@gate-forge/core';

/** One bounded list read: the jobs plus whether the read was complete. */
export interface QueueJobList {
  /** Observed jobs, in queue order. */
  jobs: QueueJobObservation[];
  /** False when the queue held more jobs than the bound (never proof). */
  complete: boolean;
  /** Engine-side count of jobs read. */
  count: number;
}
import { createBullmqChannel } from './bullmq.js';

/** Blocking queue-channel failure (always a diagnostic, never proof). */
export class QueueObserverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueObserverError';
  }
}

/** The engine's independent queue read. */
export interface QueueStateObserver {
  /** Implementation kind (`bullmq` or a module's declared name). */
  readonly kind: string;
  /** Resolves the approved queue name for a task resource id. */
  queueFor(taskResourceId: string): string;
  /** Reads one job by id; null when the queue has no such job. */
  readJob(queue: string, jobId: string): Promise<QueueJobObservation | null>;
  /** Reads a bounded slice of one queue. */
  listJobs(queue: string, limit?: number): Promise<QueueJobList>;
  /** Releases connections (idempotent; never flips a verdict). */
  close(): Promise<void>;
}

/** One engine-produced delivery. */
export interface QueueDeliveryRequest {
  /** Approved queue name for the task resource. */
  queue: string;
  /** Engine-stamped delivery identity (groups the jobs of one delivery). */
  deliveryId: string;
  /** Engine-stamped idempotency key. */
  idempotencyKey: string;
  /** Bounded job payload. */
  payload: Record<string, unknown>;
  /** Declared attempt bound for the produced job. */
  maxAttempts: number;
}

/** One produced delivery. */
export interface QueueDeliveryReceipt {
  /** Queue-native job id of the produced job. */
  jobId: string;
  /** The delivery identity the engine stamped. */
  deliveryId: string;
  /** The idempotency key the engine stamped. */
  idempotencyKey: string;
}

/** The engine's queue WRITE side (the delivery it will later grade). */
export interface QueueDeliverer {
  /** Produces one delivery and returns its engine-observed receipt. */
  enqueue(request: QueueDeliveryRequest): Promise<QueueDeliveryReceipt>;
  /** Releases connections (idempotent; never flips a verdict). */
  close(): Promise<void>;
}

/** Observer + deliverer over one configured queue backend. */
export interface QueueChannel {
  /** The independent read. */
  readonly observer: QueueStateObserver;
  /** The engine-produced delivery. */
  readonly deliverer: QueueDeliverer;
}

/**
 * Bounds one observed string field (fail closed, never a truncated hash
 * of an over-long value).
 *
 * Args:
 *   value: the observed value.
 *   what: field name for the diagnostic.
 *
 * Returns:
 *   string | null: the bounded string, or null when absent.
 *
 * @throws QueueObserverError the value is not a string or exceeds the bound.
 */
export function boundedQueueField(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new QueueObserverError(`queue field '${what}' is not a string (fail closed)`);
  }
  if (value.length > MAX_QUEUE_FIELD_CHARS) {
    throw new QueueObserverError(
      `queue field '${what}' exceeds the ${String(MAX_QUEUE_FIELD_CHARS)}-character bound (fail closed)`,
    );
  }
  return value;
}

/**
 * Resolves a declared URL from the witness process environment.
 *
 * Args:
 *   config: the validated engine-owned configuration.
 *   env: the witness process environment.
 *
 * Returns:
 *   {host, port} | {url}: the connection material for the backend.
 *
 * @throws QueueObserverError the named environment variable is unset.
 */
export function resolveQueueConnection(
  config: QueueObserverConfig,
  env: NodeJS.ProcessEnv,
): { host: string; port: number } | { url: string } {
  if ('urlEnv' in config.connection) {
    const url = env[config.connection.urlEnv];
    if (typeof url !== 'string' || url.length === 0) {
      throw new QueueObserverError(
        `queue observer connection env '${config.connection.urlEnv}' is unset in the witness process (fail closed)`,
      );
    }
    return { url };
  }
  return { host: config.connection.host, port: config.connection.port };
}

/** The factory shape a custom queue-observer module must export. */
export type QueueChannelFactory = (config: QueueObserverConfig) => Promise<QueueChannel> | QueueChannel;

/**
 * Opens the configured queue channel. Built-in `bullmq` first; any
 * other value is a module path whose default export is a factory.
 *
 * Args:
 *   config: the validated engine-owned configuration.
 *   env: the witness process environment (URL connection form only).
 *
 * Returns:
 *   Promise<QueueChannel>: the opened channel.
 *
 * @throws QueueObserverError on an unknown kind, an unloadable module,
 *   or a module that does not return a conforming channel (fail closed).
 */
export async function openQueueChannel(
  config: QueueObserverConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QueueChannel> {
  if (config.kind === 'bullmq') {
    return createBullmqChannel(config, resolveQueueConnection(config, env));
  }
  // The module path is operator-supplied at run time, so no static
  // import specifier exists at author time.
  const module = (await import(pathToFileURL(config.kind).href)) as { default?: unknown };
  if (typeof module.default !== 'function') {
    throw new QueueObserverError(
      `queue observer module '${config.kind}' has no default-exported factory (fail closed)`,
    );
  }
  const channel = await (module.default as QueueChannelFactory)(config);
  if (
    channel === null ||
    typeof channel !== 'object' ||
    channel.observer === null ||
    typeof channel.observer !== 'object' ||
    typeof channel.observer.readJob !== 'function' ||
    typeof channel.observer.listJobs !== 'function' ||
    typeof channel.observer.queueFor !== 'function' ||
    channel.deliverer === null ||
    typeof channel.deliverer !== 'object' ||
    typeof channel.deliverer.enqueue !== 'function'
  ) {
    throw new QueueObserverError(
      `queue observer module '${config.kind}' did not return a conforming channel (fail closed)`,
    );
  }
  return channel;
}

/**
 * Opens the channel named by the witness process environment, or null
 * when no queue observer is configured (the fail-closed default: every
 * `engine-task` case then blocks with a naming diagnostic).
 *
 * Args:
 *   env: the witness process environment.
 *
 * Returns:
 *   Promise<QueueChannel | null>: the configured channel, or null.
 *
 * @throws QueueObserverError the configuration is present but illegal.
 */
export async function openConfiguredQueueChannel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<QueueChannel | null> {
  const kind = env[QUEUE_OBSERVER_ENV];
  const raw = env[QUEUE_OBSERVER_CONFIG_ENV];
  if (kind === undefined || kind === '') return null;
  if (raw === undefined || raw === '') {
    throw new QueueObserverError(`${QUEUE_OBSERVER_CONFIG_ENV} is required when a queue observer is named (fail closed)`);
  }
  const config = parseQueueObserverConfigJson(raw);
  if (config.kind !== kind) {
    throw new QueueObserverError(
      `${QUEUE_OBSERVER_ENV} ('${kind}') does not match the configured observer kind ('${config.kind}') (fail closed)`,
    );
  }
  return openQueueChannel(config, env);
}

export {
  DEFAULT_QUEUE_LIST_LIMIT,
  DEFAULT_QUEUE_POLL_INTERVAL_MS,
  DEFAULT_QUEUE_TERMINAL_TIMEOUT_MS,
  MAX_QUEUE_FIELD_CHARS,
  MAX_QUEUE_LIST_LIMIT,
  QUEUE_OBSERVER_CONFIG_ENV,
  QUEUE_OBSERVER_ENV,
  type QueueBinding,
  type QueueJobObservation,
  type QueueJobState,
  type QueueObserverConfig,
};

/** The engine-owned queue-observer configuration. */
export type QueueObserverSpec = QueueObserverConfig;
