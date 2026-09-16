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
 */
import { CAUSE_NEXT_ACTIONS, type CauseCode } from '@gateforge/core';
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
   * intent, the witness cause, and the next action). Genuine serial
   * reporter events never conflict — any conflict is worker-side forgery
   * or runner confusion and must fail the run closed downstream.
   */
  stop: () => Promise<{ conflicts: string[]; intentFailures: string[] }>;
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
}): SpoolDrainHandle {
  const client = new SupervisorClient(options.witnessUrl, options.runToken, options.verifierKey);
  const spoolFile = spoolPathFor(options.stateDir, options.runId);
  const intentsFile = persistenceIntentsPathFor(options.stateDir, options.runId);
  const pollMs = options.pollMs ?? DEFAULT_DRAIN_POLL_MS;
  const openByWorker = new Map<number, OpenSlot>();
  const endedTests = new Set<string>();
  const conflicts: string[] = [];
  const intentFailures: string[] = [];
  let offset = 0;
  let intentsOffset = 0;
  let running = true;
  let settling: Promise<void> = Promise.resolve();

  const slotKey = (workerIndex: number, testId: string): string => `${String(workerIndex)}\u0000${testId}`;

  const openSessionFor = async (event: SpoolEvent): Promise<void> => {
    const workerIndex = event.workerIndex;
    const existing = openByWorker.get(workerIndex);
    if (existing !== undefined && existing.testId === event.testId) return; // idempotent re-begin
    if (existing !== undefined) {
      // A second begin over an open worker slot: genuine serial reporter
      // events never do this (one test per worker at a time). The FIRST
      // session stands (a forgery must not displace it); the collision is
      // recorded and fails the run closed downstream.
      conflicts.push(
        `lifecycle conflict: worker ${String(workerIndex)} began '${event.testId}' while ` +
          `'${existing.testId}' was still open — a duplicate begin never occurs in a genuine ` +
          'serial run (forged or confused lifecycle events fail closed)',
      );
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

  const handleEvent = async (event: SpoolEvent): Promise<void> => {
    if (event.kind === 'testBegin') {
      await openSessionFor(event);
      return;
    }
    if (event.kind === 'testEnd') {
      const slot = openByWorker.get(event.workerIndex);
      if (slot !== undefined && slot.testId === event.testId) {
        openByWorker.delete(event.workerIndex);
        endedTests.add(slotKey(event.workerIndex, event.testId));
        await sealQuietly(slot, event.outcome);
        return;
      }
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

  const loop = (async () => {
    while (running) {
      await drainOnce();
      await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
    }
  })();

  return {
    stop: async (): Promise<{ conflicts: string[]; intentFailures: string[] }> => {
      running = false;
      await loop.catch(() => undefined);
      await drainOnce();
      await settling;
      // Force-close anything the runner left open (crash, lost contact):
      // sealed with NO outcome — the trace grades it not-passed.
      const leftover = [...openByWorker.values()];
      openByWorker.clear();
      await Promise.all(leftover.map((slot) => sealQuietly(slot, undefined)));
      return { conflicts: [...conflicts], intentFailures: [...intentFailures] };
    },
  };
}
