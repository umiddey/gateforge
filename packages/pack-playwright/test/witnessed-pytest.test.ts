/**
 * WITNESSED pytest participant tests (server-witnessed persistence
 * channel, GAP 2 fix): a supervised diagnostics suite marked
 * `witnessed: true` runs INSIDE the supervised window with the run-scoped
 * env built by `buildWitnessedPytestChildEnv`, so the pack's real python
 * helper (`gateforge_persistence_intents.py`) can locate and write the
 * run's intents spool and the trusted drain forwards every intent to the
 * witness. Real loopback HTTP, real python child, real spool files — no
 * mocks. Proves:
 * - the witnessed env carries EXACTLY the run-scoped GATEFORGE_* names
 *   (STATE_DIR/RUN_ID/WITNESS_URL/RUN_TOKEN) plus the consumer's own
 *   operational env, and NEVER the verifier key or any other parent-side
 *   state (fail closed on smuggling attempts);
 * - the playwright runner-child rules are unchanged: buildRunnerChildEnv
 *   still refuses the run-state paths (browser path byte-identical);
 * - a genuine pytest participant writing pre intent → mutation → post
 *   intent through the REAL helper yields ONE witnessed `channel:
 *   'server'` record in the witness ledger (probe ran witness-side);
 * - without the run identity (the advisory stripped env) the helper
 *   degrades to an advisory line — the participant never crashes.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { DiagnosticSuite } from '@gate-forge/core';
import { startWitness } from '../src/witness/server.js';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import { executePytestSuite } from '../src/discovery/pytest-adapter.js';
import {
  buildRunnerChildEnv,
  buildWitnessedPytestChildEnv,
  RunnerEnvError,
  RUNNER_PARENT_SIDE_ENV,
  WITNESSED_PYTEST_RUN_ENV,
} from '../src/discovery/runner-env.js';
import { persistenceIntentsPathFor } from '../src/supervisor/index.js';
import { makeTempProject, writeFixtureProject, writeProbeAdapter } from './helpers.js';
import { startMarkerServer } from './marker-server.js';

describe('witnessed pytest participant env (buildWitnessedPytestChildEnv)', () => {
  const ambient = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/consumer',
    PORTAL_TX_TEST_DSN: 'postgresql://postgres@127.0.0.1:25433/tx_test',
    GATEFORGE_WITNESS_VERIFIER_KEY: 'ambient-verifier-secret',
    GATEFORGE_OBLIGATIONS: '/ambient/obligations.json',
    GATEFORGE_OUTCOMES_FILE: '/ambient/runner-outcomes.json',
    GATEFORGE_ADAPTERS_DIR: '/ambient/adapters',
  };

  it('carries exactly the run-scoped names plus the consumer env, never the verifier key', () => {
    const child = buildWitnessedPytestChildEnv(
      {
        GATEFORGE_STATE_DIR: '/run/state',
        GATEFORGE_RUN_ID: 'run-1',
        GATEFORGE_WITNESS_URL: 'http://127.0.0.1:9/witness',
        GATEFORGE_RUN_TOKEN: 'token-1',
      },
      ambient,
    );
    // The run-scoped allowlist crosses — the ONLY GATEFORGE_* names.
    for (const name of WITNESSED_PYTEST_RUN_ENV) {
      expect(child[name]).toBeDefined();
    }
    expect(child['GATEFORGE_STATE_DIR']).toBe('/run/state');
    expect(child['GATEFORGE_RUN_ID']).toBe('run-1');
    // Everything else privileged stays parent-side.
    expect(child['GATEFORGE_WITNESS_VERIFIER_KEY']).toBeUndefined();
    expect(child['GATEFORGE_OBLIGATIONS']).toBeUndefined();
    expect(child['GATEFORGE_OUTCOMES_FILE']).toBeUndefined();
    expect(child['GATEFORGE_ADAPTERS_DIR']).toBeUndefined();
    // The consumer's own operational env is NOT gateforge wiring and
    // crosses (the participant is a diagnostics-style untrusted run).
    expect(child['PORTAL_TX_TEST_DSN']).toBe('postgresql://postgres@127.0.0.1:25433/tx_test');
    expect(child['PATH']).toBe('/usr/bin:/bin');
    // No other GATEFORGE_* name leaks in.
    for (const name of Object.keys(child)) {
      if (name.startsWith('GATEFORGE_')) expect(WITNESSED_PYTEST_RUN_ENV).toContain(name);
    }
  });

  it('throws on a smuggled verifier key or non-allowlisted parent-side name (fail closed)', () => {
    expect(() =>
      buildWitnessedPytestChildEnv({ GATEFORGE_WITNESS_VERIFIER_KEY: 'x' }, ambient),
    ).toThrow(RunnerEnvError);
    for (const forbidden of ['GATEFORGE_OBLIGATIONS', 'GATEFORGE_OUTCOMES_FILE', 'GATEFORGE_ADAPTERS_DIR', 'GATEFORGE_CLASSIFICATIONS']) {
      expect(() => buildWitnessedPytestChildEnv({ [forbidden]: '/x' }, ambient)).toThrow(RunnerEnvError);
    }
  });

  it('keeps the playwright runner-child rules byte-identical: run-state paths stay refused', () => {
    // The browser path is untouched: the witnessed relaxation is scoped
    // to the pytest participant builder ONLY.
    for (const parentSide of RUNNER_PARENT_SIDE_ENV) {
      expect(() => buildRunnerChildEnv({ [parentSide]: '/x' }, {})).toThrow(RunnerEnvError);
    }
    expect(() => buildRunnerChildEnv({ GATEFORGE_WITNESS_VERIFIER_KEY: 'x' }, {})).toThrow(RunnerEnvError);
  });
});

/** The helper ships with the pack; participants import it by path. */
const HELPER_PATH = fileURLToPath(new URL('../python/gateforge_persistence_intents.py', import.meta.url));

const TOKEN = 'run-token-witnessed-pytest';
const VERIFIER_KEY = 'verifier-secret-the-participant-never-sees';
const CREATE_CLAIM = 'tenant.accounts:persistence:create';
const TEST_ID = 'pytest:backend-outbox-pytest:backend/tests/test_outbox_sim.py:test_writes_intents_around_mutation';

/** A witnessed suite: real pytest, writing intents through the REAL helper. */
function witnessedSuite(): DiagnosticSuite {
  return {
    name: 'backend-outbox-pytest',
    runner: 'pytest',
    cwd: '.',
    argv: ['python3', '-m', 'pytest', '-q'],
    testPaths: ['backend/tests'],
    timeoutMs: 120_000,
    witnessed: true,
  };
}

const PARTICIPANT_TEST = `
import importlib.util, json, os, time, urllib.request

def _helper():
    spec = importlib.util.spec_from_file_location("gfi", os.environ["HELPER_PATH"])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def test_writes_intents_around_mutation():
    helper = _helper()
    claim = os.environ["CLAIM_ID"]
    # The run identity crosses ONLY through the supervised witnessed env.
    assert os.environ["GATEFORGE_STATE_DIR"]
    assert os.environ["GATEFORGE_RUN_ID"]
    assert "GATEFORGE_WITNESS_VERIFIER_KEY" not in os.environ
    helper.gateforge_intent("tenant.accounts", "create", "pre", "expect-absent", "2", claim, os.environ["TEST_ID"], 1)
    time.sleep(helper.PRE_INTENT_SETTLE_SECONDS)
    body = json.dumps({"first_name": "Grace", "last_name": "Hopper"}).encode()
    request = urllib.request.Request(
        os.environ["APP_URL"] + "/api/accounts",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(request)
    helper.gateforge_intent("tenant.accounts", "create", "post", "expect-present", "2", claim, os.environ["TEST_ID"], 2)
`;

async function ledgerRecords(url: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${url}/records`, { headers: { 'x-gateforge-run': TOKEN } });
  return ((await response.json()) as { records: Array<Record<string, unknown>> }).records;
}

async function waitForRecords(url: string, count: number): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const records = await ledgerRecords(url);
    if (records.length >= count) return records;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  return ledgerRecords(url);
}

describe('supervised witnessed pytest participant (server-witnessed channel)', () => {
  it('writes the intents spool through the real helper; the drain forwards; the witness stamps ONE server record', async () => {
    const runId = randomUUID();
    const project = makeTempProject('witnessed-pytest');
    writeFixtureProject(project);
    writeProbeAdapter(project);
    mkdirSync(join(project, 'backend/tests'), { recursive: true });
    writeFileSync(join(project, 'backend/tests/test_outbox_sim.py'), PARTICIPANT_TEST);
    const stateDir = join(project, '.gateforge/test-gates');
    const target = await startMarkerServer('example-v1');
    const witness = await startWitness({
      runId,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir: join(project, '.gateforge/adapters'),
      classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
      targetBaseUrl: target.url,
      targetFingerprint: 'example-v1',
      adapterBaseUrl: target.url,
      now: () => '2026-08-30T12:00:01.000Z',
    });
    // The drain is the trusted counterpart: live WHILE the participant
    // runs, exactly like the supervised window in test-gates.
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: witness.url,
      runToken: TOKEN,
      verifierKey: VERIFIER_KEY,
      pollMs: 10,
      serverE2eObligations: [CREATE_CLAIM],
    });
    try {
      const childEnv = buildWitnessedPytestChildEnv(
        {
          GATEFORGE_STATE_DIR: stateDir,
          GATEFORGE_RUN_ID: runId,
          GATEFORGE_WITNESS_URL: witness.url,
          GATEFORGE_RUN_TOKEN: TOKEN,
          // Non-GATEFORGE supervision wiring passes through (helper path,
          // app base, claim/test identities for this fixture).
          HELPER_PATH: HELPER_PATH,
          APP_URL: target.url,
          CLAIM_ID: CREATE_CLAIM,
          TEST_ID: TEST_ID,
        },
        { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      );
      const result = await executePytestSuite(witnessedSuite(), project, stateDir, { env: childEnv });
      // The participant ran green (failures would print its junit output).
      expect(result.incompleteDetail).toBeNull();
      expect(result.status).toBe('completed');
      expect(result.counts.passed).toBe(1);
      // The helper located the run-scoped spool (env-carried identity).
      expect(existsSync(persistenceIntentsPathFor(stateDir, runId))).toBe(true);
      // The drain forwarded both intents; the witness's own probe stamped
      // ONE witnessed server-channel record with the observed before/after.
      const records = await waitForRecords(witness.url, 1);
      expect(records).toHaveLength(1);
      expect(records[0]?.['trust']).toBe('witnessed');
      expect(records[0]?.['testId']).toBe(TEST_ID);
      const payload = records[0]?.['payload'] as Record<string, unknown>;
      expect(payload['channel']).toBe('server');
      expect(payload['declaredKind']).toBe('server-e2e');
      expect(payload['before']).toEqual({ entityAbsent: true });
      expect(payload['fields']).toMatchObject({ first_name: 'Grace' });
      const stopped = await drain.stop();
      expect(stopped.conflicts).toEqual([]);
      expect(stopped.intentFailures).toEqual([]);
    } finally {
      await witness.stop();
      await target.stop();
    }
  }, 60_000);

  it('without the run identity (advisory stripped env) the helper degrades without crashing the participant', async () => {
    const project = makeTempProject('witnessed-pytest-stripped');
    mkdirSync(join(project, 'backend/tests'), { recursive: true });
    writeFileSync(
      join(project, 'backend/tests/test_outbox_sim.py'),
      `
import importlib.util, os
spec = importlib.util.spec_from_file_location("gfi", os.environ["HELPER_PATH"])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
def test_intent_outside_the_window_degrades():
    # No GATEFORGE_STATE_DIR/RUN_ID in an advisory (stripped) env: the
    # append degrades to an advisory line — the participant stays green,
    # the claim simply stays blocking (fail closed, never a crash).
    helper.gateforge_intent("tenant.accounts", "create", "pre", "expect-absent", "2", "c", "t", 1)
`,
    );
    try {
      const result = await executePytestSuite(witnessedSuite(), project, join(project, '.gateforge/test-gates'), {
        env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', HELPER_PATH: HELPER_PATH },
      });
      expect(result.status).toBe('completed');
      expect(result.counts.passed).toBe(1);
      // Nothing was written anywhere in the project state: no spool
      // exists because no run identity ever reached the participant.
      expect(existsSync(join(project, '.gateforge/test-gates/spool'))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});
