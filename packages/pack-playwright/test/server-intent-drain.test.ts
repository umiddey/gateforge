/**
 * Server-witnessed persistence channel tests (drain side): the trusted
 * CLI drain polls the persistence-intents spool the supervised suite may
 * only WRITE and forwards each intent over the verifier-key supervisor
 * surface. Real loopback HTTP, real spool files, no mocks. Proves:
 * - a genuine pre/post intent pair produces ONE witnessed server-channel
 *   record in the witness ledger (probe executed witness-side);
 * - the drain registers the server-e2e declarations BEFORE forwarding
 *   (intents for undeclared obligations resolve typed TEST_KIND_UNKNOWN
 *   failures, surfaced on stop — never satisfaction);
 * - replayed sequences fail closed with typed failures;
 * - corrupt/garbage spool lines never crash the drain and never mint
 *   records (fail closed: the claim simply stays blocking);
 * - the lifecycle spool and the intents spool coexist (one drain, both).
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWitness } from '../src/witness/server.js';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import {
  appendPersistenceIntent,
  appendSpoolEvent,
  persistenceIntentsPathFor,
  spoolPathFor,
  type PersistenceIntent,
} from '../src/supervisor/index.js';
import { makeTempProject, writeFixtureProject, writeProbeAdapter } from './helpers.js';
import { startMarkerServer } from './marker-server.js';
import { RUN_HEADER, VERIFIER_HEADER, SPOOL_DIR_NAME } from '../src/constants.js';

const TOKEN = 'run-token-abc-123';
const VERIFIER_KEY = 'verifier-secret-the-suite-never-sees';
const TEST_ID = 'pytest:backend-outbox-pytest:backend/tests/integration/test_x.py:test_commits';
const CREATE_CLAIM = 'tenant.accounts:persistence:create';

/** A create intent pair against the marker server's next minted id ('2'). */
function createIntents(): PersistenceIntent[] {
  return [
    {
      entity: 'tenant.accounts',
      operation: 'create',
      phase: 'pre',
      intent: 'expect-absent',
      key: '2',
      claimId: CREATE_CLAIM,
      testId: TEST_ID,
      sequence: 1,
    },
    {
      entity: 'tenant.accounts',
      operation: 'create',
      phase: 'post',
      intent: 'expect-present',
      key: '2',
      claimId: CREATE_CLAIM,
      testId: TEST_ID,
      sequence: 2,
    },
  ];
}

async function startDrainFixture() {
  const runId = randomUUID();
  const project = makeTempProject('server-intent-drain');
  writeFixtureProject(project);
  writeProbeAdapter(project);
  const target = await startMarkerServer('example-v1');
  const stateDir = join(project, '.gateforge/test-gates');
  mkdirSync(stateDir, { recursive: true });
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
  // The app-side mutation the "suite" performs between pre and post: the
  // marker mints ids 2, 3, ... on a fresh instance.
  const createAccount = async (): Promise<void> => {
    await fetch(`${target.url}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'Grace', last_name: 'Hopper' }),
    });
  };
  return { witness, target, project, stateDir, runId, createAccount };
}

async function ledgerRecords(url: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${url}/records`, { headers: { [RUN_HEADER]: TOKEN } });
  return ((await response.json()) as { records: Array<Record<string, unknown>> }).records;
}

/** Waits (bounded) until the ledger holds `count` records. */
async function waitForRecords(url: string, count: number): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const records = await ledgerRecords(url);
    if (records.length >= count) return records;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  return ledgerRecords(url);
}

describe('supervisor drain forwards persistence intents (server-witnessed channel)', () => {
  it('a genuine pre/post intent pair yields one witnessed channel=server record', async () => {
    const fixture = await startDrainFixture();
    const intentsFile = persistenceIntentsPathFor(fixture.stateDir, fixture.runId);
    const drain = startSupervisorSpoolDrain({
      stateDir: fixture.stateDir,
      runId: fixture.runId,
      witnessUrl: fixture.witness.url,
      runToken: TOKEN,
      verifierKey: VERIFIER_KEY,
      pollMs: 10,
      serverE2eObligations: [CREATE_CLAIM],
    });
    try {
      const [pre, post] = createIntents() as [PersistenceIntent, PersistenceIntent];
      appendPersistenceIntent(intentsFile, pre);
      // TIMING CONTRACT: pre intents are observed at the drain's next
      // poll, so the suite allows one drain tick before mutating (a
      // mutation racing the probe would honestly grade absent-before
      // false and fail closed — this wait keeps the honest run green).
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 120));
      await fixture.createAccount();
      // The post intent follows the mutation, exactly as a real suite
      // writes it after its app-side operation completes.
      appendPersistenceIntent(intentsFile, post);
      const records = await waitForRecords(fixture.witness.url, 1);
      expect(records).toHaveLength(1);
      const payload = records[0]?.['payload'] as Record<string, unknown>;
      expect(records[0]?.['trust']).toBe('witnessed');
      expect(payload['channel']).toBe('server');
      expect(payload['declaredKind']).toBe('server-e2e');
      expect(payload['before']).toEqual({ entityAbsent: true });
      expect(payload['fields']).toMatchObject({ first_name: 'Grace' });
      const stopped = await drain.stop();
      expect(stopped.conflicts).toEqual([]);
      expect(stopped.intentFailures).toEqual([]);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('lifecycle events and intents share one drain (sessions still open/close)', async () => {
    const fixture = await startDrainFixture();
    const drain = startSupervisorSpoolDrain({
      stateDir: fixture.stateDir,
      runId: fixture.runId,
      witnessUrl: fixture.witness.url,
      runToken: TOKEN,
      verifierKey: VERIFIER_KEY,
      pollMs: 10,
      serverE2eObligations: [CREATE_CLAIM],
    });
    try {
      appendSpoolEvent(spoolPathFor(fixture.stateDir, fixture.runId), {
        kind: 'testBegin',
        testId: TEST_ID,
        workerIndex: 0,
        file: 'backend/tests/integration/test_x.py',
        titlePath: ['test_commits'],
        project: null,
      });
      const [pre, post] = createIntents() as [PersistenceIntent, PersistenceIntent];
      appendPersistenceIntent(persistenceIntentsPathFor(fixture.stateDir, fixture.runId), pre);
      // One drain tick so the pre intent is observed before the mutation.
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 120));
      await fixture.createAccount();
      appendPersistenceIntent(persistenceIntentsPathFor(fixture.stateDir, fixture.runId), post);
      const records = await waitForRecords(fixture.witness.url, 1);
      expect(records).toHaveLength(1);
      const stopped = await drain.stop();
      expect(stopped.conflicts).toEqual([]);
      expect(stopped.intentFailures).toEqual([]);
      // The session opened by the drained lifecycle event was sealed by
      // the final sweep (force-close) — no session left open.
      const traceResponse = await fetch(`${fixture.witness.url}/runs/execution-trace`, {
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
      });
      const trace = (await traceResponse.json()) as { tests: Array<{ sessions: Array<{ outcome: string | null }> }> };
      expect(trace.tests[0]?.sessions[0]?.outcome).toBeNull(); // force-closed, no outcome
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('undeclared obligations and replayed sequences resolve as typed failures', async () => {
    const fixture = await startDrainFixture();
    const intentsFile = persistenceIntentsPathFor(fixture.stateDir, fixture.runId);
    const drain = startSupervisorSpoolDrain({
      stateDir: fixture.stateDir,
      runId: fixture.runId,
      witnessUrl: fixture.witness.url,
      runToken: TOKEN,
      verifierKey: VERIFIER_KEY,
      pollMs: 10,
      serverE2eObligations: [CREATE_CLAIM],
    });
    try {
      const undeclared: PersistenceIntent = {
        ...createIntents()[0] as PersistenceIntent,
        claimId: 'tenant.accounts:persistence:delete',
        operation: 'delete',
      };
      appendPersistenceIntent(intentsFile, undeclared);
      appendPersistenceIntent(intentsFile, createIntents()[0] as PersistenceIntent);
      appendPersistenceIntent(intentsFile, createIntents()[0] as PersistenceIntent); // replayed sequence
      const stopped = await drain.stop();
      expect(stopped.intentFailures).toHaveLength(2);
      expect(stopped.intentFailures[0]).toContain('[TEST_KIND_UNKNOWN]');
      expect(stopped.intentFailures[0]).toContain('tenant.accounts:persistence:delete');
      expect(stopped.intentFailures[1]).toContain('strictly increasing');
      // The replayed PRE never stored twice and no record was issued: the
      // witness ledger stays empty (fail closed, never satisfaction).
      expect(await ledgerRecords(fixture.witness.url)).toHaveLength(0);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('never registers declarations when none are passed: intents fail typed (inert until wired)', async () => {
    const fixture = await startDrainFixture();
    const intentsFile = persistenceIntentsPathFor(fixture.stateDir, fixture.runId);
    const drain = startSupervisorSpoolDrain({
      stateDir: fixture.stateDir,
      runId: fixture.runId,
      witnessUrl: fixture.witness.url,
      runToken: TOKEN,
      verifierKey: VERIFIER_KEY,
      pollMs: 10,
      // NO serverE2eObligations: the channel is inert until the
      // integrator passes the trusted mapping layer's declarations.
    });
    try {
      appendPersistenceIntent(intentsFile, createIntents()[0] as PersistenceIntent);
      const stopped = await drain.stop();
      expect(stopped.intentFailures).toHaveLength(1);
      expect(stopped.intentFailures[0]).toContain('[TEST_KIND_UNKNOWN]');
      expect(await ledgerRecords(fixture.witness.url)).toHaveLength(0);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('ignores corrupt spool lines without crashing or minting records', async () => {
    const fixture = await startDrainFixture();
    const intentsFile = persistenceIntentsPathFor(fixture.stateDir, fixture.runId);
    mkdirSync(join(intentsFile, '..'), { recursive: true });
    writeFileSync(intentsFile, 'this is not json\n{"entity":"tenant.accounts"}\n', 'utf8');
    const drain = startSupervisorSpoolDrain({
      stateDir: fixture.stateDir,
      runId: fixture.runId,
      witnessUrl: fixture.witness.url,
      runToken: TOKEN,
      verifierKey: VERIFIER_KEY,
      pollMs: 10,
      serverE2eObligations: [CREATE_CLAIM],
    });
    try {
      const stopped = await drain.stop();
      expect(stopped.conflicts).toEqual([]);
      expect(stopped.intentFailures).toEqual([]);
      expect(await ledgerRecords(fixture.witness.url)).toHaveLength(0);
      // The spool file is preserved (append-only; the drain never rewrites).
      expect(readFileSync(intentsFile, 'utf8')).toContain('this is not json');
      void SPOOL_DIR_NAME;
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});
