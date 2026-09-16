/**
 * The runner-side lifecycle SPOOL (enforcement-review fix 3): the
 * untrusted runner child cannot call the witness's supervisor surface,
 * so the gateforge reporter instead writes test lifecycle events
 * (testBegin / testEnd with the observed outcome) as NUL-safe JSON lines
 * into the run-state spool. The TRUSTED CLI drains this spool while the
 * suite runs and performs the witness's supervisor calls (session
 * open/close) with credentials (run token + verifier key) that exist
 * ONLY in the CLI process. The spool file itself carries no secrets —
 * test identities and outcomes only.
 *
 * Protocol: one JSON object per line, canonical JSON (control characters
 * — NUL included — are escaped, so the format is NUL-safe), terminated
 * by '\n'. Consumers only treat a line as complete once its '\n' has
 * been written, which makes partial writes impossible to misparse.
 */
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalOf } from '../json.js';
import { SPOOL_DIR_NAME, SPOOL_EVENTS_FILE, SPOOL_INTENTS_FILE } from '../constants.js';
/**
 * Resolves the spool events file for one run.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   runId: the run identity both sides agree on (env-carried).
 *
 * Returns:
 *   string: absolute `<stateDir>/spool/<runId>/events.jsonl` path.
 */
export function spoolPathFor(stateDir, runId) {
    return join(stateDir, SPOOL_DIR_NAME, runId, SPOOL_EVENTS_FILE);
}
/**
 * Appends one lifecycle event to the run's spool (runner-side; the
 * reporter calls this). The event is sanitized: string fields are
 * coerced/validated, unknown statuses ride as strings, and canonical
 * JSON escapes every control character (NUL included) — the line is
 * NUL-safe by construction. A failed append never crashes the run: the
 * CLI drain then simply never opens that session and the witness
 * rejects the suite's submissions fail-closed.
 *
 * Args:
 *   spoolFile: absolute spool events file (see {@link spoolPathFor}).
 *   event: the lifecycle event to append.
 */
export function appendSpoolEvent(spoolFile, event) {
    try {
        const clean = {
            kind: event.kind,
            testId: String(event.testId),
            workerIndex: Number.isInteger(event.workerIndex) && event.workerIndex >= 0 ? event.workerIndex : 0,
            file: typeof event.file === 'string' ? event.file : null,
            titlePath: Array.isArray(event.titlePath) ? event.titlePath.map((part) => String(part)) : [],
            project: typeof event.project === 'string' ? event.project : null,
            ...(event.kind === 'testEnd'
                ? {
                    // Omitted (never null) when the runner reported no string
                    // outcome: `undefined` reads as "outcome unknown" end to end,
                    // and the drain seals the session WITHOUT an outcome — which
                    // the trace grades not-passed.
                    ...(typeof event.outcome === 'string' ? { outcome: event.outcome } : {}),
                    attempt: Number.isInteger(event.attempt) && event.attempt >= 1 ? event.attempt : 1,
                }
                : {}),
            ...(Array.isArray(event.claims) && event.claims.length > 0
                ? { claims: event.claims.map((claim) => String(claim)) }
                : {}),
        };
        mkdirSync(join(spoolFile, '..'), { recursive: true });
        const line = `${canonicalOf(clean)}\n`;
        const fd = openSync(spoolFile, 'a');
        try {
            writeSync(fd, line, undefined, 'utf8');
        }
        finally {
            closeSync(fd);
        }
    }
    catch (error) {
        console.warn(`[gateforge] cannot append to the lifecycle spool: ${error.message}`);
    }
}
/**
 * Reads every COMPLETE spool line past the given byte offset (CLI-side
 * drain). A trailing fragment without its terminating newline is left
 * for the next poll — partial writes are never parsed.
 *
 * Args:
 *   spoolFile: absolute spool events file.
 *   offset: byte offset to read from (0 = from the start).
 *
 * Returns:
 *   {events, nextOffset}: parsed events in file order and the offset to
 *   resume from (equal to `offset` when nothing complete was added).
 */
export function readSpoolEvents(spoolFile, offset) {
    let size;
    try {
        size = statSync(spoolFile).size;
    }
    catch {
        return { events: [], nextOffset: offset };
    }
    if (size <= offset)
        return { events: [], nextOffset: offset };
    let raw;
    try {
        raw = readFileSync(spoolFile, 'utf8');
    }
    catch {
        return { events: [], nextOffset: offset };
    }
    // Byte offsets are only tracked for complete lines; converting the
    // whole file each poll is bounded by the spool's lifetime size.
    const events = [];
    let consumed = 0;
    const lines = raw.split('\n');
    for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + '\n'
        const start = consumed;
        consumed += lineBytes;
        if (start < offset)
            continue;
        if (line.trim().length === 0)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue; // never crash the drain on a corrupt line
        }
        if (typeof parsed !== 'object' || parsed === null)
            continue;
        const row = parsed;
        if (typeof row['kind'] !== 'string' || typeof row['testId'] !== 'string')
            continue;
        events.push(parsed);
    }
    const trailing = lines[lines.length - 1] ?? '';
    const completeBytes = raw.endsWith('\n') ? size : size - Buffer.byteLength(trailing, 'utf8');
    return { events, nextOffset: Math.max(offset, completeBytes) };
}
/** Resolves the intents spool file for one run (`<stateDir>/spool/<runId>/persistence-intents.jsonl`). */
export function persistenceIntentsPathFor(stateDir, runId) {
    return join(stateDir, SPOOL_DIR_NAME, runId, SPOOL_INTENTS_FILE);
}
/**
 * Appends one persistence intent to the run's intents spool (test-side
 * helper; the CONTRACT is the JSONL line, this writer only keeps it
 * canonical and NUL-safe). A failed append never crashes the test: the
 * drain then simply never forwards the intent and the claim grades
 * fail-closed without its witnessed record.
 *
 * Args:
 *   intentsFile: absolute intents spool file (see {@link persistenceIntentsPathFor}).
 *   intent: the claim intent to append.
 */
export function appendPersistenceIntent(intentsFile, intent) {
    try {
        const clean = {
            entity: String(intent.entity),
            operation: intent.operation,
            phase: intent.phase,
            intent: intent.intent,
            key: intent.key,
            claimId: String(intent.claimId),
            testId: String(intent.testId),
            sequence: Number.isInteger(intent.sequence) && intent.sequence >= 1 ? intent.sequence : 1,
        };
        mkdirSync(join(intentsFile, '..'), { recursive: true });
        const line = `${canonicalOf(clean)}\n`;
        const fd = openSync(intentsFile, 'a');
        try {
            writeSync(fd, line, undefined, 'utf8');
        }
        finally {
            closeSync(fd);
        }
    }
    catch (error) {
        console.warn(`[gateforge] cannot append to the persistence-intents spool: ${error.message}`);
    }
}
/** Minimal structural validation for one drained intent line. */
function isPersistenceIntent(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const row = value;
    return (typeof row['entity'] === 'string' &&
        (row['operation'] === 'create' ||
            row['operation'] === 'read' ||
            row['operation'] === 'update' ||
            row['operation'] === 'delete') &&
        (row['phase'] === 'pre' || row['phase'] === 'post') &&
        (row['intent'] === 'expect-present' || row['intent'] === 'expect-absent') &&
        (typeof row['key'] === 'string' ||
            typeof row['key'] === 'number' ||
            typeof row['key'] === 'boolean' ||
            (typeof row['key'] === 'object' && row['key'] !== null && !Array.isArray(row['key']))) &&
        typeof row['claimId'] === 'string' &&
        typeof row['testId'] === 'string' &&
        typeof row['sequence'] === 'number' &&
        Number.isInteger(row['sequence']));
}
/**
 * Reads every COMPLETE intent line past the given byte offset (CLI-side
 * drain). Trailing fragments without their newline are left for the next
 * poll; structurally invalid lines are skipped (the claim simply never
 * resolves — fail closed, never crash the drain).
 *
 * Args:
 *   intentsFile: absolute intents spool file.
 *   offset: byte offset to read from (0 = from the start).
 *
 * Returns:
 *   {intents, nextOffset}: parsed intents in file order and the offset to
 *   resume from.
 */
export function readPersistenceIntents(intentsFile, offset) {
    let size;
    try {
        size = statSync(intentsFile).size;
    }
    catch {
        return { intents: [], nextOffset: offset };
    }
    if (size <= offset)
        return { intents: [], nextOffset: offset };
    let raw;
    try {
        raw = readFileSync(intentsFile, 'utf8');
    }
    catch {
        return { intents: [], nextOffset: offset };
    }
    const intents = [];
    let consumed = 0;
    const lines = raw.split('\n');
    for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + '\n'
        const start = consumed;
        consumed += lineBytes;
        if (start < offset)
            continue;
        if (line.trim().length === 0)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue; // never crash the drain on a corrupt line
        }
        if (isPersistenceIntent(parsed))
            intents.push(parsed);
    }
    const trailing = lines[lines.length - 1] ?? '';
    const completeBytes = raw.endsWith('\n') ? size : size - Buffer.byteLength(trailing, 'utf8');
    return { intents, nextOffset: Math.max(offset, completeBytes) };
}
//# sourceMappingURL=spool.js.map