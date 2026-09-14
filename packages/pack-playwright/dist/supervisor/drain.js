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
 */
import { WitnessRequestError } from '../fixture/witness-client.js';
import { SupervisorClient } from './client.js';
import { readSpoolEvents, spoolPathFor } from './spool.js';
/** Default cadence between spool polls (the fixture's resolve waits 5s). */
export const DEFAULT_DRAIN_POLL_MS = 50;
/**
 * Starts the spool drain loop for one supervised run.
 *
 * Args:
 *   options: stateDir + runId locate the spool; witnessUrl/runToken/
 *     verifierKey authenticate the supervisor channel; pollMs tunes the
 *     poll cadence (tests only).
 *
 * Returns:
 *   SpoolDrainHandle: awaitable stop (final drain + force-close).
 */
export function startSupervisorSpoolDrain(options) {
    const client = new SupervisorClient(options.witnessUrl, options.runToken, options.verifierKey);
    const spoolFile = spoolPathFor(options.stateDir, options.runId);
    const pollMs = options.pollMs ?? DEFAULT_DRAIN_POLL_MS;
    const openByWorker = new Map();
    const endedTests = new Set();
    const conflicts = [];
    let offset = 0;
    let running = true;
    let settling = Promise.resolve();
    const slotKey = (workerIndex, testId) => `${String(workerIndex)}\u0000${testId}`;
    const openSessionFor = async (event) => {
        const workerIndex = event.workerIndex;
        const existing = openByWorker.get(workerIndex);
        if (existing !== undefined && existing.testId === event.testId)
            return; // idempotent re-begin
        if (existing !== undefined) {
            // A second begin over an open worker slot: genuine serial reporter
            // events never do this (one test per worker at a time). The FIRST
            // session stands (a forgery must not displace it); the collision is
            // recorded and fails the run closed downstream.
            conflicts.push(`lifecycle conflict: worker ${String(workerIndex)} began '${event.testId}' while ` +
                `'${existing.testId}' was still open — a duplicate begin never occurs in a genuine ` +
                'serial run (forged or confused lifecycle events fail closed)');
            return;
        }
        if (endedTests.has(slotKey(workerIndex, event.testId))) {
            conflicts.push(`lifecycle conflict: worker ${String(workerIndex)} re-began already-ended test ` +
                `'${event.testId}' — a second lifecycle for the same test never occurs in a genuine ` +
                'run (forged or confused lifecycle events fail closed)');
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
    const sealQuietly = async (slot, outcome) => {
        try {
            await client.closeSession({ sessionId: slot.sessionId, ...(outcome !== undefined ? { outcome } : {}) });
        }
        catch (error) {
            // Unknown/already-sealed sessions are re-delivery noise; anything
            // else surfaces in the trace grading (an unsealable session never
            // reads as passed).
            if (!(error instanceof WitnessRequestError)) {
                console.warn(`[gateforge] supervisor session close failed: ${error.message}`);
            }
        }
    };
    const handleEvent = async (event) => {
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
            conflicts.push(`lifecycle conflict: worker ${String(event.workerIndex)} ended '${event.testId}' with no ` +
                'matching open begin — a lone end never occurs in a genuine run (forged or confused ' +
                'lifecycle events fail closed)');
        }
    };
    const drainOnce = async () => {
        const { events, nextOffset } = readSpoolEvents(spoolFile, offset);
        offset = nextOffset;
        for (const event of events) {
            const previous = settling;
            settling = previous
                .then(() => handleEvent(event))
                .catch((error) => {
                // A refused open (e.g. outside the registered expected set) is
                // logged once; the witness-side refusal is the enforcement —
                // the suite's submissions then fail closed on their own.
                console.warn(`[gateforge] supervisor drain could not process a '${event.kind}' event for ` +
                    `'${event.testId}': ${error.message}`);
            });
        }
    };
    const loop = (async () => {
        while (running) {
            await drainOnce();
            await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
        }
    })();
    return {
        stop: async () => {
            running = false;
            await loop.catch(() => undefined);
            await drainOnce();
            await settling;
            // Force-close anything the runner left open (crash, lost contact):
            // sealed with NO outcome — the trace grades it not-passed.
            const leftover = [...openByWorker.values()];
            openByWorker.clear();
            await Promise.all(leftover.map((slot) => sealQuietly(slot, undefined)));
            return { conflicts: [...conflicts] };
        },
    };
}
//# sourceMappingURL=drain.js.map