/**
 * Fixture-surface tests (invariant 6, GF-22, GF-24 left side):
 *
 * - the evidence object is FROZEN and exposes EXACTLY
 *   ui/visible/persistence/http/finalize (no `prove` escape hatch);
 * - forged receipts (hand-rolled or Object.create-branded) are
 *   rejected by `visible.confirm`/`persistence.verify` BEFORE any page
 *   or witness interaction (GF-22);
 * - `finalize()` fails fast when a claim produced zero records (the
 *   gate would grade it missing);
 * - the fixture requires a gateforge claim annotation (GF-24 bypass
 *   produces no claims to grade).
 */
import { describe, expect, it } from 'vitest';
import type { Page, TestInfo } from 'playwright/test';
import { createEvidence } from '../src/fixture/evidence.js';
import { WitnessClient, resolveWitnessUrl } from '../src/fixture/witness-client.js';
import { startWitness } from '../src/witness/server.js';
import { startMarkerServer } from './marker-server.js';
import { makeTempProject, writeFixtureProject, writeHonestAdapter, FINGERPRINT } from './helpers.js';
import { join } from 'node:path';

const RUN_ID = '6f1c3f90-2d5e-4b1a-9c6d-0f0e2b8a1c9d';
const TOKEN = 'fixture-token';
const OBLIGATION = 'tenant.accounts:persistence:update';

/** A Page stand-in: panics on any real browser call (not reached by the
 *  paths under test, which fail at the receipt/claim checks first). */
function dummyPage(): Page {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        throw new Error(`dummy page: browser method '${String(prop)}' must not be reached`);
      },
    },
  ) as unknown as Page;
}

function testInfoOf(annotations: Array<{ type: string; description: string }>): TestInfo {
  return {
    annotations,
    testId: 'fixture-test-id-1',
    title: 'fixture test',
  } as unknown as TestInfo;
}

async function startFixtureWitness() {
  const project = makeTempProject('fixture');
  writeFixtureProject(project);
  writeHonestAdapter(project);
  const target = await startMarkerServer(FINGERPRINT);
  const witness = await startWitness({
    runId: RUN_ID,
    token: TOKEN,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
    targetBaseUrl: target.url,
    targetFingerprint: FINGERPRINT,
    adapterBaseUrl: target.url,
    now: () => '2026-08-30T12:00:01.000Z',
  });
  return { witness, target, project };
}

describe('frozen surface, no escape hatch (invariant 6, GF-11)', () => {
  it('exposes exactly ui/visible/persistence/finalize and is frozen', async () => {
    const fixture = await startFixtureWitness();
    try {
      process.env.GATEFORGE_WITNESS_URL = fixture.witness.url;
      process.env.GATEFORGE_APP_BASE_URL = "http://127.0.0.1:9"; // dummy loopback base (receipt tests never reach the app)
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      const evidence = createEvidence({
        page: dummyPage(),
        testInfo: testInfoOf([{ type: 'gateforge', description: OBLIGATION }]),
      });
      // ADR 0004 D7 (phase 6) adds the fourth frozen surface: the
      // http observation primitive bound to http:* claims. The witnessed
      // domain-check channel was RETIRED: scenario labels derived from a
      // status class cannot prove domain semantics, so check contracts
      // stay fail-closed until real state-observing producers exist.
      expect(Object.keys(evidence).sort()).toEqual([
        'finalize',
        'http',
        'persistence',
        'ui',
        'visible',
      ]);
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence.ui)).toBe(true);
      expect(Object.isFrozen(evidence.http)).toBe(true);
      expect(Object.isFrozen(evidence.visible)).toBe(true);
      expect(Object.isFrozen(evidence.persistence)).toBe(true);
      // No boolean escape hatch exists (GF-11: registration path absent).
      const asRecord = evidence as unknown as Record<string, unknown>;
      expect(typeof asRecord['prove']).toBe('undefined');
      expect(typeof (evidence.ui as unknown as Record<string, unknown>)['prove']).toBe('undefined');
      expect(Object.keys(evidence.ui).sort()).toEqual(['archive', 'create', 'read', 'update']);
    } finally {
      delete process.env.GATEFORGE_WITNESS_URL;
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('requires a gateforge claim annotation (defense in depth for GF-24)', async () => {
    const fixture = await startFixtureWitness();
    try {
      process.env.GATEFORGE_WITNESS_URL = fixture.witness.url;
      process.env.GATEFORGE_APP_BASE_URL = "http://127.0.0.1:9"; // dummy loopback base (receipt tests never reach the app)
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      expect(() =>
        createEvidence({
          page: dummyPage(),
          testInfo: testInfoOf([]),
        }),
      ).toThrow(/declares no 'gateforge' annotation/);
    } finally {
      delete process.env.GATEFORGE_WITNESS_URL;
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('receipt brands (GF-22)', () => {
  it('rejects a hand-rolled receipt in visible.confirm', async () => {
    const fixture = await startFixtureWitness();
    try {
      process.env.GATEFORGE_WITNESS_URL = fixture.witness.url;
      process.env.GATEFORGE_APP_BASE_URL = "http://127.0.0.1:9"; // dummy loopback base (receipt tests never reach the app)
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      const evidence = createEvidence({
        page: dummyPage(),
        testInfo: testInfoOf([{ type: 'gateforge', description: OBLIGATION }]),
      });
      const forged = {
        kind: 'ui',
        operation: 'update',
        resourceId: 'tenant.accounts',
        entityId: 'acc-1',
        fields: { first_name: 'Ada' },
        mode: 'row',
      };
      await expect(
        evidence.visible.confirm(forged as never),
      ).rejects.toThrow(/receipt issued by an evidence\.ui primitive/);
    } finally {
      delete process.env.GATEFORGE_WITNESS_URL;
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects a forged Object.create-branded receipt in persistence.verify', async () => {
    const fixture = await startFixtureWitness();
    try {
      process.env.GATEFORGE_WITNESS_URL = fixture.witness.url;
      process.env.GATEFORGE_APP_BASE_URL = "http://127.0.0.1:9"; // dummy loopback base (receipt tests never reach the app)
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      const evidence = createEvidence({
        page: dummyPage(),
        testInfo: testInfoOf([{ type: 'gateforge', description: OBLIGATION }]),
      });
      // A real-shape receipt whose OWN brand was given via __proto__ is
      // still rejected: the own-property check must not be spoofable by
      // prototype inheritance (spike README §spoofability).
      const forged = Object.create({
        kind: 'ui',
        operation: 'update',
        resourceId: 'tenant.accounts',
        entityId: 'acc-1',
        fields: {},
        mode: 'row',
      });
      await expect(
        evidence.persistence.verify(forged as never),
      ).rejects.toThrow(/receipt issued by an evidence\.ui primitive/);
    } finally {
      delete process.env.GATEFORGE_WITNESS_URL;
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('a forged receipt produces zero witness records (never satisfied)', async () => {
    const fixture = await startFixtureWitness();
    try {
      process.env.GATEFORGE_WITNESS_URL = fixture.witness.url;
      process.env.GATEFORGE_APP_BASE_URL = "http://127.0.0.1:9"; // dummy loopback base (receipt tests never reach the app)
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      const evidence = createEvidence({
        page: dummyPage(),
        testInfo: testInfoOf([{ type: 'gateforge', description: OBLIGATION }]),
      });
      const forged = {
        kind: 'ui',
        operation: 'update',
        resourceId: 'tenant.accounts',
        entityId: 'acc-1',
        fields: {},
        mode: 'row',
      };
      await evidence.visible.confirm(forged as never).catch(() => undefined);
      await evidence.persistence.verify(forged as never).catch(() => undefined);
      const ledger = (await (
        await fetch(`${fixture.witness.url}/records`, {
          headers: { 'x-gateforge-run': TOKEN },
        })
      ).json()) as { records: unknown[] };
      expect(ledger.records).toHaveLength(0);
    } finally {
      delete process.env.GATEFORGE_WITNESS_URL;
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('finalize fail-fast', () => {
  it('throws when a claim produced zero records (gate would grade missing)', async () => {
    const fixture = await startFixtureWitness();
    try {
      process.env.GATEFORGE_WITNESS_URL = fixture.witness.url;
      process.env.GATEFORGE_APP_BASE_URL = "http://127.0.0.1:9"; // dummy loopback base (receipt tests never reach the app)
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      const evidence = createEvidence({
        page: dummyPage(),
        testInfo: testInfoOf([{ type: 'gateforge', description: OBLIGATION }]),
      });
      await expect(evidence.finalize()).rejects.toThrow(/produced no witness records/);
    } finally {
      delete process.env.GATEFORGE_WITNESS_URL;
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('witness URL resolution falls back to the state-dir file', async () => {
    const fixture = await startFixtureWitness();
    try {
      delete process.env.GATEFORGE_WITNESS_URL;
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join: joinPath } = await import('node:path');
      const stateDir = joinPath(fixture.project, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        joinPath(stateDir, 'witness-url.json'),
        `${JSON.stringify({ url: fixture.witness.url })}\n`,
      );
      process.env.GATEFORGE_STATE_DIR = stateDir;
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      const client = new WitnessClient();
      const ledger = await client.listRecords();
      expect(ledger.records).toEqual([]);
      delete process.env.GATEFORGE_STATE_DIR;
    } finally {
      delete process.env.GATEFORGE_WITNESS_URL;
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

void resolveWitnessUrl;