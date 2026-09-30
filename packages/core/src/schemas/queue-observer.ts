/**
 * Queue-observer schemas (plan 20260925-2011 Phase 3): the OWNER
 * declaration that binds a task resource to the queue the engine
 * reads, plus the SEALED observation vocabulary the engine's own
 * bounded reads are graded against. One schema, parsed by the CLI at
 * config time AND by the witness when it opens the channel from its
 * own environment, so a typo is a config error (never a silent
 * default) and the two sides can never disagree about what was
 * declared.
 *
 * Connection material never carries a secret inline: the URL form names
 * an environment variable the witness process resolves privately, and
 * the value is never sealed into a record, a report, or argv.
 */
import { z } from 'zod';

/**
 * The SEALED observation vocabulary. The witness reads the queue and
 * seals what it read; the grader re-derives every task verdict from
 * these fields alone. A suite-submitted "the job succeeded" cannot
 * produce this shape — only the engine's own bounded reads can.
 *
 * Normalized states are library-independent on purpose: every
 * implementation maps its backend's own vocabulary onto these seven,
 * and an unrecognized backend state is a hard failure (fail closed),
 * never a silent mapping.
 */

/** Normalized job states an observer may report. */
export const QUEUE_JOB_STATES = [
  'waiting',
  'delayed',
  'prioritized',
  'active',
  'completed',
  'failed',
  'paused',
] as const;

/** Inferred normalized job state. */
export type QueueJobState = (typeof QUEUE_JOB_STATES)[number];

/** States a delivery may never leave while the engine waits. */
export const TERMINAL_QUEUE_JOB_STATES: ReadonlySet<QueueJobState> = new Set(['completed', 'failed']);

/** Hard bound on one observed field value (over it, fail closed). */
export const MAX_QUEUE_FIELD_CHARS = 512;

/** Default bound for one bounded list read. */
export const DEFAULT_QUEUE_LIST_LIMIT = 200;

/** Hard bound for one bounded list read (over it, fail closed). */
export const MAX_QUEUE_LIST_LIMIT = 1000;

/**
 * Hard bound on the sealed observations of one delivery. One sample per
 * polling tick, so a default 200 ms sampling interval and a 30 s settle
 * bound sit well inside it; a longer wait fails closed rather than
 * truncating the timeline a stall claim reads.
 */
export const MAX_QUEUE_SAMPLES = 2048;

/** One engine-read job observation (bounded fields only). */
export const QueueJobObservationSchema = z
  .object({
    /** Queue-native job id. */
    jobId: z.string().min(1),
    /** Delivery identity the engine stamped, or null when the job carries none. */
    deliveryId: z.string().min(1).nullable(),
    /** Idempotency key the engine stamped, or null when the job carries none. */
    idempotencyKey: z.string().min(1).nullable(),
    /** Normalized state. */
    state: z.enum(QUEUE_JOB_STATES),
    /** Attempts the queue has made for this job. */
    attemptsMade: z.number().int().min(0),
    /** Declared attempt bound, or null when the queue declares none. */
    maxAttempts: z.number().int().min(1).nullable(),
    /** Bounded failure reason (never a raw stack). */
    failedReason: z.string().min(1).nullable(),
    /** Engine-observed processing timestamp (ms) or null. */
    processedAt: z.number().int().min(0).nullable(),
  })
  .strict();

/** Inferred job-observation shape. */
export type QueueJobObservation = z.infer<typeof QueueJobObservationSchema>;

/**
 * One sampled observation of a job with the engine's own elapsed time.
 * Samples are NOT deduplicated: a queue that hands the same job out a
 * second time (a lost-worker reclaim) is exactly the transition a
 * "changed only" filter would hide. The record stays bounded by
 * {@link MAX_QUEUE_SAMPLES}, over which the engine fails closed.
 */
export const QueueJobSampleSchema = z
  .object({
    /** Queue-native job id. */
    jobId: z.string().min(1),
    /** Normalized state at sampling time. */
    state: z.enum(QUEUE_JOB_STATES),
    /** Attempts made at sampling time. */
    attemptsMade: z.number().int().min(0),
    /** Bounded failure reason at sampling time (null when unset). */
    failedReason: z.string().min(1).nullable(),
    /** Engine-side elapsed milliseconds since the delivery was produced. */
    atMs: z.number().int().min(0),
  })
  .strict();

/** Inferred job-sample shape. */
export type QueueJobSample = z.infer<typeof QueueJobSampleSchema>;

/**
 * The engine's sealed read of one delivery's jobs. `complete:false`
 * means the engine stopped waiting before every job settled: that can
 * never satisfy a task rule, and it is sealed as a diagnostic rather
 * than a partial proof.
 */
export const QueueObservationSchema = z
  .object({
    /** Observer implementation kind (`bullmq` or a declared module). */
    kind: z.string().min(1),
    /** The queue the engine read. */
    queue: z.string().min(1),
    /** Engine-stamped delivery identities, in production order. */
    deliveryIds: z.array(z.string().min(1)).min(1),
    /** Final engine read of every produced job. */
    jobs: z.array(QueueJobObservationSchema).min(1),
    /** Every distinct transition the engine sampled, in order. */
    samples: z.array(QueueJobSampleSchema),
    /** True when every job reached a terminal state before the bound. */
    complete: z.boolean(),
    /** Engine-side elapsed milliseconds spent waiting for settlement. */
    waitedMs: z.number().int().min(0),
  })
  .strict();

/** Inferred queue-observation shape. */
export type QueueObservation = z.infer<typeof QueueObservationSchema>;

/** One approved queue binding: task resource id → queue name. */
export const QueueBindingSchema = z
  .object({
    /** Queue name as the backend knows it. */
    name: z.string().min(1),
    /** Task resource id the owner maps this queue to. */
    taskResourceId: z.string().min(1),
  })
  .strict();

/** Inferred queue-binding shape. */
export type QueueBinding = z.infer<typeof QueueBindingSchema>;

/** Redis connection material: host/port, or an env var holding the URL. */
export const QueueConnectionSchema = z.union([
  z
    .object({ host: z.string().min(1), port: z.number().int().min(1).max(65_535) })
    .strict(),
  z.object({ urlEnv: z.string().min(1) }).strict(),
]);

/** Inferred queue-connection shape. */
export type QueueConnection = z.infer<typeof QueueConnectionSchema>;

/** The `.gateforge.yml` `queueObserver` block (also the witness env JSON). */
export const QueueObserverConfigSchema = z
  .object({
    /**
     * `bullmq` (the built-in implementation) or a module path whose
     * default export is a `(spec) => QueueChannel` factory.
     */
    kind: z.string().min(1),
    /** Connection material (no inline secret). */
    connection: QueueConnectionSchema,
    /** Approved queue bindings; an unknown task resource id fails closed. */
    queues: z.array(QueueBindingSchema).min(1),
    /** Transition-sampling interval in ms (default 200). */
    pollIntervalMs: z.number().int().min(10).max(10_000).optional(),
    /** Bound on waiting for every job of a delivery to settle. */
    terminalTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  })
  .strict();

/** Inferred queue-observer configuration. */
export type QueueObserverConfig = z.infer<typeof QueueObserverConfigSchema>;

/** Environment variable naming the queue observer (built-in or module). */
export const QUEUE_OBSERVER_ENV = 'GATEFORGE_QUEUE_OBSERVER';

/** Environment variable carrying the JSON queue-observer configuration. */
export const QUEUE_OBSERVER_CONFIG_ENV = 'GATEFORGE_QUEUE_OBSERVER_CONFIG';

/** Default observer poll interval (transition sampling). */
export const DEFAULT_QUEUE_POLL_INTERVAL_MS = 200;

/** Default bound on waiting for every job of a delivery to settle. */
export const DEFAULT_QUEUE_TERMINAL_TIMEOUT_MS = 30_000;

/**
 * Parses a queue-observer configuration, failing closed with a message
 * naming every illegal field.
 *
 * Args:
 *   raw: the JSON text (witness env form).
 *
 * Returns:
 *   QueueObserverConfig: the validated configuration.
 *
 * Throws:
 *   Error: malformed JSON or an illegal field (fail closed).
 */
export function parseQueueObserverConfigJson(raw: string): QueueObserverConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${QUEUE_OBSERVER_CONFIG_ENV} is not valid JSON (fail closed)`);
  }
  const result = QueueObserverConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${QUEUE_OBSERVER_CONFIG_ENV} is not a valid queue-observer configuration: ${detail} (fail closed)`);
  }
  return result.data;
}
