/**
 * Supervised Playwright execution tests (plan 2026-09-13 Phase 4 items
 * 1-2, ADR 0005 D2, execution-authority fix): the adapter's `execute`
 * runs the suite through a stub runner — the gateforge reporter's
 * outcomes document is REQUIRED input (never silently replaced), the
 * consumer config is never loaded (trusted synthesis), no run-state
 * path or secret crosses to the child, and every incomplete shape
 * (missing outcomes, nonzero exit, retry attempts, timeout) is a typed
 * incomplete envelope, never a silent green.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { startWitness } from '../src/witness/server.js';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import { spoolPathFor } from '../src/supervisor/spool.js';
import { SupervisorClient } from '../src/supervisor/client.js';
import { superviseExecution } from '@gate-forge/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultPlaywrightCommand,
  executeSupervisedPlaywright,
  playwrightVersion,
  readRunnerOutcomes,
  type RunnerOutcomesDocument,
} from '../src/discovery/supervised-run.js';
import { RunnerEnvError } from '../src/discovery/runner-env.js';

const DIRECTORIES: string[] = [];

afterEach(() => {
  for (const dir of DIRECTORIES.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp repo root with a playwright config (consumer wiring present). */
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-supervised-'));
  DIRECTORIES.push(dir);
  writeFileSync(join(dir, 'playwright.config.ts'), 'export default { projects: [] };\n');
  return dir;
}

/** A run-state dir. */
function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-supervised-state-'));
  DIRECTORIES.push(dir);
  return dir;
}

/** A stub runner command: writes the given outcomes document, exits with `code`. */
function stubRunner(
  stateDir: string,
  document: RunnerOutcomesDocument | null,
  code: number,
  delayMs = 0,
): readonly string[] {
  // The outcomes path is baked into the stub (execution-authority fix:
  // GATEFORGE_OUTCOMES_FILE no longer crosses to the runner child — the
  // engine reporter receives it as a trusted-config option instead).
  const outcomesPath = join(stateDir, 'runner-outcomes.json');
  const script = `
    const fs = require('node:fs');
    const path = ${JSON.stringify(outcomesPath)};
    ${document === null ? '' : `fs.writeFileSync(path, ${JSON.stringify(JSON.stringify(document))});`}
    setTimeout(() => process.exit(${String(code)}), ${String(delayMs)});
  `;
  return [process.execPath, '-e', script];
}

/** One full first-attempt passing row (kept separate so spreads stay complete). */
const PASSING_ROW = {
  testId: 's1',
  file: 'e2e/a.spec.ts',
  titlePath: ['deletes'],
  project: 'chromium' as string | null,
  status: 'passed',
  attempt: 1,
  expectedFailure: false,
};

const PASSING_DOC: RunnerOutcomesDocument = {
  schemaVersion: 1,
  runStatus: 'passed',
  runnerErrors: [],
  shard: null,
  outcomes: [PASSING_ROW],
};

describe('executeSupervisedPlaywright (wired adapter execute)', () => {
  it('a complete first-attempt run yields a complete envelope with normalized outcomes', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      { command: stubRunner(stateDir, PASSING_DOC, 0), cwd, timeoutMs: 30_000 },
    );
    expect(envelope.complete).toBe(true);
    expect(envelope.processExit).toBe(0);
    expect(envelope.fixtureOutcome).toBe('passed');
    expect(envelope.outcomes[0]).toMatchObject({ status: 'passed', attempt: 1, logicalKey: 'e2e/a.spec.ts#deletes' });
    expect(envelope.retriesDetected).toBe(false);
    expect(envelope.engines?.['node']).toBe(process.version);
    expect(envelope.engines?.['playwright']).toBe(playwrightVersion());
  });

  it('a missing outcomes document (reporter not wired) is INCOMPLETE — wiring is never silently replaced', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      { command: stubRunner(stateDir, null, 0), cwd, timeoutMs: 30_000 },
    );
    expect(envelope.complete).toBe(false);
    expect(envelope.incompleteDetail).toMatch(/reporter|outcomes/i);
    expect(envelope.fixtureOutcome).toBe('unknown');
  });

  it('a stale outcomes file from a previous run is never readable as this run (deleted pre-run)', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const outcomesPath = join(stateDir, 'runner-outcomes.json');
    writeFileSync(outcomesPath, '{"schemaVersion":1,"outcomes":[]}');
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      { command: stubRunner(stateDir, null, 0), cwd, timeoutMs: 30_000 },
    );
    expect(envelope.complete).toBe(false);
  });

  it('a nonzero runner exit is incomplete even when the reporter said passed', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      { command: stubRunner(stateDir, PASSING_DOC, 3), cwd, timeoutMs: 30_000 },
    );
    expect(envelope.complete).toBe(false);
    expect(envelope.processExit).toBe(3);
  });

  it('runner-level errors (global setup/teardown) fail the fixture outcome', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      {
        command: stubRunner(stateDir, { ...PASSING_DOC, runnerErrors: ['teardown crashed'] }, 1),
        cwd,
        timeoutMs: 30_000,
      },
    );
    expect(envelope.complete).toBe(false);
    expect(envelope.fixtureOutcome).toBe('failed');
  });

  it('an attempt-2 outcome is retry-assisted: incomplete with zero-retry detail (E08)', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      {
        command: stubRunner(
          stateDir,
          { ...PASSING_DOC, outcomes: [{ ...PASSING_ROW, attempt: 2 }] },
          0,
        ),
        cwd,
        timeoutMs: 30_000,
      },
    );
    expect(envelope.complete).toBe(false);
    expect(envelope.retriesDetected).toBe(true);
    expect(envelope.retriesDetail).toMatch(/attempt 2/);
  });

  it('an incomplete shard is incomplete (E12)', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      {
        command: stubRunner(stateDir, { ...PASSING_DOC, shard: { index: 1, total: 2 } }, 0),
        cwd,
        timeoutMs: 30_000,
      },
    );
    expect(envelope.complete).toBe(false);
    expect(envelope.shards).toEqual({ complete: false, detail: 'TEST_SHARD reported 1/2' });
  });

  it('a timeout kill is a typed incomplete run, never a pass', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      { command: stubRunner(stateDir, PASSING_DOC, 0, 60_000), cwd, timeoutMs: 250 },
    );
    expect(envelope.complete).toBe(false);
    expect(envelope.incompleteDetail).toMatch(/exceeded its .* bound/i);
  });

  it('no consumer config is needed or loaded: the trusted synthesis runs without one', async () => {
    // Execution-authority fix: the supervisor synthesizes its own trusted
    // config and never loads the consumer's — a missing consumer config
    // is not a block (the old fail-closed message is gone); a stubbed
    // passing run still seals complete.
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-supervised-noconfig-'));
    DIRECTORIES.push(dir);
    const stateDir = tempStateDir();
    const envelope = await executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      { command: stubRunner(stateDir, PASSING_DOC, 0), cwd: dir, timeoutMs: 30_000 },
    );
    expect(envelope.complete).toBe(true);
  });

  it('signing-sentinel-not-inherited: the runner child never sees the parent verifier key (real supervised run, enforcement-review fix 1)', async () => {
    // THE review attack: `superviseExecution` used to merge `process.env`
    // wholesale into the runner child, so the parent's
    // GATEFORGE_WITNESS_VERIFIER_KEY — the key that authenticates gate
    // receipts and the witness supervisor/attestation surface — reached
    // untrusted test code. The child env is an ALLOWLIST now; this probe
    // runs a REAL child process whose parent carries the sentinel and
    // makes the child itself assert its absence from its own environ.
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const probePath = join(stateDir, 'env-probe.json');
    const outcomesPath = join(stateDir, 'runner-outcomes.json');
    const script = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({
        sentinelPresent: Object.prototype.hasOwnProperty.call(process.env, 'GATEFORGE_WITNESS_VERIFIER_KEY'),
        sentinelValue: process.env.GATEFORGE_WITNESS_VERIFIER_KEY ?? null,
        runTokenPresent: process.env.GATEFORGE_RUN_TOKEN === 'suite-run-token',
        pathPresent: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
        stateDirPresent: Object.prototype.hasOwnProperty.call(process.env, 'GATEFORGE_STATE_DIR'),
        runIdPresent: Object.prototype.hasOwnProperty.call(process.env, 'GATEFORGE_RUN_ID'),
        outcomesEnvPresent: Object.prototype.hasOwnProperty.call(process.env, 'GATEFORGE_OUTCOMES_FILE'),
      }));
      fs.writeFileSync(${JSON.stringify(outcomesPath)}, ${JSON.stringify(JSON.stringify(PASSING_DOC))});
      process.exit(0);
    `;
    const previous = process.env.GATEFORGE_WITNESS_VERIFIER_KEY;
    process.env.GATEFORGE_WITNESS_VERIFIER_KEY = 'parent-signing-sentinel-key';
    try {
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: ['k'] },
        // The run token IS the suite's own submission credential by
        // design; the verifier key is not (and is not in `vars` either —
        // only the ambient parent env carries it).
        { stateDir, runId: 'run', vars: { GATEFORGE_RUN_TOKEN: 'suite-run-token' } },
        { command: [process.execPath, '-e', script], cwd, timeoutMs: 30_000 },
      );
      expect(envelope.complete).toBe(true);
      const probe = JSON.parse(readFileSync(probePath, 'utf8')) as {
        sentinelPresent: boolean;
        sentinelValue: string | null;
        runTokenPresent: boolean;
        pathPresent: boolean;
        stateDirPresent: boolean;
        runIdPresent: boolean;
        outcomesEnvPresent: boolean;
      };
      // The sentinel never crossed; the runner kept what it needs; no
      // run-state path crosses either (execution-authority fix).
      expect(probe.sentinelPresent).toBe(false);
      expect(probe.sentinelValue).toBeNull();
      expect(probe.runTokenPresent).toBe(true);
      expect(probe.pathPresent).toBe(true);
      expect(probe.stateDirPresent).toBe(false);
      expect(probe.runIdPresent).toBe(false);
      expect(probe.outcomesEnvPresent).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GATEFORGE_WITNESS_VERIFIER_KEY;
      else process.env.GATEFORGE_WITNESS_VERIFIER_KEY = previous;
    }
  });

  it('stuffing the verifier key into the supervisor vars is refused (fail closed on the wiring bug)', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    await expect(
      executeSupervisedPlaywright(
        { logicalKeys: ['k'] },
        { stateDir, runId: 'run', vars: { GATEFORGE_WITNESS_VERIFIER_KEY: 'leak' } },
        { command: stubRunner(stateDir, PASSING_DOC, 0), cwd, timeoutMs: 30_000 },
      ),
    ).rejects.toThrow(RunnerEnvError);
  });

  it('stuffing a run-state path into the supervisor vars is refused (fail closed on the wiring bug)', async () => {
    const cwd = tempProject();
    const stateDir = tempStateDir();
    await expect(
      executeSupervisedPlaywright(
        { logicalKeys: ['k'] },
        { stateDir, runId: 'run', vars: { GATEFORGE_STATE_DIR: stateDir } },
        { command: stubRunner(stateDir, PASSING_DOC, 0), cwd, timeoutMs: 30_000 },
      ),
    ).rejects.toThrow(RunnerEnvError);
  });
});

describe('defaultPlaywrightCommand (the supervised runner spawn)', () => {
  it('spawns the pinned playwright CLI as a plain absolute PATH, never a file: URL', () => {
    // Regression (E22 supervised run): a `file:` URL as Node's entry
    // argument dies with MODULE_NOT_FOUND before the runner starts —
    // masquerading as a failed suite with no outcomes document.
    const argv = defaultPlaywrightCommand();
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toMatch(/cli\.js$/);
    expect(argv[1]?.startsWith('file:')).toBe(false);
    expect(existsSync(argv[1] ?? '')).toBe(true);
  });
});

describe('readRunnerOutcomes (supervision input validation)', () => {
  it('parses a well-formed document and normalizes optional fields', () => {
    const dir = tempStateDir();
    const path = join(dir, 'runner-outcomes.json');
    writeFileSync(path, JSON.stringify(PASSING_DOC));
    const document = readRunnerOutcomes(path);
    expect(document).not.toBeNull();
    expect(document?.outcomes[0]?.project).toBe('chromium');
    expect(document?.shard).toBeNull();
  });

  it('missing or malformed documents are null (supervision fails closed downstream)', () => {
    expect(readRunnerOutcomes(join(tempStateDir(), 'absent.json'))).toBeNull();
    const dir = tempStateDir();
    const path = join(dir, 'runner-outcomes.json');
    writeFileSync(path, '{"schemaVersion":1,"outcomes":[{"file":42}]}');
    expect(readRunnerOutcomes(path)).toBeNull();
    writeFileSync(path, 'not json at all');
    expect(readRunnerOutcomes(path)).toBeNull();
  });
});

/**
 * Real-runner fabrication attacks moved to `execution-authority.test.ts`
 * (playwright-evidence class): under trusted-config synthesis the hostile
 * consumer config never loads, so those probes assert the spec FORCED to
 * execute and the run FAILING — the inverse of the old activity-check
 * assertions this file used to carry.
 */
