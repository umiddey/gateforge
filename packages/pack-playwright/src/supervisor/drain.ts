/**
 * The supervisor's spool drain (enforcement-review fix 3): while the
 * supervised runner executes, the trusted CLI polls the runner-side
 * lifecycle spool and performs the witness's SUPERVISOR calls itself —
 * session open on `testBegin`, session close with the observed outcome
 * on `testEnd`. The runner child holds no supervisor rights at all: it
 * writes spool events (identities and outcomes, no secrets), and the
 * witness accepts session lifecycle ONLY from this verifier-key-
 * authenticated channel. On stop, the drain performs a final sweep and
 * force-closes any session the runner left open (a crashed worker can
 * never leave the witness holding an open session past the run).
 *
 * WORKER-SIDE END (the serial-project race): a runner's MAIN process
 * can report test N's end long after the worker already started test
 * N+1 of the same file, so a drain that waits for that end leaves the
 * next test's begin queued behind a cross-process event the worker
 * does not control (a loaded machine made the next test's session
 * resolve time out). A worker therefore also spools the end of the
 * test IT just finished — same process, same order as its own begin,
 * and with no outcome (only the runner's reporter knows that). The
 * drain RELEASES the worker slot on that end: the session stops
 * accepting submissions and its proxy dies at once, so nothing can be
 * attributed to a finished test, and the next begin opens
 * immediately. The runner's own `testEnd` still seals that session
 * moments later, with the observed outcome; an outcome that never
 * arrives leaves the session outcome-less, which grades not-passed
 * exactly like a seal without an outcome. Nothing is credited early
 * and nothing is dropped: a release carries no verdict, and the
 * lifecycle still fails closed on an outcome with no begin, a begin
 * with no end at run end, and two different outcomes for one test.
 *
 * SERVER-WITNESSED persistence channel: the drain also polls the
 * persistence-intents spool (`persistence-intents.jsonl` — claim INTENTS
 * the supervised suite may only WRITE) and forwards each one to the
 * witness's verifier-key surface, where the adapter SERVER PROBE runs
 * witness-side. When `serverE2eObligations` is supplied (the trusted
 * mapping layer's `kind: server-e2e` declarations), the drain registers
 * them BEFORE forwarding anything: the witness then stamps witnessed
 * `channel: 'server'` persistence records for those obligations only.
 * A refused/failed intent resolves to a typed failure recorded here and
 * in the logs — never to satisfaction (fail closed; the claim simply
 * stays blocking).
 *
 * OBSERVE channel (Phase 2): when `observeObligations` is supplied (the
 * trusted mapping layer's `kind: observed-e2e` declarations), the drain
 * registers them pre-run, then finalizes each PASSED test's session
 * before sealing it — the witness resolves the session's own proxied
 * traffic plus independent adapter reads into witnessed
 * `channel: 'observe'` records. Finalize notes (missing traffic,
 * ambiguity, adapter trouble) are collected for the run report — they
 * are diagnostics, never run-fatal: the obligation stays blocking
 * through verdicts, which is the honest outcome. Failed/crashed tests
 * never finalize (no evidence for unfinished work).
 */
import { CAUSE_NEXT_ACTIONS, type CauseCode } from '@gate-forge/core';
import { WitnessRequestError } from '../fixture/witness-client.js';
import { SupervisorClient } from './client.js';
import {
  persistenceIntentsPathFor,
  readPersistenceIntents,
  readSpoolEvents,
  spoolPathFor,
  type PersistenceIntent,
  type SpoolEvent,
} from './spool.js';

/** Default cadence between spool polls (the fixture's resolve waits 5s). */
export const DEFAULT_DRAIN_POLL_MS = 50;

/** One open worker slot the drain is tracking. */
interface OpenSlot {
  sessionId: string;
  testId: string;
}

/** Handle for a running drain (see {@link startSupervisorSpoolDrain}). */
export interface SpoolDrainHandle {
  /**
   * Stops the drain: performs one final sweep of both spools (lifecycle
   * events AND persistence intents), then force-closes every session the
   * runner left open (outcome unknown — the supervisor did not observe a
   * completed test). Resolves with the lifecycle CONFLICTS observed
   * (empty in a genuine run): a re-begin over an open worker slot, an
   * end without a matching begin, or a second end for the same test —
   * plus the TYPED server-persistence intent failures (each names the
   * intent, the witness cause, and the next action), plus the OBSERVE
   * finalize notes (per-session non-resolutions — diagnostics, never
   * run-fatal). Genuine serial reporter events never conflict — any
   * conflict is worker-side forgery or runner confusion and must fail
   * the run closed downstream.
   */
  stop: () => Promise<{ conflicts: string[]; intentFailures: string[]; observeNotes: string[] }>;
  /**
   * Waits until the witness has ANSWERED the first `count` drained
   * persistence intents (refusals included — a typed refusal is an
   * answer and lands in `intentFailures`).
   *
   * This is the trusted drain's own forward progress, not a runner-side
   * signal: the supervised child only appends to the spool and can
   * neither observe nor influence it. A caller that must not mutate the
   * target between a `pre` intent and the state the witness probes uses
   * this instead of a guessed sleep — once it resolves, the witness has
   * already run (and answered) that intent's server-side probe.
   *
   * Args:
   *   count: how many drained intents must have been answered.
   *   timeoutMs: bound on the wait; the default is generous and only
   *     fires when the witness is unreachable, never in a genuine run.
   *
   * Returns:
   *   Promise<void>: resolves as soon as the count is reached; rejects
   *     with a descriptive Error when the bound elapses first.
   */
  whenIntentsForwarded: (count: number, timeoutMs?: number) => Promise<void>;
}

/**
 * Starts the spool drain loop for one supervised run.
 *
 * Args:
 *   options: stateDir + runId locate the spools; witnessUrl/runToken/
 *     verifierKey authenticate the supervisor channel; pollMs tunes the
 *     poll cadence (tests only); serverE2eObligations, when provided,
 *     are registered BEFORE any intent forwarding (the trusted mapping
 *     layer's `kind: server-e2e` declarations — the witness stamps
 *     server-channel records for these obligations only).
 *
 * Returns:
 *   SpoolDrainHandle: awaitable stop (final drain + force-close).
 */
export function startSupervisorSpoolDrain(options: {
  stateDir: string;
  runId: string;
  witnessUrl: string;
  runToken: string;
  verifierKey: string;
  pollMs?: number;
  serverE2eObligations?: readonly string[];
  /**
   * Optional observer of every DRAINED lifecycle event, called before
   * the drain acts on it. This is how the CLI's CI progress stream
   * learns what the suite is doing without ever reading runner output:
   * the event carries the identity, the outcome, and (additively) the
   * runner's own error message and short stack frames. It is advisory —
   * a throwing observer is reported and ignored, because no progress
   * line may ever fail a run.
   */
  onTestEvent?: (event: SpoolEvent) => void;
  observeObligations?: readonly string[];
}): SpoolDrainHandle {
  const client = new SupervisorClient(options.witnessUrl, options.runToken, options.verifierKey);
  const spoolFile = spoolPathFor(options.stateDir, options.runId);
  const intentsFile = persistenceIntentsPathFor(options.stateDir, options.runId);
  const pollMs = options.pollMs ?? DEFAULT_DRAIN_POLL_MS;
  const openByWorker = new Map<number, OpenSlot>();
  // Begins that arrived while their worker slot was still busy with an
  // EARLIER test. A runner announces the next test's begin from the
  // worker (prompt) while the previous test's end travels through the
  // runner's main process (late), so the two lifecycles overlap by a
  // few hundred milliseconds in every genuinely serial project. The
  // witness mints one session per worker slot, so the queued begin
  // opens the moment its slot frees — nothing is dropped, nothing is
  // credited early, and a forged lifecycle still has to survive the
  // same per-test pairing.
  const pendingByWorker = new Map<number, SpoolEvent[]>();
  const endedTests = new Set<string>();
  // Every test whose BEGIN the drain saw. A runner still announces a
  // lifecycle for the tests its own filters left unexecuted (a named run
  // registers only the selected tests, so the witness refuses those
  // opens, or they queue behind a busy worker slot and are dropped when
  // it frees): their matching end has no session to close, so it is not
  // a lifecycle conflict. An end whose begin never arrived still fails
  // the run closed exactly as before.
  const begunTests = new Set<string>();
  // Sessions whose WORKER SLOT was released on the worker's own
  // lifecycle end, keyed by test id: the test is over for the worker
  // (its session accepts nothing and its proxy is dead), but the
  // runner's reporter still owes the OUTCOME that confirms the seal.
  // `outcome` is the one the supervisor already sealed, so a second,
  // different outcome for the same test is a conflict, not a re-seal.
  const awaitingOutcome = new Map<string, { sessionId: string; outcome: string | null }>();
  const conflicts: string[] = [];
  const intentFailures: string[] = [];
  const observeNotes: string[] = [];
  // Forward progress of the persistence channel, and the waiters a
  // caller parks on it. Counted AFTER the witness answers, so the count
  // is the drain's own fact and never something the runner child can
  // assert for itself.
  let answeredIntents = 0;
  const forwardWaiters: ForwardWaiter[] = [];
  let offset = 0;
  let intentsOffset = 0;
  let running = true;

  let settling: Promise<void> = Promise.resolve();

/** One parked `whenIntentsForwarded` wait and the count it waits for. */
interface ForwardWaiter {
  /** The count this caller is waiting for. */
  count: number;
  /** Resolves the caller's promise and clears its timer. */
  release: () => void;
  /** Rejects the caller's promise and unparks it. */
  fail: (error: Error) => void;
}

/**
 * Releases exactly the waiters whose count the witness has now reached,
 * leaving the rest parked. A waiter for a larger count must NOT ride
 * out on an earlier answer: the caller is waiting for the probe of its
 * OWN nth intent, and resolving early would let it mutate the target
 * before that probe ran.
 */
const releaseReachedWaiters = (): void => {
  const stillWaiting: ForwardWaiter[] = [];
  for (const waiter of forwardWaiters) {
    if (answeredIntents >= waiter.count) waiter.release();
    else stillWaiting.push(waiter);
  }
  forwardWaiters.length = 0;
  for (const waiter of stillWaiting) forwardWaiters.push(waiter);
};

  const slotKey = (workerIndex: number, testId: string): string => `${String(workerIndex)}\u0000${testId}`;

  const openSessionFor = async (event: SpoolEvent): Promise<void> => {
    const workerIndex = event.workerIndex;
    begunTests.add(event.testId);
    // The runner's own `testBegin` for a test whose WORKER-side end
    // already released the slot: the same lifecycle, arriving over the
    // slower channel. Re-opening it would be a second lifecycle for one
    // test, and queueing it would resurrect a finished test — both wrong.
    // Once the outcome is recorded the check below applies again, so a
    // genuine re-begin after a sealed outcome still conflicts.
    if (awaitingOutcome.has(event.testId)) return;
    const existing = openByWorker.get(workerIndex);
    if (existing !== undefined && existing.testId === event.testId) return; // idempotent re-begin
    if (existing !== undefined) {
      // A second begin over a busy worker slot: the previous test's
      // end simply has not travelled back yet. The queued begin opens
      // when the slot frees, so a serial project whose reporter lags
      // its worker is no longer failed closed for its own ordering.
      const queued = pendingByWorker.get(workerIndex) ?? [];
      if (!queued.some((pending) => pending.testId === event.testId)) queued.push(event);
      pendingByWorker.set(workerIndex, queued);
      return;
    }
    if (endedTests.has(slotKey(workerIndex, event.testId))) {
      conflicts.push(
        `lifecycle conflict: worker ${String(workerIndex)} re-began already-ended test ` +
          `'${event.testId}' — a second lifecycle for the same test never occurs in a genuine ` +
          'run (forged or confused lifecycle events fail closed)',
      );
      return;
    }
    const opened = await client.openSession({
      testId: event.testId,
      workerIndex,
      ...(event.file !== null ? { file: event.file } : {}),
      ...(event.titlePath.length > 0 ? { titlePath: event.titlePath } : {}),
      ...(event.project !== null ? { project: event.project } : {}),
      ...(event.claims !== undefined && event.claims.length > 0 ? { claims: event.claims } : {}),
    });
    openByWorker.set(workerIndex, { sessionId: opened.sessionId, testId: event.testId });
  };

  /**
   * Opens the earliest begin that waited for a worker slot, in arrival
   * order. A queued begin whose test already ended (a late replay) is
   * dropped rather than reopened.
   *
   * Args:
   *   workerIndex: the freed slot.
   *
   * Returns:
   *   Promise<void>: resolves once the slot holds its next test (or is
   *     empty again).
   */
  const openNextPending = async (workerIndex: number): Promise<void> => {
    const queued = pendingByWorker.get(workerIndex);
    if (queued === undefined || queued.length === 0) return;
    for (let index = 0; index < queued.length; ) {
      const next = queued[index] as SpoolEvent;
      if (openByWorker.has(workerIndex) || endedTests.has(slotKey(workerIndex, next.testId))) {
        queued.splice(index, 1);
        continue;
      }
      queued.splice(index, 1);
      await openSessionFor(next);
      return;
    }
    if (queued.length === 0) pendingByWorker.delete(workerIndex);
  };

  const sealQuietly = async (slot: OpenSlot, outcome: string | undefined): Promise<void> => {
    try {
      await client.closeSession({ sessionId: slot.sessionId, ...(outcome !== undefined ? { outcome } : {}) });
    } catch (error) {
      // Unknown/already-sealed sessions are re-delivery noise; anything
      // else surfaces in the trace grading (an unsealable session never
      // reads as passed).
      if (!(error instanceof WitnessRequestError)) {
        console.warn(`[gateforge] supervisor session close failed: ${(error as Error).message}`);
      }
    }
  };

  /**
   * Finalizes one passed test's session for the Observe channel BEFORE
   * sealing it: the witness resolves the session's own proxied traffic
   * plus independent adapter reads into witnessed records. Only passed
   * tests finalize — failed/crashed work gets no evidence. Notes are
   * diagnostics collected for the run report, never run-fatal (the
   * obligation stays blocking through verdicts).
   */
  const finalizeObserveQuietly = async (slot: OpenSlot): Promise<void> => {
    if (options.observeObligations === undefined || options.observeObligations.length === 0) return;
    try {
      const result = await client.finalizeObserve({ sessionId: slot.sessionId });
      for (const done of result.finalized) {
        console.warn(
          `[gateforge] observe finalized '${done.obligationId}' (${done.operation}, entity ` +
            `${JSON.stringify(done.entityId) ?? '?'}) for test '${slot.testId}'`,
        );
      }
      for (const note of result.notes) {
        const message = `observe finalize for test '${slot.testId}': ${note}`;
        observeNotes.push(message);
        console.warn(`[gateforge] ${message}`);
      }
    } catch (error) {
      const message =
        `observe finalize for test '${slot.testId}' failed: ` +
        `${error instanceof Error ? error.message : String(error)}`;
      observeNotes.push(message);
      console.warn(`[gateforge] ${message}`);
    }
  };

  /**
   * Releases one session's worker slot on the worker's own end (see the
   * module doc). The witness unbinds the worker and kills the session
   * proxy; the test's outcome stays owed and is sealed by the runner's
   * own end. A refused release is a conflict, not a silent pass: the
   * session then keeps its slot and the next begin stays queued.
   */
  const releaseQuietly = async (slot: OpenSlot): Promise<void> => {
    try {
      await client.releaseSession({ sessionId: slot.sessionId });
      awaitingOutcome.set(slot.testId, { sessionId: slot.sessionId, outcome: null });
    } catch (error) {
      const message =
        `supervisor session release failed for test '${slot.testId}': ` +
        `${error instanceof Error ? error.message : String(error)}`;
      conflicts.push(message);
      console.warn(`[gateforge] ${message}`);
    }
  };

  const handleEvent = async (event: SpoolEvent): Promise<void> => {
    // The observer sees EVERY drained event, including the ones the
    // lifecycle rules below ignore (a repeated worker end, an end whose
    // begin never opened): the progress stream counts runner outcomes,
    // not witness sessions, and must not lose a line to a drain detail.
    try {
      options.onTestEvent?.(event);
    } catch (error) {
      console.warn(`[gateforge] test event observer failed: ${(error as Error).message}`);
    }
    if (event.kind === 'testBegin') {
      await openSessionFor(event);
      return;
    }
    if (event.kind === 'testEnd') {
      const slot = openByWorker.get(event.workerIndex);
      if (slot !== undefined && slot.testId === event.testId) {
        openByWorker.delete(event.workerIndex);
        endedTests.add(slotKey(event.workerIndex, event.testId));
        if (event.outcome === undefined) {
          // The WORKER's own end: the test is over, but the runner's
          // reporter still owes its outcome. Release the slot (the
          // session stops accepting submissions and its proxy dies)
          // instead of sealing a verdict nobody observed, then open
          // whatever begin waited for it.
          await releaseQuietly(slot);
          await openNextPending(event.workerIndex);
          return;
        }
        // Observe finalize BEFORE seal (finalize requires an unsealed
        // session), and only for passed tests — failed/crashed work
        // gets no evidence, and its claim stays blocking.
        if (event.outcome === 'passed') {
          await finalizeObserveQuietly(slot);
        }
        await sealQuietly(slot, event.outcome);
        // The slot is free again: open whatever begin waited for it.
        await openNextPending(event.workerIndex);
        return;
      }
      // The runner's own end for a test whose WORKER SLOT was already
      // released: the seal that confirms the release, and the only
      // source of that test's outcome. A repeated end carrying the SAME
      // outcome is re-delivery; a DIFFERENT one is a confused lifecycle
      // and fails the run closed (the witness refuses it too).
      const released = awaitingOutcome.get(event.testId);
      if (released !== undefined) {
        if (event.outcome === undefined) return; // a repeated worker end
        if (released.outcome !== null && released.outcome !== event.outcome) {
          conflicts.push(
            `lifecycle conflict: test '${event.testId}' ended twice with different outcomes ` +
              `('${released.outcome}' then '${event.outcome}') — one test has one outcome`,
          );
          return;
        }
        released.outcome = event.outcome;
        if (event.outcome === 'passed') {
          await finalizeObserveQuietly({ sessionId: released.sessionId, testId: event.testId });
        }
        await sealQuietly({ sessionId: released.sessionId, testId: event.testId }, event.outcome);
        return;
      }
      // The end of a test whose begin the drain saw but never opened a
      // session for (the witness refused it as outside the registered
      // expected set, or it queued behind a busy slot and was dropped):
      // there is nothing to close and nothing to seal, so it is not a
      // conflict. An end with NO begin at all still is.
      if (begunTests.has(event.testId)) return;
      // An end with no matching open begin: genuine reporter events are
      // always begin/end paired. A lone end is forgery or confusion —
      // record it and fail the run closed downstream (never open or seal
      // anything for it).
      conflicts.push(
        `lifecycle conflict: worker ${String(event.workerIndex)} ended '${event.testId}' with no ` +
          'matching open begin — a lone end never occurs in a genuine run (forged or confused ' +
          'lifecycle events fail closed)',
      );
    }
  };

  /**
   * Resolves the typed witness cause of a refused intent into its §5.4
   * next action (the witness returns the cause code on the error
   * `detail`); unmapped causes still surface verbatim — never silently.
   */
  const nextActionFor = (cause: string | null): string | null => {
    if (cause === null) return null;
    return (cause as CauseCode) in CAUSE_NEXT_ACTIONS ? CAUSE_NEXT_ACTIONS[cause as CauseCode] : null;
  };

  /**
   * Forwards one drained persistence intent to the witness. Every
   * refusal is a TYPED failure recorded for the run report: the claim
   * stays blocking (no witnessed record exists), and the failure text
   * names the cause and next action — an intent never resolves to
   * satisfaction on probe/adapter/declaration/replay trouble.
   */
  const handleIntent = async (intent: PersistenceIntent): Promise<void> => {
    try {
      await client.verifyServerPersistence({
        resourceId: intent.entity,
        claimId: intent.claimId,
        operation: intent.operation,
        phase: intent.phase,
        intent: intent.intent,
        key: intent.key,
        sequence: intent.sequence,
        testId: intent.testId,
      });
    } catch (error) {
      const cause = error instanceof WitnessRequestError ? error.detail : null;
      const nextAction = nextActionFor(cause);
      const message =
        `server persistence intent (${intent.phase}, sequence ${String(intent.sequence)}) for ` +
        `'${intent.claimId}' failed${cause !== null ? ` [${cause}]` : ''}: ` +
        `${error instanceof Error ? error.message : String(error)}` +
        `${nextAction !== null ? ` — next: ${nextAction}` : ''}`;
      intentFailures.push(message);
      console.warn(`[gateforge] ${message}`);
    }
    // The witness has now answered this intent either way, so the
    // forward-progress count advances past refusals too.
    answeredIntents += 1;
    releaseReachedWaiters();
  };

  /**
   * Waits until the witness has answered `count` drained intents.
   *
   * Args:
   *   count: how many drained intents must have been answered.
   *   timeoutMs: bound on the wait.
   *
   * Returns:
   *   Promise<void>: resolves once the count is reached, rejects when
   *     the bound elapses first.
   */
  const whenIntentsForwarded = async (count: number, timeoutMs = 10_000): Promise<void> => {
    if (answeredIntents >= count) return;
    await new Promise<void>((resolveReady, rejectTimeout) => {
      const waiter: ForwardWaiter = {
        count,
        release: () => {
          clearTimeout(timer);
          resolveReady();
        },
        fail: (error: Error) => {
          clearTimeout(timer);
          rejectTimeout(error);
        },
      };
      const timer = setTimeout(() => {
        const index = forwardWaiters.indexOf(waiter);
        if (index >= 0) forwardWaiters.splice(index, 1);
        waiter.fail(
          new Error(
            `the supervisor drain forwarded only ${String(answeredIntents)} of ${String(count)} ` +
              'persistence intents before the wait elapsed — the witness never answered them',
          ),
        );
      }, timeoutMs);
      forwardWaiters.push(waiter);
      // An answer that landed while this waiter was being registered
      // still resolves it — the count is re-checked, never assumed.
      releaseReachedWaiters();
    });
  };

  const drainOnce = async (): Promise<void> => {
    const { events, nextOffset } = readSpoolEvents(spoolFile, offset);
    offset = nextOffset;
    for (const event of events) {
      const previous = settling;
      settling = previous
        .then(() => handleEvent(event))
        .catch((error: unknown) => {
          // A refused open (e.g. outside the registered expected set) is
          // logged once; the witness-side refusal is the enforcement —
          // the suite's submissions then fail closed on their own.
          console.warn(
            `[gateforge] supervisor drain could not process a '${event.kind}' event for ` +
              `'${event.testId}': ${(error as Error).message}`,
          );
        });
    }
    // Persistence claim intents (server-witnessed channel): forwarded in
    // file order under the same serialization as the lifecycle events,
    // so per-claim sequences are enforced in order.
    const drainedIntents = readPersistenceIntents(intentsFile, intentsOffset);
    intentsOffset = drainedIntents.nextOffset;
    for (const intent of drainedIntents.intents) {
      const previous = settling;
      settling = previous
        .then(() => handleIntent(intent))
        .catch((error: unknown) => {
          console.warn(
            `[gateforge] supervisor drain could not forward a persistence intent for ` +
              `'${intent.claimId}': ${(error as Error).message}`,
          );
        });
    }
  };

  // PRE-RUN fact: register the server-e2e declarations (the trusted
  // mapping layer's kind resolution) before any intent can be forwarded.
  // A refusal is a supervisor setup error and fails the run closed via
  // the conflict channel.
  if (options.serverE2eObligations !== undefined) {
    const previous = settling;
    settling = previous
      .then(async () => {
        await client.registerServerE2eDeclarations({
          obligations: [...options.serverE2eObligations as readonly string[]],
        });
      })
      .catch((error: unknown) => {
        const message = `supervisor drain could not register the server-e2e declarations: ${(error as Error).message}`;
        conflicts.push(message);
        console.warn(`[gateforge] ${message}`);
      });
  }

  // PRE-RUN fact: register the observe declarations (the trusted mapping
  // layer's `observed-e2e` resolution) before any session opens — the
  // witness snapshots observe resources at session open, so late
  // registration would silently miss before-state. Same refusal
  // contract as the server-e2e set.
  if (options.observeObligations !== undefined) {
    const previous = settling;
    settling = previous
      .then(async () => {
        await client.registerObserveDeclarations({
          obligations: [...options.observeObligations as readonly string[]],
        });
      })
      .catch((error: unknown) => {
        const message = `supervisor drain could not register the observe declarations: ${(error as Error).message}`;
        conflicts.push(message);
        console.warn(`[gateforge] ${message}`);
      });
  }

  const loop = (async () => {
    // The PRE-RUN registrations (`settling`) land BEFORE the first poll:
    // the witness refuses a session open whose observe declarations are
    // not bound yet, and a runner child waiting on that session would see
    // a bare "no open session" timeout instead of the real cause. A
    // registration refusal is already recorded in `conflicts`.
    await settling.catch(() => undefined);
    while (running) {
      try {
        await drainOnce();
      } catch (error) {
        // A single refused poll (a witness restart, a transient refusal)
        // must NOT end supervision for the whole run: the refusal is
        // recorded as a conflict — the run still fails closed downstream
        // — and the next poll retries.
        const message = `supervisor drain poll failed: ${(error as Error).message}`;
        if (!conflicts.includes(message)) conflicts.push(message);
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
    }
  })();

  return {
    stop: async (): Promise<{ conflicts: string[]; intentFailures: string[]; observeNotes: string[] }> => {
      running = false;
      await loop.catch(() => undefined);
      await drainOnce();
      await settling;
      // Force-close anything the runner left open (crash, lost contact):
      // sealed with NO outcome — the trace grades it not-passed. No
      // observe finalize here: unfinished work gets no evidence.
      const leftover = [...openByWorker.values()];
      openByWorker.clear();
      await Promise.all(leftover.map((slot) => sealQuietly(slot, undefined)));
      return { conflicts: [...conflicts], intentFailures: [...intentFailures], observeNotes: [...observeNotes] };
    },
    whenIntentsForwarded,
  };
}
