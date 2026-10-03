/**
 * The progress stream as the SUPERVISED run drives it: the real drain,
 * the real witness, the real NUL-safe spool protocol, and a real
 * (simulated) runner writing `testBegin`/`testEnd` lines.
 *
 * What this pins is the wiring, not the formatting (the stream's own
 * rules have their own tests):
 * - a `CI=true` run prints start/per-test/finish lines with the
 *   REGISTERED expected-set size as the denominator — the count a
 *   human watching the job needs, not the count the runner felt like
 *   reporting;
 * - a failure's assertion text reaches the stream and the
 *   Gateforge-owned failures artifact, while a credential planted in
 *   that text reaches NEITHER (a planted value is built at runtime
 *   from fragments; typing one into a test file is itself a leak);
 * - the stream stays silent with no writer, so a local run's bytes are
 *   unchanged.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startWitness } from '../../pack-playwright/src/witness/server.js';
import { startSupervisorSpoolDrain } from '../../pack-playwright/src/supervisor/drain.js';
import { appendSpoolEvent, spoolPathFor, type SpoolEvent } from '../../pack-playwright/src/supervisor/spool.js';
import { SupervisorClient } from '../../pack-playwright/src/supervisor/client.js';
import { ProgressStream, resolveProgressTarget, type ProgressOutcome } from '../src/progress.js';
import { writeTestFailures } from '../src/state.js';

const RUN_ID = 'd41d8cd9-8f00-4333-8444-555555555555';
const VERIFIER_KEY = 'progress-drain-verifier-key';
const FILE = 'e2e/accounts.spec.ts';
const EXPECTED = 3;

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One disposable state directory, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'progress-drain-'));
  TEMP_DIRS.push(dir);
  return dir;
}

/**
 * Runs the real drain over the given spool events with a progress
 * stream attached, exactly as the supervised command wires it.
 *
 * Args:
 *   events: the lifecycle events a runner appended.
 *   env: the environment the stream target is resolved against.
 *
 * Returns:
 *   Promise<{ lines: string[]; stream: ProgressStream }>: every line the
 *   stream wrote and the stream itself (for its failure records).
 */
async function drainWithStream(
  events: readonly SpoolEvent[],
  env: NodeJS.ProcessEnv,
): Promise<{ lines: string[]; stream: ProgressStream }> {
  const stateDir = tempDir();
  const witness = await startWitness({ runId: RUN_ID, token: 'suite-token', verifierKey: VERIFIER_KEY });
  const supervisor = new SupervisorClient(witness.url, 'suite-token', VERIFIER_KEY);
  await supervisor.registerExpectedSet({
    tests: [
      { testId: 'e2e/accounts.spec.ts#Accounts>creates an account', project: 'chromium', file: FILE, titlePath: ['Accounts', 'creates an account'] },
      { testId: 'e2e/accounts.spec.ts#Accounts>lists accounts', project: 'chromium', file: FILE, titlePath: ['Accounts', 'lists accounts'] },
      { testId: 'e2e/accounts.spec.ts#Accounts>deletes an account', project: 'chromium', file: FILE, titlePath: ['Accounts', 'deletes an account'] },
    ],
  });
  const lines: string[] = [];
  const stream = new ProgressStream({
    writer: resolveProgressTarget(undefined, undefined, env),
    runner: 'playwright',
    scope: 'full',
    expected: EXPECTED,
    writeLine: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(line),
  });
  stream.start();
  const spoolFile = spoolPathFor(stateDir, RUN_ID);
  const drain = startSupervisorSpoolDrain({
    stateDir,
    runId: RUN_ID,
    witnessUrl: witness.url,
    runToken: 'suite-token',
    verifierKey: VERIFIER_KEY,
    onTestEvent: (event) => {
      const title = event.titlePath.join(' > ');
      if (event.kind === 'testBegin') {
        stream.beginTest(title);
        return;
      }
      if (event.outcome === undefined) return;
      const outcome: ProgressOutcome =
        event.outcome === 'passed' ? 'passed' : event.outcome === 'skipped' ? 'skipped' : 'failed';
      stream.endTest({
        logicalKey: `${event.file ?? ''}#${event.titlePath.join('>')}`,
        title,
        outcome,
        ...(event.errorMessage === undefined ? {} : { message: event.errorMessage }),
        ...(event.stackFrames === undefined ? {} : { stackFrames: event.stackFrames }),
      });
    },
  });
  for (const event of events) appendSpoolEvent(spoolFile, event);
  // `stop()` performs a final sweep of the spool, so every appended
  // event is processed by the time it resolves: the awaited condition,
  // not a guessed wait.
  await drain.stop();
  stream.finish();
  return { lines, stream };
}

/** One `testBegin` for a registered test. */
function begin(titlePath: string[]): SpoolEvent {
  return {
    kind: 'testBegin',
    testId: `${FILE}#${titlePath.join('>')}`,
    workerIndex: 0,
    file: FILE,
    titlePath,
    project: 'chromium',
  };
}

/** One `testEnd` for a registered test. */
function end(titlePath: string[], outcome: string, extra: Partial<SpoolEvent> = {}): SpoolEvent {
  return {
    kind: 'testEnd',
    testId: `${FILE}#${titlePath.join('>')}`,
    workerIndex: 0,
    file: FILE,
    titlePath,
    project: 'chromium',
    outcome,
    attempt: 1,
    ...extra,
  };
}

describe('the progress stream of a supervised run', () => {
  it('prints start, per-test and finish lines with the registered count', async () => {
    const { lines } = await drainWithStream(
      [
        begin(['Accounts', 'creates an account']),
        end(['Accounts', 'creates an account'], 'passed'),
        begin(['Accounts', 'lists accounts']),
        end(['Accounts', 'lists accounts'], 'failed', {
          errorMessage: 'Expected: 200\nReceived: 404',
          stackFrames: ['e2e/accounts.spec.ts:41', 'e2e/accounts.spec.ts:41', 'e2e/helper.ts:9'],
        }),
        begin(['Accounts', 'deletes an account']),
        end(['Accounts', 'deletes an account'], 'skipped'),
      ],
      { CI: 'true' },
    );
    expect(lines).toEqual([
      `gateforge: run started — ${String(EXPECTED)} tests expected (runner playwright, scope full)`,
      'gateforge: ✓ 1/3 Accounts > creates an account',
      'gateforge: ✘ 2/3 Accounts > lists accounts — Expected: 200',
      'gateforge: – 3/3 Accounts > deletes an account (skipped)',
      'gateforge: run finished — 1 passed, 1 failed, 1 skipped in 0m00s; grading…',
    ]);
  });

  it('keeps a planted credential out of the stream and the failures artifact', async () => {
    // Built at runtime from fragments: a credential-shaped string typed
    // into a test file is itself a leak.
    const planted = ['sk', '-', 'live-', '9f3a2b7c4d5e6f70a1b2c3d4e5f60718'].join('');
    const { lines, stream } = await drainWithStream(
      [
        begin(['Accounts', 'lists accounts']),
        end(['Accounts', 'lists accounts'], 'failed', {
          errorMessage: `Expected 401, received 200 for POST /login with {"password":"${planted}"}`,
          stackFrames: ['e2e/accounts.spec.ts:41'],
        }),
      ],
      { CI: 'true' },
    );
    expect(lines.join('\n').includes(planted)).toBe(false);
    expect(lines[1]).toContain('(message withheld: looks like a secret)');
    const stateDir = tempDir();
    writeTestFailures(stateDir, RUN_ID, stream.failures);
    const artifact = readFileSync(join(stateDir, 'failures.json'), 'utf8');
    expect(artifact.includes(planted)).toBe(false);
    // The artifact still says WHICH test failed and where: it is a
    // diagnosis, not a redaction.
    expect(JSON.parse(artifact)).toMatchObject({
      schemaVersion: 1,
      runId: RUN_ID,
      failures: [
        {
          logicalKey: `${FILE}#Accounts>lists accounts`,
          stackFrames: ['e2e/accounts.spec.ts:41'],
        },
      ],
    });
  });

  it('prints nothing at all when the stream is off', async () => {
    const { lines } = await drainWithStream(
      [begin(['Accounts', 'creates an account']), end(['Accounts', 'creates an account'], 'passed')],
      {},
    );
    expect(lines).toEqual([]);
  });
});
