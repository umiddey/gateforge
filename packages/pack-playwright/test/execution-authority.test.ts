/**
 * Execution-authority regression tests (playwright-evidence class,
 * execution-authority fix): the confirmed bypasses from the independent
 * review, replayed against the REAL pinned Playwright through the REAL
 * supervised adapter + witness + drain, must FAIL — and a genuine run
 * must PASS.
 *
 * Authority model under test: the supervisor synthesizes a trusted
 * Playwright config and never loads the consumer's. A hostile consumer
 * config (the review's fabricated-lifecycle attack: write spool events
 * + a passing outcomes document, exit 0 before any spec executes) never
 * executes, so its fabrications never exist; the actual specs are
 * FORCED to run and their genuine reporter-observed outcomes decide.
 * Run-state paths never cross to the runner child, so worker code
 * cannot address the spool or outcomes files either.
 *
 * Cases (each a real `playwright test` child):
 * - fabricated lifecycle + outcomes via hostile config → the config is
 *   ignored, the throwing spec executes (marker proves it), the run
 *   FAILS (envelope + supervision complete:false).
 * - the same attack with an empty action interval → fails the same way
 *   (the interval calls never happen; there is no session to resolve).
 * - the same attack with unrelated witness activity → fails the same way.
 * - genuine passing spec → envelope + supervision complete:true
 *   (positive control: the boundary admits real execution).
 * - drain lifecycle conflicts (worker-side forgery simulation: a lone
 *   end, a re-begin over an open slot) are reported and fail closed.
 */
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { superviseExecution } from '@gate-forge/core';
import { startWitness } from '../src/witness/server.js';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import { appendSpoolEvent, spoolPathFor } from '../src/supervisor/spool.js';
import { SupervisorClient } from '../src/supervisor/client.js';
import {
  executeSupervisedPlaywright,
  readRunnerOutcomes,
} from '../src/discovery/supervised-run.js';
import { buildPack } from './helpers.js';
import { spawnSync } from 'node:child_process';

const DIRECTORIES: string[] = [];

beforeAll(() => {
  // The trusted synthesis forces the BUILT engine reporter and supervision
  // runs against the BUILT core (workspace resolution) — rebuild both so
  // the children load the current implementation, not a stale dist.
  const core = spawnSync('npx', ['tsc', '-p', 'packages/core/tsconfig.build.json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  });
  expect(core.status, `core build failed:\n${core.stderr}`).toBe(0);
  const build = buildPack();
  expect(build.status, `pack build failed:\n${build.stderr}`).toBe(0);
});

afterEach(() => {
  for (const dir of DIRECTORIES.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Repo root (for the node_modules link specs resolve the runner from). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gateforge-execauth-${label}-`));
  DIRECTORIES.push(dir);
  // Specs import 'playwright/test' — link the monorepo modules like the
  // other e2e harnesses do.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

const ROW = {
  testId: 'expected-test',
  file: 'a.spec.js',
  titlePath: ['must execute'],
  project: null as string | null,
};

/** A hostile ESM config: full review attack (spool + resolve + interval + outcomes), exits before specs run. */
function hostileConfig(
  cwd: string,
  stateDir: string,
  runId: string,
  witnessUrl: string,
  token: string,
  mode: 'plain' | 'empty-interval' | 'unrelated-activity',
): string {
  const spool = spoolPathFor(stateDir, runId);
  const outcomesPath = join(stateDir, 'runner-outcomes.json');
  const configMarker = join(cwd, 'config-executed');
  const row = { ...ROW, status: 'passed', attempt: 1, expectedFailure: false };
  const begin = { kind: 'testBegin', testId: ROW.testId, workerIndex: 0, file: ROW.file, titlePath: ROW.titlePath, project: null };
  const end = { kind: 'testEnd', testId: ROW.testId, workerIndex: 0, file: ROW.file, titlePath: ROW.titlePath, project: null, outcome: 'passed', attempt: 1 };
  const sessionOps =
    mode === 'plain'
      ? ''
      : [
          `  const post = async (p, b) => {`,
          `    const r = await fetch(${JSON.stringify(witnessUrl)} + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateforge-run': ${JSON.stringify(token)} }, body: JSON.stringify(b) });`,
          `    const j = await r.json();`,
          `    if (!r.ok) throw new Error(p + ': ' + r.status + ' ' + JSON.stringify(j));`,
          `    return j;`,
          `  };`,
          `  let session = null;`,
          `  for (let i = 0; i < 100 && !session; i++) {`,
          `    const r = await fetch(${JSON.stringify(witnessUrl)} + '/sessions/resolve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateforge-run': ${JSON.stringify(token)} }, body: JSON.stringify({ testId: ${JSON.stringify(ROW.testId)}, workerIndex: 0 }) });`,
          `    if (r.ok) session = await r.json();`,
          `    else await new Promise((r2) => setTimeout(r2, 20));`,
          `  }`,
          `  if (!session) throw new Error('no session to abuse');`,
          `  const interval = await post('/sessions/intervals/open', { sessionId: session.sessionId, sessionToken: session.sessionToken, operation: 'create' });`,
          ...(mode === 'unrelated-activity'
            ? [
                `  await post('/records', { sessionId: session.sessionId, sessionToken: session.sessionToken, testId: ${JSON.stringify(ROW.testId)}, claimId: 'tenant.accounts:persistence:create', kind: 'ui.action', payload: { operation: 'create', entityId: 'acc-1', fields: {} } });`,
                `  await post('/witness/pre-observation', { sessionId: session.sessionId, sessionToken: session.sessionToken, testId: ${JSON.stringify(ROW.testId)}, claimId: 'tenant.accounts:persistence:create', resourceId: 'tenant.accounts' }).catch(() => null);`,
              ]
            : []),
          `  await post('/sessions/intervals/close', { sessionId: session.sessionId, sessionToken: session.sessionToken, intervalId: interval.intervalId });`,
        ].join('\n');
  writeFileSync(
    join(cwd, 'playwright.config.mjs'),
    [
      `import fs from 'node:fs';`,
      `import path from 'node:path';`,
      `fs.writeFileSync(${JSON.stringify(configMarker)}, 'yes');`,
      `fs.mkdirSync(path.dirname(${JSON.stringify(spool)}), { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(spool)}, ${JSON.stringify(`${JSON.stringify(begin)}\n`)});`,
      `await (async () => {`,
      sessionOps,
      `})();`,
      `fs.appendFileSync(${JSON.stringify(spool)}, ${JSON.stringify(`${JSON.stringify(end)}\n`)});`,
      `fs.writeFileSync(${JSON.stringify(outcomesPath)}, ${JSON.stringify(JSON.stringify({ schemaVersion: 1, runStatus: 'passed', runnerErrors: [], outcomes: [row], shard: null }))});`,
      `process.exit(0);`,
      '',
    ].join('\n'),
  );
  return configMarker;
}

/** The spec the attack tries to avoid: proves it ran, then fails. */
function throwingSpec(cwd: string): string {
  const marker = join(cwd, 'executed');
  writeFileSync(
    join(cwd, 'a.spec.js'),
    [
      `import fs from 'node:fs';`,
      `import { test } from 'playwright/test';`,
      `test(${JSON.stringify(ROW.titlePath[0])}, async () => {`,
      `  fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
      `  throw new Error('the genuine spec executed and failed');`,
      `});`,
      '',
    ].join('\n'),
  );
  return marker;
}

/** Narrows runner status strings the way the CLI's executedOutcomesOf does. */
function toExecuted(
  rows: readonly { testId: string; file: string; titlePath: string[]; project: string | null; status: string; attempt: number; expectedFailure: boolean }[],
  logicalKey: string,
): Array<{ logicalKey: string; project: string | null; file: string; titlePath: string[]; status: 'passed' | 'failed' | 'skipped' | 'fixme' | 'not-run'; attempt: number; expectedFailure: boolean }> {
  return rows.map((row) => ({
    logicalKey,
    project: row.project,
    file: row.file,
    titlePath: row.titlePath,
    status: row.status === 'passed' || row.status === 'failed' || row.status === 'skipped' || row.status === 'fixme' || row.status === 'not-run' ? row.status : 'failed',
    attempt: row.attempt,
    expectedFailure: row.expectedFailure,
  }));
}

async function runAttack(mode: 'plain' | 'empty-interval' | 'unrelated-activity'): Promise<{
  configMarkerExists: boolean;
  markerExists: boolean;
  adapterComplete: boolean;
  supervisionComplete: boolean;
  traceSessions: number;
}> {
  const cwd = tempDir('attack');
  const stateDir = tempDir('attack-state');
  const runId = 'attack-run';
  const token = 'suite-token';
  const verifierKey = 'attack-verifier-key';
  const witness = await startWitness({ runId, token, verifierKey, host: '127.0.0.1' });
  // Worst case baked in: the hostile config KNOWS the witness URL, the
  // run token, and the exact spool/outcomes paths (as if it escaped the
  // env hiding). It still must never execute — trusted synthesis never
  // loads the consumer config.
  const configMarker = hostileConfig(cwd, stateDir, runId, witness.url, token, mode);
  const marker = throwingSpec(cwd);
  const supervisor = new SupervisorClient(witness.url, token, verifierKey);
  await supervisor.registerExpectedSet({
    tests: [{ testId: ROW.testId, project: ROW.project, file: ROW.file, titlePath: ROW.titlePath }],
  });
  const drain = startSupervisorSpoolDrain({ stateDir, runId, witnessUrl: witness.url, runToken: token, verifierKey });
  try {
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId, vars: {} },
      { cwd, timeoutMs: 60_000 },
    );
    await drain.stop();
    const trace = await supervisor.executionTrace();
    const doc = readRunnerOutcomes(join(stateDir, 'runner-outcomes.json'));
    const result = superviseExecution(
      [{ logicalKey: 'k', file: ROW.file, titlePath: ROW.titlePath, project: null, blockingAnnotations: [] }],
      {
        ...envelope,
        fixtureOutcome: envelope.fixtureOutcome ?? 'unknown',
        shards: envelope.shards ?? null,
        retriesDetected: envelope.retriesDetected === true,
        outcomes: toExecuted(doc?.outcomes ?? [], 'k'),
        sessionTrace: trace?.tests ?? null,
      },
    );
    return {
      configMarkerExists: existsSync(configMarker),
      markerExists: existsSync(marker),
      adapterComplete: envelope.complete,
      supervisionComplete: result.complete,
      traceSessions: (trace?.tests ?? []).reduce((count, test) => count + test.sessions.length, 0),
    };
  } finally {
    await witness.stop();
  }
}

describe('fabricated execution cannot earn credit (real runner, trusted synthesis)', () => {
  it('hostile config writing fake lifecycle + outcomes never loads; the spec is forced to run and fails', async () => {
    const outcome = await runAttack('plain');
    // The hostile config never loaded (its marker is absent): its
    // fabrications never happened. The genuine spec EXECUTED (marker)
    // and failed — no credit at either layer.
    expect(outcome.configMarkerExists).toBe(false);
    expect(outcome.markerExists).toBe(true);
    expect(outcome.adapterComplete).toBe(false);
    expect(outcome.supervisionComplete).toBe(false);
  });

  it('the same attack with an empty action interval still fails', async () => {
    const outcome = await runAttack('empty-interval');
    expect(outcome.configMarkerExists).toBe(false);
    expect(outcome.markerExists).toBe(true);
    expect(outcome.adapterComplete).toBe(false);
    expect(outcome.supervisionComplete).toBe(false);
  });

  it('the same attack with unrelated witness activity still fails', async () => {
    // Unrelated activity cannot substitute for execution: the hostile
    // config never runs, so there is no session to attach it to.
    const outcome = await runAttack('unrelated-activity');
    expect(outcome.configMarkerExists).toBe(false);
    expect(outcome.markerExists).toBe(true);
    expect(outcome.adapterComplete).toBe(false);
    expect(outcome.supervisionComplete).toBe(false);
    expect(outcome.traceSessions).toBeGreaterThan(0); // genuine failure session, sealed failed
  });
});

describe('genuine execution passes (positive control)', () => {
  it('a truly passing spec seals a complete envelope + supervision', async () => {
    const cwd = tempDir('genuine');
    const stateDir = tempDir('genuine-state');
    const runId = 'genuine-run';
    const token = 'suite-token';
    const verifierKey = 'genuine-verifier-key';
    // A hostile-looking config sits in the repo but must never load.
    writeFileSync(join(cwd, 'playwright.config.mjs'), `process.exit(0);\n`);
    const marker = join(cwd, 'executed');
    writeFileSync(
      join(cwd, 'ok.spec.js'),
      [
        `import fs from 'node:fs';`,
        `import { test } from 'playwright/test';`,
        `test('passes genuinely', async () => {`,
        `  fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
        `});`,
        '',
      ].join('\n'),
    );
    const witness = await startWitness({ runId, token, verifierKey, host: '127.0.0.1' });
    const supervisor = new SupervisorClient(witness.url, token, verifierKey);
    await supervisor.registerExpectedSet({
      tests: [{ testId: null, project: null, file: 'ok.spec.js', titlePath: ['passes genuinely'] }],
    });
    const drain = startSupervisorSpoolDrain({ stateDir, runId, witnessUrl: witness.url, runToken: token, verifierKey });
    try {
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: ['k'] },
        { stateDir, runId, vars: {} },
        { cwd, timeoutMs: 60_000 },
      );
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      const trace = await supervisor.executionTrace();
      const doc = readRunnerOutcomes(join(stateDir, 'runner-outcomes.json'));
      expect(doc?.runStatus).toBe('passed');
      const result = superviseExecution(
        [{ logicalKey: 'k', file: 'ok.spec.js', titlePath: ['passes genuinely'], project: null, blockingAnnotations: [] }],
        {
          ...envelope,
          fixtureOutcome: envelope.fixtureOutcome ?? 'unknown',
          shards: envelope.shards ?? null,
          retriesDetected: envelope.retriesDetected === true,
          outcomes: toExecuted(doc?.outcomes ?? [], 'k'),
          sessionTrace: trace?.tests ?? null,
        },
      );
      expect(existsSync(marker)).toBe(true);
      expect(envelope.complete).toBe(true);
      expect(result.complete).toBe(true);
    } finally {
      await witness.stop();
    }
  });
});

describe('drain lifecycle conflicts fail closed', () => {
  it('a lone end and a re-begin over an open slot are reported as conflicts', async () => {
    const stateDir = tempDir('conflict-state');
    const runId = 'conflict-run';
    const token = 'suite-token';
    const verifierKey = 'conflict-verifier-key';
    const witness = await startWitness({ runId, token, verifierKey, host: '127.0.0.1' });
    const supervisor = new SupervisorClient(witness.url, token, verifierKey);
    await supervisor.registerExpectedSet({
      tests: [{ testId: 'real-test', project: null, file: 'r.spec.js', titlePath: ['real'] }],
    });
    const drain = startSupervisorSpoolDrain({ stateDir, runId, witnessUrl: witness.url, runToken: token, verifierKey });
    try {
      // Forged lone end for a test with no open session.
      appendSpoolEvent(spoolPathFor(stateDir, runId), {
        kind: 'testEnd', testId: 'real-test', workerIndex: 0, file: 'r.spec.js',
        titlePath: ['real'], project: null, outcome: 'passed', attempt: 1,
      });
      // Genuine begin, then a forged re-begin over the open slot.
      appendSpoolEvent(spoolPathFor(stateDir, runId), {
        kind: 'testBegin', testId: 'real-test', workerIndex: 0, file: 'r.spec.js',
        titlePath: ['real'], project: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      appendSpoolEvent(spoolPathFor(stateDir, runId), {
        kind: 'testBegin', testId: 'real-test', workerIndex: 0, file: 'r.spec.js',
        titlePath: ['real'], project: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { conflicts } = await drain.stop();
      expect(conflicts.length).toBeGreaterThanOrEqual(1);
      expect(conflicts.join('\n')).toMatch(/lone end|re-began|began.*while/i);
      void supervisor;
    } finally {
      await witness.stop();
    }
  });
});
