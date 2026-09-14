/**
 * Fixture-surface tests (invariant 6, GF-22, GF-24 left side; Phase 1
 * generic surface + session binding):
 *
 * - the evidence object is FROZEN and exposes EXACTLY
 *   ui/visible/persistence/http/finalize (no `prove` escape hatch);
 * - the consumer-declared `surface` descriptor is REQUIRED: the old
 *   no-argument (Accounts-specific) shape throws a precise migration
 *   error, and a wrong schemaVersion fails closed;
 * - construction fails closed when no supervisor-opened session exists;
 * - forged receipts (hand-rolled or Object.create-branded) are
 *   rejected by `visible.confirm`/`persistence.verify` BEFORE any page
 *   or witness interaction (GF-22);
 * - `finalize()` fails fast when a claim produced zero records (the
 *   gate would grade it missing);
 * - the fixture requires a gateforge claim annotation OR
 *   supervisor-registered (mapped) session claims: an annotation-less
 *   helper-based journey whose session was opened with the sidecar
 *   claims (Phase 4 claim injection, plan E02) routes its evidence onto
 *   those claims; with neither, construction fails closed.
 */
import { describe, expect, it } from 'vitest';
import type { Page, TestInfo } from 'playwright/test';
import { createEvidence, SURFACE_DESCRIPTOR_VERSION, type SurfaceDescriptor } from '../src/fixture/evidence.js';
import { WitnessClient, resolveWitnessUrl } from '../src/fixture/witness-client.js';
import { startWitness } from '../src/witness/server.js';
import { startMarkerServer } from './marker-server.js';
import {
  makeTempProject,
  writeFixtureProject,
  writeHonestAdapter,
  openSupervisorSession,
  FINGERPRINT,
} from './helpers.js';
import { join } from 'node:path';

const RUN_ID = '6f1c3f90-2d5e-4b1a-9c6d-0f0e2b8a1c9d';
const TOKEN = 'fixture-token';
// The supervisor capability (enforcement-review fix 3): session open/close
// is verifier-key authenticated; tests acting as the supervisor present it.
const VERIFIER_KEY = 'fixture-verifier-secret';
const OBLIGATION = 'tenant.accounts:persistence:update';

/**
 * A consumer-shaped surface descriptor for the unit tests. Selectors are
 * deliberately GENERIC placeholders (the dummy page is never driven) —
 * the point is the contract shape, not any application.
 */
const PLACEHOLDER_SURFACE: SurfaceDescriptor = {
  schemaVersion: SURFACE_DESCRIPTOR_VERSION,
  list: {
    path: '/list',
    readySelector: 'h1:has-text("List")',
    rowSelector: 'tbody tr',
    idCellIndex: 0,
    fieldCellIndexes: { field_a: 1, field_b: 2, status: 3 },
  },
  create: {
    formPath: '/list/new',
    formReadySelector: 'form[action="/list"]',
    fields: { field_a: 'input[name="field_a"]', field_b: 'input[name="field_b"]' },
    submitSelector: 'button[type="submit"]',
  },
  edit: {
    linkSelector: 'a[href$="/edit"]',
    formReadySelectorTemplate: 'form[action="/list/{id}"]',
    fields: { field_a: 'input[name="field_a"]', field_b: 'input[name="field_b"]' },
    saveSelectorTemplate: 'form[action="/list/{id}"] button:not([formaction])',
  },
  archive: { controlSelectorTemplate: 'form[action="/list/{id}/archive"] button' },
  status: { field: 'status', createdValue: 'active', archivedValue: 'archived' },
  afterAction: { path: '/list' },
  deleteFields: { status: 'archived' },
};

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
    workerIndex: 0,
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
    verifierKey: VERIFIER_KEY,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
    targetBaseUrl: target.url,
    targetFingerprint: FINGERPRINT,
    adapterBaseUrl: target.url,
    now: () => '2026-08-30T12:00:01.000Z',
  });
  return { witness, target, project };
}

interface FixtureOptions {
  surface?: SurfaceDescriptor;
  annotations?: Array<{ type: string; description: string }>;
  sessionTestId?: string;
}

/** Builds the evidence API the way the tests need: supervisor session + surface. */
async function buildEvidence(
  witnessUrl: string,
  options: FixtureOptions = {},
) {
  const testId = options.sessionTestId ?? 'fixture-test-id-1';
  const session = await openSupervisorSession(witnessUrl, TOKEN, testId, 0, VERIFIER_KEY);
  return createEvidence({
    page: dummyPage(),
    testInfo: testInfoOf(options.annotations ?? [{ type: 'gateforge', description: OBLIGATION }]),
    surface: options.surface ?? PLACEHOLDER_SURFACE,
    // Deterministic loopback stand-ins: the dummy page is never driven,
    // and the witness transport is bound explicitly (no env leakage).
    client: new WitnessClient(witnessUrl, TOKEN),
    session: {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      testId: session.testId,
      workerIndex: session.workerIndex,
      proxyUrl: session.proxyUrl,
    },
  });
}

describe('frozen surface, no escape hatch (invariant 6, GF-11)', () => {
  it('exposes exactly ui/visible/persistence/finalize and is frozen', async () => {
    const fixture = await startFixtureWitness();
    try {
      const evidence = await buildEvidence(fixture.witness.url);
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
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('requires a gateforge claim annotation (defense in depth for GF-24)', async () => {
    const fixture = await startFixtureWitness();
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, 'fixture-test-id-1', 0, VERIFIER_KEY);
      await expect(
        createEvidence({
          page: dummyPage(),
          testInfo: testInfoOf([]),
          surface: PLACEHOLDER_SURFACE,
          session: { ...session },
        }),
      ).rejects.toThrow(/declares no 'gateforge' annotation/);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('routes an annotation-less journey onto its supervisor-registered session claims (plan E02)', async () => {
    const fixture = await startFixtureWitness();
    try {
      // The supervisor (orchestrating CLI → drain) opened the session
      // carrying the sidecar-resolved claims; the worker test itself has
      // NO gateforge annotation — the helper-based E02 shape.
      const session = await openSupervisorSession(
        fixture.witness.url,
        TOKEN,
        'fixture-test-id-1',
        0,
        VERIFIER_KEY,
        ['tenant.accounts:crud:create', 'tenant.accounts:crud:delete'],
      );
      const evidence = await createEvidence({
        page: dummyPage(),
        testInfo: testInfoOf([]),
        surface: PLACEHOLDER_SURFACE,
        client: new WitnessClient(fixture.witness.url, TOKEN),
        session: { ...session },
      });
      // The injected claims are the effective claim set: finalize's
      // fail-fast names the MAPPED claim (never annotated on the test)
      // when it has no records — construction succeeded and the claims
      // route evidence, but nothing can fabricate records for them.
      await expect(evidence.finalize()).rejects.toThrow(
        /claim 'tenant\.accounts:crud:create' produced no witness records/,
      );
      const ledger = (await (
        await fetch(`${fixture.witness.url}/records`, { headers: { 'x-gateforge-run': TOKEN } })
      ).json()) as { records: unknown[] };
      expect(ledger.records).toHaveLength(0);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('versioned surface descriptor (plan Phase 1 item 7)', () => {
  it('throws the migration error naming the new required parameter when surface is omitted', async () => {
    const fixture = await startFixtureWitness();
    try {
      await expect(
        createEvidence({ page: dummyPage(), testInfo: testInfoOf([{ type: 'gateforge', description: OBLIGATION }]) }),
      ).rejects.toThrow(/requires a consumer-declared 'surface' descriptor/);
      // No silent fallback to the removed Accounts behavior: no session
      // existed and none was needed — the surface check fires first.
      const ledger = (await (
        await fetch(`${fixture.witness.url}/records`, { headers: { 'x-gateforge-run': TOKEN } })
      ).json()) as { records: unknown[] };
      expect(ledger.records).toHaveLength(0);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('fails closed on an unsupported surface schemaVersion', async () => {
    const fixture = await startFixtureWitness();
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, 'fixture-test-id-1', 0, VERIFIER_KEY);
      await expect(
        createEvidence({
          page: dummyPage(),
          testInfo: testInfoOf([{ type: 'gateforge', description: OBLIGATION }]),
          surface: { ...PLACEHOLDER_SURFACE, schemaVersion: SURFACE_DESCRIPTOR_VERSION + 1 },
          session: { ...session },
        }),
      ).rejects.toThrow(/surface.schemaVersion .* is not supported/);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('supervisor-issued session binding (plan Phase 1 item 1)', () => {
  it('fails closed when no open session exists for the test', async () => {
    const fixture = await startFixtureWitness();
    try {
      process.env.GATEFORGE_WITNESS_URL = fixture.witness.url;
      process.env.GATEFORGE_APP_BASE_URL = 'http://127.0.0.1:9';
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      try {
        // No supervisor session opened: the bounded resolve must fail
        // closed with the actionable error (never mint a credential).
        await expect(
          createEvidence({
            page: dummyPage(),
            testInfo: testInfoOf([{ type: 'gateforge', description: OBLIGATION }]),
            surface: PLACEHOLDER_SURFACE,
            sessionResolveTimeoutMs: 250,
          }),
        ).rejects.toThrow(/no open witness session/);
      } finally {
        delete process.env.GATEFORGE_WITNESS_URL;
        delete process.env.GATEFORGE_APP_BASE_URL;
      }
    } finally {
      delete process.env.GATEFORGE_WITNESS_URL;
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('refuses a session credential bound to another test id', async () => {
    const fixture = await startFixtureWitness();
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, 'another-test', 0, VERIFIER_KEY);
      await expect(
        createEvidence({
          page: dummyPage(),
          testInfo: testInfoOf([{ type: 'gateforge', description: OBLIGATION }]),
          surface: PLACEHOLDER_SURFACE,
                client: new WitnessClient(fixture.witness.url, TOKEN),
          session: { ...session },
        }),
      ).rejects.toThrow(/binds testId 'another-test' but this test is 'fixture-test-id-1'/);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('receipt brands (GF-22)', () => {
  it('rejects a hand-rolled receipt in visible.confirm', async () => {
    const fixture = await startFixtureWitness();
    try {
      const evidence = await buildEvidence(fixture.witness.url);
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
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects a forged Object.create-branded receipt in persistence.verify', async () => {
    const fixture = await startFixtureWitness();
    try {
      const evidence = await buildEvidence(fixture.witness.url);
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
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('a forged receipt produces zero witness records (never satisfied)', async () => {
    const fixture = await startFixtureWitness();
    try {
      const evidence = await buildEvidence(fixture.witness.url);
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
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('finalize fail-fast', () => {
  it('throws when a claim produced zero records (gate would grade missing)', async () => {
    const fixture = await startFixtureWitness();
    try {
      const evidence = await buildEvidence(fixture.witness.url);
      await expect(evidence.finalize()).rejects.toThrow(/produced no witness records/);
    } finally {
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
