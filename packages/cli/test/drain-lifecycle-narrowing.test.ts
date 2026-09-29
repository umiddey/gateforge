/**
 * The drain's narrowing of one lifecycle rule, proven not to weaken an
 * ordinary run.
 *
 * A hand-picked `--test` selection makes the runner announce a
 * lifecycle for tests it never executes, so the end of a test whose
 * begin the drain saw but for which the witness REFUSED a session
 * (outside the registered expected set) is no longer a lifecycle
 * conflict. That relaxation is bounded, and these tests hold the
 * boundary with the real witness and the real seal:
 *
 * - an unplanned test that really executed still blocks the run
 *   (supervision: "outside the planned expected set");
 * - an end with no begin at all still fails closed;
 * - a genuine duplicate begin (a begin after the test already ended)
 *   still conflicts.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerExecutionEnvelope, RunnerOutcomesDocument, TestCatalog, TestCatalogEntry } from '@gate-forge/core';
import { startWitness } from '../../pack-playwright/src/witness/server.js';
import { startSupervisorSpoolDrain } from '../../pack-playwright/src/supervisor/drain.js';
import { appendSpoolEvent, spoolPathFor } from '../../pack-playwright/src/supervisor/spool.js';
import { SupervisorClient } from '../../pack-playwright/src/supervisor/client.js';
import { sealExecutionResult, type PlannedRow } from '../src/execution.js';

const FILE = 'e2e/accounts.spec.ts';
const TITLE = ['Accounts', 'creates an account'];
const KEY = 'playwright:chromium:e2e/accounts.spec.ts:Accounts>creates an account';
const RUN_ID = 'd41d8cd9-8f00-4333-8444-555555555555';
const INVOCATION_ID = '0a0a0a0a-1b1b-4c4c-8d8d-666666666666';
const VERIFIER_KEY = 'drain-narrowing-verifier-key';
const HEX = (seed: number): string => String(seed).repeat(64);

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One disposable state directory, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drain-narrowing-'));
  TEMP_DIRS.push(dir);
  return dir;
}

/** One catalog row for the single planned test. */
function catalogEntry(): TestCatalogEntry {
  return {
    logicalKey: KEY,
    runner: 'playwright',
    project: 'chromium',
    file: FILE,
    titlePath: TITLE,
    title: TITLE[1] ?? '',
    sourceLocation: { file: FILE, line: 3, col: 0 },
    parameterIdentity: null,
    sourceDigest: 'aa'.repeat(32),
    discoveryStatus: 'discovered',
    reconciliation: 'matched',
    inferredKind: 'browser-e2e',
    kindSignals: [],
    weakSignals: [],
    rulesFired: [],
    categorySignals: [],
    suppressionSignals: [],
  };
}

/** The one planned row the seal compares the executed document against. */
function plannedRow(): PlannedRow {
  return {
    planned: { logicalKey: KEY, project: 'chromium', file: FILE, titlePath: [...TITLE], frameworkId: null },
    input: { logicalKey: KEY, project: 'chromium', file: FILE, titlePath: [...TITLE], blockingAnnotations: [] },
  };
}

/** Seals the run from an executed outcomes document. */
function seal(outcomes: RunnerOutcomesDocument['outcomes']) {
  const catalog: TestCatalog = {
    schemaVersion: 1,
    entries: [catalogEntry()],
    unresolved: [],
    parseErrors: [],
    inventoryComplete: true,
    runnerSummaries: [],
  };
  const envelope: RunnerExecutionEnvelope = {
    processExit: 0,
    complete: true,
    outcomes: [],
    fixtureOutcome: 'passed',
    shards: null,
    retriesDetected: false,
    engines: { node: process.version },
    browsers: { chromium: 'chromium-1' },
  };
  const doc: RunnerOutcomesDocument = {
    schemaVersion: 1,
    runStatus: 'passed',
    runnerErrors: [],
    shard: null,
    outcomes,
  };
  return sealExecutionResult({
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    inputDigest: HEX(1),
    trustedPolicyDigest: HEX(2),
    runner: 'playwright',
    logicalKeys: [KEY],
    catalog,
    plannedRows: [plannedRow()],
    envelope,
    outcomesDoc: doc,
    startedAt: '2026-09-13T00:00:00.000Z',
    finishedAt: '2026-09-13T00:01:00.000Z',
  });
}

/**
 * Runs the real drain against the real witness with ONLY `planned-test`
 * registered, feeding it the given spool events.
 *
 * Args:
 *   events: the spool events the (simulated) runner appended.
 *
 * Returns:
 *   Promise<{ conflicts: string[] }>: what the drain refused to run with.
 */
async function drainWith(
  events: ReadonlyArray<Parameters<typeof appendSpoolEvent>[1]>,
): Promise<{ conflicts: string[] }> {
  const stateDir = tempDir();
  const witness = await startWitness({ runId: RUN_ID, token: 'suite-token', verifierKey: VERIFIER_KEY });
  const supervisor = new SupervisorClient(witness.url, 'suite-token', VERIFIER_KEY);
  await supervisor.registerExpectedSet({
    tests: [{ testId: 'planned-test', project: 'chromium', file: FILE, titlePath: TITLE }],
  });
  const spoolFile = spoolPathFor(stateDir, RUN_ID);
  const drain = startSupervisorSpoolDrain({
    stateDir,
    runId: RUN_ID,
    witnessUrl: witness.url,
    runToken: 'suite-token',
    verifierKey: VERIFIER_KEY,
    pollMs: 5,
  });
  try {
    for (const event of events) appendSpoolEvent(spoolFile, event);
    // `stop()` performs a final sweep of the spool, so every appended
    // event is processed before it answers — no guessed wait, and the
    // awaited condition is the drain's own completion.
    const stopped = await drain.stop();
    return stopped;
  } finally {
    await witness.stop();
  }
}

describe('the narrowed drain lifecycle rule never weakens a full run', () => {
  it('an unplanned test that executed still blocks the seal (outside the planned expected set)', async () => {
    // A full run: the planned test is registered, a second test is not.
    // The witness refuses the unplanned open, and the drain's narrowed
    // rule accepts its matching end — but the executed document still
    // carries the row, so supervision fails the run closed.
    const stopped = await drainWith([
      {
        kind: 'testBegin',
        testId: 'planned-test',
        workerIndex: 0,
        file: FILE,
        titlePath: TITLE,
        project: 'chromium',
      },
      {
        kind: 'testEnd',
        testId: 'planned-test',
        workerIndex: 0,
        file: FILE,
        titlePath: TITLE,
        project: 'chromium',
        outcome: 'passed',
      },
      {
        kind: 'testBegin',
        testId: 'unplanned-test',
        workerIndex: 1,
        file: FILE,
        titlePath: ['Accounts', 'smuggled'],
        project: 'chromium',
      },
      {
        kind: 'testEnd',
        testId: 'unplanned-test',
        workerIndex: 1,
        file: FILE,
        titlePath: ['Accounts', 'smuggled'],
        project: 'chromium',
        outcome: 'passed',
      },
    ]);
    // The narrowed rule: no lifecycle conflict for the refused test.
    expect(stopped.conflicts).toEqual([]);
    // The enforcement never moved: the run itself is refused.
    const sealed = seal([
      { testId: 'planned-test', file: FILE, titlePath: TITLE, project: 'chromium', status: 'passed', attempt: 1, expectedFailure: false },
      { testId: 'unplanned-test', file: FILE, titlePath: ['Accounts', 'smuggled'], project: 'chromium', status: 'passed', attempt: 1, expectedFailure: false },
    ]);
    expect(sealed.result.complete).toBe(false);
    expect(
      sealed.result.causes.some((cause) => /outside the planned expected set/.test(cause.detail)),
      JSON.stringify(sealed.result.causes),
    ).toBe(true);
  });

  it('an end with no begin at all still fails closed', async () => {
    const stopped = await drainWith([
      {
        kind: 'testEnd',
        testId: 'planned-test',
        workerIndex: 0,
        file: FILE,
        titlePath: TITLE,
        project: 'chromium',
        outcome: 'passed',
      },
    ]);
    expect(stopped.conflicts.join('\n')).toMatch(/lone end|no matching open begin/);
  });

  it('a genuine duplicate begin (after the test ended) still conflicts', async () => {
    const stopped = await drainWith([
      {
        kind: 'testBegin',
        testId: 'planned-test',
        workerIndex: 0,
        file: FILE,
        titlePath: TITLE,
        project: 'chromium',
      },
      {
        kind: 'testEnd',
        testId: 'planned-test',
        workerIndex: 0,
        file: FILE,
        titlePath: TITLE,
        project: 'chromium',
        outcome: 'passed',
      },
      {
        kind: 'testBegin',
        testId: 'planned-test',
        workerIndex: 0,
        file: FILE,
        titlePath: TITLE,
        project: 'chromium',
      },
    ]);
    expect(stopped.conflicts.join('\n')).toMatch(/re-began already-ended test/);
  });
});
