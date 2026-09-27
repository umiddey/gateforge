/**
 * Engine-owned browser tests (playwright-evidence class, plan Phase 1
 * item 4): the witness drives its OWN Chromium against the real example
 * app through the attestation proxy. Every proof is engine-observed —
 * worker pages, mocks, and direct API calls cannot substitute.
 *
 * Positive: a full engine create binds the rendered control + entered
 * values, the actual action, the captured application request + entity
 * identity, the visible outcome, and persistence echo — and the real
 * `crud:create` verifier returns satisfied.
 *
 * Negatives (each must block):
 * - API mutation + invented suite-submitted UI records → invalid
 *   (claimed-tier UI records never satisfy browser contracts).
 * - API mutation hidden in a helper + unrelated worker clicks → missing
 *   (no engine action ran).
 * - worker-page fabricated DOM → engine unaffected (own page).
 * - worker-page mocked responses → engine unaffected (own traffic).
 * - application error status / already-archived control → 409, no records.
 * - borrowed evidence across sessions → invalid/missing (session binding).
 * - unregistered surface / suite-supplied origins / sealed session → 409/400.
 * - P1 fake frontend (test-named UI origin replaying the real API) →
 *   origin rejected (400), engine drives the trusted subject and fails
 *   closed on the UI-less API (409), crud:create missing.
 * - hostile redirect off the trusted origin → 409, no records.
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { ObligationSchema, evaluateObligation, fingerprint } from '@gate-forge/core';
import { driveEngineAction } from '../src/witness/browser.js';
import { SURFACE_DESCRIPTOR_VERSION, type SurfaceDescriptor } from '../src/surface.js';
import { startWitness } from '../src/witness/server.js';
import { SupervisorClient } from '../src/supervisor/client.js';
import {
  FINGERPRINT,
  makeTempProject,
  removeTempProject,
  startExampleApp,
  writeFixtureProject,
  writeHonestAdapter,
} from './helpers.js';
import { startAttestationProxy } from '../src/attestation/proxy.js';
import { ROOT } from './helpers.js';

const TOKEN = 'browser-engine-token';
const VERIFIER_KEY = 'browser-engine-verifier';
const CLAIM = 'tenant.accounts:crud:create';
const UPDATE_CLAIM = 'tenant.accounts:crud:update';
const RESOURCE = 'tenant.accounts';

const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'archive' as const,
  archiveFields: { status: 'archived' },
  updateableFields: ['first_name', 'last_name', 'status'],
};

const HTTP_ROUTES = [
  { resourceId: 'http.endpoint:POST /accounts', method: 'POST', canonicalPath: '/accounts' },
  { resourceId: 'http.endpoint:POST /accounts/{}', method: 'POST', canonicalPath: '/accounts/{}' },
  {
    resourceId: 'http.endpoint:POST /accounts/{}/archive',
    method: 'POST',
    canonicalPath: '/accounts/{}/archive',
  },
];

async function loadSurface(): Promise<Record<string, unknown>> {
  const module = (await import(
    pathToFileURL(join(ROOT, 'example/e2e/accounts-surface.js')).href
  )) as { accountsSurface: Record<string, unknown> };
  return module.accountsSurface;
}

interface Scaffold {
  project: string;
  witnessUrl: string;
  proxyUrl: string;
  token: string;
  verifierKey: string;
  session: { sessionId: string; sessionToken: string; testId: string };
  surface: Record<string, unknown>;
  dispose: () => Promise<void>;
}

/**
 * Starts a disposable witness, proxy, and engine browser around a local app.
 *
 * Args:
 *   testId: the supervisor-bound test id.
 *   targetApp: an optional app for a focused consumer-shaped E2E.
 *   adapterFields: optional adapter projection; omitted for legacy-compatible fixtures.
 *
 * Returns:
 *   Promise<Scaffold>: the temporary project and trusted test session.
 */
async function scaffold(
  testId = 'engine-create-test',
  targetApp?: { url: string; stop: () => void },
  adapterFields?: readonly string[],
): Promise<Scaffold> {
  const project = makeTempProject('browser-engine');
  writeFixtureProject(project);
  writeHonestAdapter(project, FINGERPRINT, adapterFields);
  const app = targetApp ?? (await startExampleApp());
  const proxy = await startAttestationProxy(app.url, FINGERPRINT);
  const runId = `browser-engine-${Math.random().toString(36).slice(2)}`;
  const witness = await startWitness({
    runId,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
    targetBaseUrl: proxy.url,
    targetFingerprint: FINGERPRINT,
    adapterBaseUrl: proxy.url,
    host: '127.0.0.1',
  });
  const supervisor = new SupervisorClient(witness.url, TOKEN, VERIFIER_KEY);
  const session = await supervisor.openSession({ testId, workerIndex: 0 });
  const surface = await loadSurface();
  return {
    project,
    witnessUrl: witness.url,
    proxyUrl: proxy.url,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    session: { sessionId: session.sessionId, sessionToken: session.sessionToken, testId },
    surface,
    dispose: async () => {
      await witness.stop();
      await proxy.stop();
      app.stop();
      removeTempProject(project);
    },
  };
}

async function post(
  scaffold: Pick<Scaffold, 'witnessUrl' | 'token'>,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${scaffold.witnessUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateforge-run': scaffold.token },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function obligation(): Record<string, unknown> {
  return ObligationSchema.parse({
    schemaVersion: 1,
    id: CLAIM,
    resourceId: RESOURCE,
    contract: 'crud:create',
    policyId: 'crud',
    lifecycle: LIFECYCLE,
  }) as unknown as Record<string, unknown>;
}

function classification(): Record<string, unknown> {
  return {
    exposure: 'user-facing',
    plane: 'tenant',
    lifecycle: LIFECYCLE,
    primaryKey: ['id'],
    evidenceAdapter: 'tenant.accounts',
  };
}

/** Grades one claim over ledger records through the REAL verdict engine. */
function gradeClaim(
  testId: string,
  records: Array<{ kind: string; trust: string; origin: string; obligationId: string; testId: string; payload: unknown; recordId: string }>,
): { verdict: string; reason: string | null } {
  const outcome = evaluateObligation(obligation() as never, {
    claims: [{ schemaVersion: 1, obligationId: CLAIM, testId }],
    records,
    waivers: [],
    classification: classification(),
    httpRoutes: HTTP_ROUTES,
    now: new Date().toISOString(),
  });
  return { verdict: outcome.verdict, reason: outcome.reason };
}

async function ledgerRecords(scaffold: Pick<Scaffold, 'witnessUrl' | 'token'>): Promise<Array<{ kind: string; trust: string; origin: string; obligationId: string; testId: string; payload: unknown; recordId: string }>> {
  const response = await fetch(`${scaffold.witnessUrl}/records`, {
    headers: { 'x-gateforge-run': scaffold.token },
  });
  const body = (await response.json()) as { records: Array<{ kind: string; trust: string; origin: string; obligationId: string; testId: string; payload: unknown; recordId: string }> };
  return body.records;
}

describe('engine-owned browser (projection guard and positive evidence)', () => {
  it('rejects persistence when the action field is absent from the adapter projection', async () => {
    const app = await startExampleApp();
    let scope: Scaffold | null = null;
    try {
      const created = await fetch(`${app.url}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ first_name: 'Ada', last_name: 'Lovelace' }),
        redirect: 'manual',
      });
      expect(created.status).toBe(303);
      const listed = await fetch(`${app.url}/api/accounts`);
      const accounts = (await listed.json()) as { accounts: Array<{ id: string }> };
      const entityId = accounts.accounts[0]?.id;
      expect(entityId).toBeTruthy();

      scope = await scaffold('missing-adapter-field-test', app, ['first_name', 'status']);
      const channel = {
        sessionId: scope.session.sessionId,
        sessionToken: scope.session.sessionToken,
        testId: scope.session.testId,
      };
      const registered = await post(scope, '/browser/surface', {
        ...channel,
        surface: scope.surface,
      });
      expect(registered.status, JSON.stringify(registered.json)).toBe(200);
      const action = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [UPDATE_CLAIM],
        operation: 'update',
        entityId,
        fields: { last_name: 'Byron' },
      });
      expect(action.status, JSON.stringify(action.json)).toBe(200);
      const actionBody = action.json as Record<string, unknown>;
      const persistenceRequest = {
        ...channel,
        resourceId: RESOURCE,
        entityId,
        claimId: UPDATE_CLAIM,
        preObservationId: actionBody['preObservationId'],
        anchorId: actionBody['anchorId'],
      };
      const persistence = await post(scope, '/witness/persistence', persistenceRequest);
      expect(persistence.status).toBe(409);
      expect((persistence.json as Record<string, unknown>)['error']).toContain('last_name');

      // A second identical request proves the rejection did not consume the one-use pre-observation.
      const sameAnchorAgain = await post(scope, '/witness/persistence', persistenceRequest);
      expect(sameAnchorAgain.status).toBe(409);
      expect((sameAnchorAgain.json as Record<string, unknown>)['error']).toContain('last_name');
    } finally {
      if (scope !== null) await scope.dispose();
      else app.stop();
    }
  });
  it('an engine create satisfies crud:create through the real verifier', async () => {
    const scope = await scaffold();
    try {
      const channel = {
        sessionId: scope.session.sessionId,
        sessionToken: scope.session.sessionToken,
        testId: scope.session.testId,
      };
      const registered = await post(scope, '/browser/surface', {
        ...channel,
        surface: scope.surface,
      });
      expect(registered.status).toBe(200);
      const action = (await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'create',
        fields: { first_name: 'Ada', last_name: 'Lovelace' },
      })) as { status: number; json: Record<string, unknown> };
      expect(action.status, JSON.stringify(action.json)).toBe(200);
      const entityId = action.json['entityId'] as string;
      expect(entityId).toMatch(/^acc-/);
      expect(action.json['enteredFields']).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });
      // The rendered readback echoes the entered values exactly.
      expect(action.json['renderedFields']).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
      const preObservationId = action.json['preObservationId'] as string;
      const anchorId = action.json['anchorId'] as string;
      expect(anchorId).toBeTruthy();
      expect(typeof preObservationId).toBe('string');
      const visible = (await post(scope, '/browser/visible', {
        ...channel,
        claimIds: [CLAIM],
        entityId,
        operation: 'create',
        anchorId,
      })) as { status: number; json: Record<string, unknown> };
      expect(visible.status).toBe(200);
      expect(visible.json['fields']).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
      // The engine-captured application request is consumable.
      const observed = await post(scope, '/witness/http-observation', {
        ...channel,
        claimIds: [CLAIM],
        method: 'POST',
        path: '/accounts',
      });
      expect(observed.status, JSON.stringify(observed.json)).toBe(200);
      // Independent persistence echo on the SAME entity.
      const persisted = await post(scope, '/witness/persistence', {
        ...channel,
        resourceId: RESOURCE,
        entityId,
        claimId: CLAIM,
        preObservationId,
        anchorId,
      });
      expect(persisted.status, JSON.stringify(persisted.json)).toBe(200);
      // The REAL crud:create verifier is satisfied by engine evidence.
      const records = await ledgerRecords(scope);
      const kinds = records.map((record) => `${record.kind}:${record.trust}:${record.origin}`).sort();
      expect(kinds).toContain('ui.action:witnessed:engine-observed');
      expect(kinds).toContain('ui.visible-result:witnessed:engine-observed');
      expect(kinds).toContain('http.request:witnessed:engine-observed');
      expect(kinds).toContain('persistence.entity:witnessed:engine-observed');
      const outcome = gradeClaim(scope.session.testId, records);
      expect(outcome.verdict).toBe('satisfied');
    } finally {
      await scope.dispose();
    }
  });

  it('surface v3 records create, read, update, and archive on cards with no td elements', async () => {
    let saved: { id: string; first_name: string; last_name: string; status: string } | null = null;
    const app: Server = createServer(async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const sendJson = (body: unknown, status = 200): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && pathname === '/api/accounts') {
        sendJson({ accounts: saved === null ? [] : [saved] });
        return;
      }
      const apiAccount = /^\/api\/accounts\/([^/]+)$/.exec(pathname);
      if (req.method === 'GET' && apiAccount !== null) {
        if (saved === null || saved.id !== apiAccount[1]) sendJson({ error: 'not found' }, 404);
        else sendJson(saved);
        return;
      }
      if (req.method === 'GET' && pathname === '/accounts/new') {
        res.setHeader('content-type', 'text/html');
        res.end(
          '<form action="/accounts" method="post">' +
            '<input name="first_name"><input name="last_name"><button type="submit">Save</button></form>',
        );
        return;
      }
      if (req.method === 'POST' && pathname === '/accounts') {
        let body = '';
        for await (const chunk of req) body += chunk.toString();
        const fields = new URLSearchParams(body);
        saved = {
          id: 'account-1',
          first_name: fields.get('first_name') ?? '',
          last_name: fields.get('last_name') ?? '',
          status: 'active',
        };
        res.writeHead(303, { location: '/accounts' });
        res.end();
        return;
      }
      const editMatch = /^\/accounts\/([^/]+)\/edit$/.exec(pathname);
      if (req.method === 'GET' && editMatch !== null && saved !== null) {
        res.setHeader('content-type', 'text/html');
        res.end(
          `<form action="/accounts/${editMatch[1]}" method="post">` +
            `<input name="first_name" value="${saved.first_name}">` +
            `<input name="last_name" value="${saved.last_name}">` +
            '<button type="submit">Save</button></form>',
        );
        return;
      }
      const updateMatch = /^\/accounts\/([^/]+)$/.exec(pathname);
      if (req.method === 'POST' && updateMatch !== null && saved !== null) {
        let body = '';
        for await (const chunk of req) body += chunk.toString();
        const fields = new URLSearchParams(body);
        saved = {
          ...saved,
          first_name: fields.get('first_name') ?? saved.first_name,
          last_name: fields.get('last_name') ?? saved.last_name,
        };
        res.writeHead(303, { location: '/accounts' });
        res.end();
        return;
      }
      const archiveMatch = /^\/accounts\/([^/]+)\/archive$/.exec(pathname);
      if (req.method === 'POST' && archiveMatch !== null && saved !== null) {
        saved = { ...saved, status: 'archived' };
        res.writeHead(303, { location: '/accounts' });
        res.end();
        return;
      }
      if (req.method === 'GET' && pathname === '/accounts') {
        res.setHeader('content-type', 'text/html');
        const card = saved === null
          ? ''
          : `<article class="account-card"><span class="account-id">${saved.id}</span>` +
            `<span class="first-name">${saved.first_name}</span>` +
            `<span class="last-name">${saved.last_name}</span>` +
            `<span class="status">${saved.status}</span>` +
            `<a class="edit" href="/accounts/${saved.id}/edit">Edit</a>` +
            `<form action="/accounts/${saved.id}/archive" method="post">` +
            `<button type="submit" data-archive="${saved.id}">Archive</button></form></article>`;
        res.end(`<h1>Accounts</h1>${card}`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('no card app port');
    const appBase = `http://127.0.0.1:${address.port}`;
    let scope: Scaffold | null = null;
    const surface: SurfaceDescriptor = {
      schemaVersion: SURFACE_DESCRIPTOR_VERSION,
      list: {
        path: '/accounts',
        readySelector: 'h1',
        rowSelector: '.account-card',
        idLocator: '.account-id',
        fieldLocators: { first_name: '.first-name', last_name: '.last-name', status: '.status' },
      },
      create: {
        formPath: '/accounts/new',
        formReadySelector: 'form',
        fields: { first_name: 'input[name="first_name"]', last_name: 'input[name="last_name"]' },
        submitSelector: 'button[type="submit"]',
      },
      edit: {
        linkSelector: 'a.edit',
        formReadySelectorTemplate: 'form[action="/accounts/{id}"]',
        fields: { first_name: 'input[name="first_name"]', last_name: 'input[name="last_name"]' },
        saveSelectorTemplate: 'form[action="/accounts/{id}"] button',
      },
      archive: { controlSelectorTemplate: 'button[data-archive="{id}"]' },
      status: { field: 'status', createdValue: 'active', archivedValue: 'archived' },
      afterAction: { path: '/accounts' },
      deleteFields: { status: 'archived' },
    };
    try {
      scope = await scaffold('surface-v3-card', { url: appBase, stop: () => undefined });
      const channel = {
        sessionId: scope.session.sessionId,
        sessionToken: scope.session.sessionToken,
        testId: scope.session.testId,
      };
      const registered = await post(scope, '/browser/surface', { ...channel, surface });
      expect(registered.status, JSON.stringify(registered.json)).toBe(200);
      const created = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'create',
        fields: { first_name: 'Ada', last_name: 'Lovelace' },
      });
      const createdBody = created.json as Record<string, unknown>;
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      expect(createdBody).toMatchObject({
        entityId: 'account-1',
        enteredFields: { first_name: 'Ada', last_name: 'Lovelace' },
        renderedFields: { first_name: 'Ada', last_name: 'Lovelace', status: 'active' },
      });
      const entityId = createdBody['entityId'] as string;
      const createdVisible = await post(scope, '/browser/visible', {
        ...channel,
        claimIds: [CLAIM],
        entityId,
        anchorId: createdBody['anchorId'],
        operation: 'create',
      });
      expect(createdVisible.status, JSON.stringify(createdVisible.json)).toBe(200);
      expect(createdVisible.json).toMatchObject({ fields: { first_name: 'Ada', last_name: 'Lovelace', status: 'active' } });
      const httpEvidence = await post(scope, '/witness/http-observation', {
        ...channel,
        claimIds: [CLAIM],
        method: 'POST',
        path: '/accounts',
      });
      expect(httpEvidence.status, JSON.stringify(httpEvidence.json)).toBe(200);
      const persistence = await post(scope, '/witness/persistence', {
        ...channel,
        resourceId: RESOURCE,
        entityId,
        claimId: CLAIM,
        preObservationId: createdBody['preObservationId'],
        anchorId: createdBody['anchorId'],
      });
      expect(persistence.status, JSON.stringify(persistence.json)).toBe(200);

      const read = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'read',
        entityId,
      });
      expect(read.status, JSON.stringify(read.json)).toBe(200);
      expect(read.json).toMatchObject({ renderedFields: { first_name: 'Ada', last_name: 'Lovelace' } });
      const update = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'update',
        entityId,
        fields: { first_name: 'Ada', last_name: 'Byron' },
      });
      expect(update.status, JSON.stringify(update.json)).toBe(200);
      expect(update.json).toMatchObject({ renderedFields: { first_name: 'Ada', last_name: 'Byron', status: 'active' } });
      const firstUpdateBody = update.json as Record<string, unknown>;
      const firstUpdateAnchorId = firstUpdateBody['anchorId'] as string;
      const firstUpdatePersistence = await post(scope, '/witness/persistence', {
        ...channel,
        resourceId: RESOURCE,
        entityId,
        claimId: CLAIM,
        preObservationId: firstUpdateBody['preObservationId'],
        anchorId: firstUpdateAnchorId,
      });
      expect(firstUpdatePersistence.status, JSON.stringify(firstUpdatePersistence.json)).toBe(200);
      const secondUpdate = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'update',
        entityId,
        fields: { first_name: 'Ada', last_name: 'Shelley' },
      });
      expect(secondUpdate.status, JSON.stringify(secondUpdate.json)).toBe(200);
      const secondUpdateBody = secondUpdate.json as Record<string, unknown>;
      const secondUpdateAnchorId = secondUpdateBody['anchorId'] as string;
      const delayedPersistence = await post(scope, '/witness/persistence', {
        ...channel,
        resourceId: RESOURCE,
        entityId,
        claimId: CLAIM,
        preObservationId: firstUpdateBody['preObservationId'],
        anchorId: firstUpdateAnchorId,
      });
      expect(delayedPersistence.status).toBe(409);
      expect((delayedPersistence.json as Record<string, unknown>)['error']).toContain(
        'before another UI action on the same entity',
      );
      const secondUpdatePersistence = await post(scope, '/witness/persistence', {
        ...channel,
        resourceId: RESOURCE,
        entityId,
        claimId: CLAIM,
        preObservationId: secondUpdateBody['preObservationId'],
        anchorId: secondUpdateAnchorId,
      });
      expect(secondUpdatePersistence.status, JSON.stringify(secondUpdatePersistence.json)).toBe(200);
      const archive = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'delete',
        entityId,
      });
      expect(archive.status, JSON.stringify(archive.json)).toBe(200);
      expect(archive.json).toMatchObject({ renderedFields: { first_name: 'Ada', last_name: 'Shelley', status: 'archived' } });
      const visibleArchive = await post(scope, '/browser/visible', {
        ...channel,
        claimIds: [CLAIM],
        entityId,
        operation: 'delete',
        anchorId: (archive.json as Record<string, unknown>)['anchorId'],
      });
      expect(visibleArchive.status, JSON.stringify(visibleArchive.json)).toBe(200);
      expect(visibleArchive.json).toMatchObject({ fields: { status: 'archived' } });
      const records = await ledgerRecords(scope);
      const actions = records.filter((record) => record.kind === 'ui.action');
      expect(actions.map((record) => (record.payload as { operation: string }).operation).sort()).toEqual([
        'create',
        'delete',
        'read',
        'update',
        'update',
      ]);
      expect(actions.every((record) => record.origin === 'engine-observed')).toBe(true);
      const firstPersistenceRecord = (firstUpdatePersistence.json as Record<string, unknown>)['recordId'];
      const secondPersistenceRecord = (secondUpdatePersistence.json as Record<string, unknown>)['recordId'];
      expect(records).toContainEqual(
        expect.objectContaining({
          recordId: firstPersistenceRecord,
          payload: expect.objectContaining({
            anchorId: firstUpdateAnchorId,
            fields: expect.objectContaining({ last_name: 'Byron' }),
          }),
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          recordId: secondPersistenceRecord,
          payload: expect.objectContaining({
            anchorId: secondUpdateAnchorId,
            fields: expect.objectContaining({ last_name: 'Shelley' }),
          }),
        }),
      );
    } finally {
      if (scope !== null) await scope.dispose();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }
  });
});

describe('engine-owned browser (negatives: forgeries block)', () => {
  it('API mutation + invented suite-submitted UI records → invalid, never satisfied', async () => {
    const scope = await scaffold('api-plus-invented-ui');
    try {
      const channel = {
        sessionId: scope.session.sessionId,
        sessionToken: scope.session.sessionToken,
        testId: scope.session.testId,
      };
      // The real mutation, through the session proxy (attributed exchange).
      const direct = await fetch(`${scope.proxyUrl}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'first_name=API&last_name=Only',
        redirect: 'manual',
      });
      expect(direct.status).toBe(303);
      // Invented UI records through the session credential.
      const inventedAction = await post(scope, '/records', {
        ...channel,
        claimId: CLAIM,
        kind: 'ui.action',
        payload: { operation: 'create', entityId: 'acc-1', fields: { first_name: 'API' } },
      });
      expect(inventedAction.status).toBe(200);
      const inventedVisible = await post(scope, '/records', {
        ...channel,
        claimId: CLAIM,
        kind: 'ui.visible-result',
        payload: { entityId: 'acc-1', fields: { first_name: 'API' } },
      });
      expect(inventedVisible.status).toBe(200);
      // Genuine persistence evidence for the API-created entity.
      const before = (await post(scope, '/witness/pre-observation', {
        ...channel,
        resourceId: RESOURCE,
        claimId: CLAIM,
      })) as { json: Record<string, unknown> };
      const persisted = await post(scope, '/witness/persistence', {
        ...channel,
        resourceId: RESOURCE,
        entityId: 'acc-1',
        claimId: CLAIM,
        preObservationId: (before.json as Record<string, unknown>)['observationId'],
      });
      expect(persisted.status).toBe(200);
      const records = await ledgerRecords(scope);
      const outcome = gradeClaim(scope.session.testId, records);
      expect(outcome.verdict).not.toBe('satisfied');
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason ?? '').toMatch(/engine-observed|claimed-tier/i);
    } finally {
      await scope.dispose();
    }
  });

  it('worker-page fabricated DOM does not affect the engine observation', async () => {
    const scope = await scaffold('fabricated-dom');
    try {
      const channel = {
        sessionId: scope.session.sessionId,
        sessionToken: scope.session.sessionToken,
        testId: scope.session.testId,
      };
      // A worker-side page fabricates a perfect fake row. The engine
      // drives its OWN page and must still observe exactly one REAL
      // new entity.
      const browser = await chromium.launch({ headless: true });
      const workerPage = await browser.newPage();
      try {
        // Seed one real entity so the list renders a tbody, then
        // fabricate a perfect fake row beside it.
        await fetch(`${scope.proxyUrl}/accounts`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'first_name=Seed&last_name=Row',
          redirect: 'manual',
        });
        await workerPage.goto(`${scope.proxyUrl}/`);
        await workerPage.evaluate(`(() => {
          const tbody = document.querySelector('tbody');
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td>acc-999</td><td>Fabricated</td><td>Row</td>' +
            '<td><span class="status active">active</span></td><td></td><td></td><td></td>';
          tbody?.appendChild(tr);
        })()`);
        const fakeCount = await workerPage.locator('tbody tr').count();
        expect(fakeCount).toBeGreaterThan(1);
        await post(scope, '/browser/surface', { ...channel, surface: scope.surface });
        const action = (await post(scope, '/browser/action', {
          ...channel,
          claimIds: [CLAIM],
          operation: 'create',
          fields: { first_name: 'Real', last_name: 'Entity' },
        })) as { status: number; json: Record<string, unknown> };
        expect(action.status, JSON.stringify(action.json)).toBe(200);
        expect(action.json['entityId']).not.toBe('acc-999');
      } finally {
        await browser.close();
      }
    } finally {
      await scope.dispose();
    }
  });

  it('worker-page mocked responses do not affect the engine observation', async () => {
    const scope = await scaffold('mocked-responses');
    try {
      const channel = {
        sessionId: scope.session.sessionId,
        sessionToken: scope.session.sessionToken,
        testId: scope.session.testId,
      };
      // A worker-side route mock answers every POST with a forged
      // entity. The engine captures its OWN traffic and persists for
      // real — the mock changes nothing.
      const browser = await chromium.launch({ headless: true });
      const workerPage = await browser.newPage();
      try {
        await workerPage.route('**/accounts', (route) =>
          route.fulfill({ status: 200, body: JSON.stringify({ id: 'acc-mocked' }) }),
        );
        await workerPage.goto(`${scope.proxyUrl}/accounts/new`);
        await post(scope, '/browser/surface', { ...channel, surface: scope.surface });
        const action = (await post(scope, '/browser/action', {
          ...channel,
          claimIds: [CLAIM],
          operation: 'create',
          fields: { first_name: 'Unmocked', last_name: 'Traffic' },
        })) as { status: number; json: Record<string, unknown> };
        expect(action.status, JSON.stringify(action.json)).toBe(200);
        expect(action.json['entityId']).not.toBe('acc-mocked');
        expect(action.json['appStatus']).toBe(303);
      } finally {
        await browser.close();
      }
    } finally {
      await scope.dispose();
    }
  });

  it('archiving twice fails the second action (no archive control renders)', async () => {
    const scope = await scaffold('double-archive');
    try {
      const channel = {
        sessionId: scope.session.sessionId,
        sessionToken: scope.session.sessionToken,
        testId: scope.session.testId,
      };
      await post(scope, '/browser/surface', { ...channel, surface: scope.surface });
      const created = (await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'create',
        fields: { first_name: 'Soon', last_name: 'Archived' },
      })) as { status: number; json: Record<string, unknown> };
      expect(created.status).toBe(200);
      const entityId = created.json['entityId'] as string;
      const archived = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'delete',
        entityId,
      });
      expect(archived.status).toBe(200);
      // The control is gone: the engine fails closed, issuing nothing.
      const again = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'delete',
        entityId,
      });
      expect(again.status).toBe(409);
    } finally {
      await scope.dispose();
    }
  });

  it('borrowed engine evidence from another session cannot satisfy', async () => {
    const scope = await scaffold('session-a');
    const supervisor = new SupervisorClient(scope.witnessUrl, scope.token, scope.verifierKey);
    const sessionB = await supervisor.openSession({ testId: 'session-b', workerIndex: 1 });
    try {
      const channelA = {
        sessionId: scope.session.sessionId,
        sessionToken: scope.session.sessionToken,
        testId: scope.session.testId,
      };
      await post(scope, '/browser/surface', { ...channelA, surface: scope.surface });
      const action = (await post(scope, '/browser/action', {
        ...channelA,
        claimIds: [CLAIM],
        operation: 'create',
        fields: { first_name: 'Mine', last_name: 'NotYours' },
      })) as { status: number; json: Record<string, unknown> };
      expect(action.status).toBe(200);
      // Session B claims the same obligation but ran no engine action:
      // only B's (empty) evidence grades its claim → missing.
      const records = await ledgerRecords(scope);
      const bEvidence = records.filter((record) => record.testId === 'session-b');
      expect(bEvidence).toHaveLength(0);
      const outcome = gradeClaim('session-b', bEvidence);
      expect(outcome.verdict).not.toBe('satisfied');
    } finally {
      await scope.dispose();
    }
  });

  it('an unavailable engine browser fails closed (no Chromium → 409, no records)', async () => {
    // E16: the capability is advertised available, but THIS witness
    // process cannot launch Chromium (injected failing launcher — the
    // production shape is a missing browser executable, which Playwright
    // resolves at import time and therefore cannot be simulated with a
    // late in-process env override). The action fails closed with the
    // precise cause and issues nothing — the gate blocks instead of
    // degrading to suite-submitted proof.
    const project = makeTempProject('browser-engine-nolaunch');
    writeFixtureProject(project);
    writeHonestAdapter(project);
    const app = await startExampleApp();
    const proxy = await startAttestationProxy(app.url, FINGERPRINT);
    const witness = await startWitness({
      runId: 'browser-engine-nolaunch',
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir: join(project, '.gateforge/adapters'),
      classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
      targetBaseUrl: proxy.url,
      targetFingerprint: FINGERPRINT,
      adapterBaseUrl: proxy.url,
      host: '127.0.0.1',
      engineBrowserLauncher: {
        launch: async () => {
          throw new Error("Executable doesn't exist at /nonexistent/chromium");
        },
      },
    });
    try {
      const supervisor = new SupervisorClient(witness.url, TOKEN, VERIFIER_KEY);
      const session = await supervisor.openSession({ testId: 'no-chromium', workerIndex: 0 });
      const channel = { sessionId: session.sessionId, sessionToken: session.sessionToken, testId: 'no-chromium' };
      const surface = await loadSurface();
      const scope = { witnessUrl: witness.url, token: TOKEN };
      await post(scope, '/browser/surface', { ...channel, surface });
      const action = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'create',
        fields: { first_name: 'No', last_name: 'Browser' },
      });
      expect(action.status).toBe(409);
      expect(JSON.stringify(action.json)).toMatch(/cannot launch/i);
      const records = await ledgerRecords(scope);
      expect(records.filter((record) => record.kind === 'ui.action')).toHaveLength(0);
    } finally {
      await witness.stop();
      await proxy.stop();
      app.stop();
      removeTempProject(project);
    }
  });

  it('unregistered surface, suite-supplied origins, and sealed sessions refuse engine calls', async () => {    const scope = await scaffold('surface-guard');
    try {
      const channel = {
        sessionId: scope.session.sessionId,
        sessionToken: scope.session.sessionToken,
        testId: scope.session.testId,
      };
      // No surface registered: the engine drives nothing.
      const noSurface = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'create',
        fields: { first_name: 'No', last_name: 'Surface' },
      });
      expect(noSurface.status).toBe(409);
      // A suite-supplied origin is rejected outright (fake-frontend fix):
      // the driven target comes from trusted configuration only — even a
      // loopback URL with a copied fingerprint header is refused here.
      const namedOrigin = await post(scope, '/browser/surface', {
        ...channel,
        surface: scope.surface,
        appBaseUrl: scope.proxyUrl,
      });
      expect(namedOrigin.status).toBe(400);
      const external = await post(scope, '/browser/surface', {
        ...channel,
        surface: scope.surface,
        appBaseUrl: 'https://example.invalid/',
      });
      expect(external.status).toBe(400);
      // Sealed session: every engine call is refused.
      const supervisor = new SupervisorClient(scope.witnessUrl, scope.token, scope.verifierKey);
      await supervisor.closeSession({ sessionId: scope.session.sessionId, outcome: 'passed' });
      const sealed = await post(scope, '/browser/surface', {
        ...channel,
        surface: scope.surface,
      });
      expect(sealed.status).toBe(409);
    } finally {
      await scope.dispose();
    }
  });

  it('P1 fake frontend: a test-named UI origin cannot earn browser approval', async () => {
    // The review's fake-frontend probe, committed durably: a real JSON
    // API with NO UI on one port, and a fake HTML frontend on another
    // port that copies the fingerprint header, replays the real API via
    // direct Node requests, and displays matching rows. The witness
    // adapter stays bound to the real API; the attested subject IS the
    // real API base.
    //
    // Before the fix, registering the fake as `appBaseUrl` made the
    // engine type/click the fake form and the verifier returned
    // satisfied. After the fix the origin is never negotiable: naming
    // the fake is rejected (400), and the engine drives the trusted
    // subject — a UI-less JSON API — where the action fails closed
    // (409) with zero records, so crud:create stays missing.
    const { createServer } = await import('node:http');
    const fields = { first_name: 'API-only', status: 'active' };
    let stored: Record<string, unknown> | null = null;
    const api = createServer(async (req, res) => {
      res.setHeader('x-gateforge-env-fingerprint', FINGERPRINT);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') {
        for await (const _chunk of req) { /* drain */ }
        stored = { id: 'acc-1', ...fields };
      }
      if (req.url === '/api/accounts') res.end(JSON.stringify({ accounts: stored !== null ? [stored] : [] }));
      else if (stored !== null) res.end(JSON.stringify(stored));
      else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${String((api.address() as { port: number }).port)}`;
    const fake = createServer(async (req, res) => {
      // The copied fingerprint header: proves header-copying is not identity.
      res.setHeader('x-gateforge-env-fingerprint', FINGERPRINT);
      if (req.method === 'POST') {
        for await (const _chunk of req) { /* drain */ }
        await fetch(`${apiBase}/accounts`, { method: 'POST', body: '{}' });
        res.writeHead(303, { location: '/' });
        res.end();
        return;
      }
      res.setHeader('content-type', 'text/html');
      if (req.url === '/accounts/new') {
        res.end(
          '<form action="/accounts" method="post"><input name="first_name">' +
            '<input name="status"><button type="submit">Save</button></form>',
        );
      } else {
        res.end(
          '<h1>Accounts</h1><table><tbody>' +
            (stored !== null ? '<tr><td>acc-1</td><td>API-only</td><td>active</td></tr>' : '') +
            '</tbody></table>',
        );
      }
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const fakeBase = `http://127.0.0.1:${String((fake.address() as { port: number }).port)}`;
    expect(new URL(fakeBase).origin).not.toBe(new URL(apiBase).origin);

    const project = makeTempProject('browser-engine-fake');
    writeFixtureProject(project);
    writeFileSync(
      join(project, '.gateforge/adapters/tenant.accounts.mjs'),
      [
        'export default {',
        `  environmentFingerprint: '${FINGERPRINT}',`,
        '  deletion: \'archive\',',
        '  async list(ctx) { return (await (await ctx.get(\'/api/accounts\')).json()).accounts; },',
        '  async read(ctx, id) { const r = await ctx.get(\'/api/accounts/\' + id); return r.status === 404 ? null : r.json(); },',
        '  normalize(b) { return { entityId: b.id, fields: { first_name: b.first_name, status: b.status } }; },',
        '};',
        '',
      ].join('\n'),
    );
    const witness = await startWitness({
      runId: 'browser-engine-fake',
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir: join(project, '.gateforge/adapters'),
      classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
      targetBaseUrl: apiBase,
      targetFingerprint: FINGERPRINT,
      adapterBaseUrl: apiBase,
      host: '127.0.0.1',
    });
    try {
      const supervisor = new SupervisorClient(witness.url, TOKEN, VERIFIER_KEY);
      const session = await supervisor.openSession({ testId: 'fake-frontend', workerIndex: 0 });
      const channel = { sessionId: session.sessionId, sessionToken: session.sessionToken, testId: 'fake-frontend' };
      const scope = { witnessUrl: witness.url, token: TOKEN };
      const surface = await loadSurface();
      // Naming the fake frontend is rejected outright — even though it
      // is loopback AND presents the pinned fingerprint header.
      const named = await post(scope, '/browser/surface', { ...channel, surface, appBaseUrl: fakeBase });
      expect(named.status).toBe(400);
      // Registering without an origin succeeds (proves nothing by itself).
      const registered = await post(scope, '/browser/surface', { ...channel, surface });
      expect(registered.status).toBe(200);
      // The engine drives the TRUSTED subject (the UI-less real API):
      // no list, no form — the action fails closed with zero records.
      const action = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'create',
        fields: { first_name: 'API-only', status: 'active' },
      });
      expect(action.status).toBe(409);
      const records = await ledgerRecords(scope);
      expect(records.filter((record) => record.kind === 'ui.action')).toHaveLength(0);
      const outcome = gradeClaim('fake-frontend', records);
      expect(outcome.verdict).not.toBe('satisfied');
      expect(outcome.verdict).toBe('missing');
    } finally {
      await witness.stop();
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await new Promise<void>((resolve) => fake.close(() => resolve()));
      removeTempProject(project);
    }
  });

  it('a redirect leaving the trusted origin fails the action closed', async () => {
    // Replacement-origin enforcement at the redirect layer: a trusted
    // subject whose form POST answers 303 to a FOREIGN origin must not
    // produce evidence — the engine rejects the redirect chain even
    // though the 303 itself came from the app.
    const { createServer } = await import('node:http');
    const evil = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<h1>Accounts</h1><table><tbody><tr><td>acc-9</td><td>Evil</td><td>active</td></tr></tbody></table>');
    });
    await new Promise<void>((resolve) => evil.listen(0, '127.0.0.1', resolve));
    const evilBase = `http://127.0.0.1:${String((evil.address() as { port: number }).port)}`;
    const app = createServer((req, res) => {
      res.setHeader('x-gateforge-env-fingerprint', FINGERPRINT);
      // Minimal JSON API so the pre-observation adapter read works; the
      // UI flow is what the test exercises.
      if (req.url === '/api/accounts') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ accounts: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/accounts') {
        // Drain the form body, then redirect OFF-ORIGIN: the engine must
        // reject the chain even though this 303 came from the app.
        void (async () => {
          for await (const _chunk of req) { /* drain */ }
          res.writeHead(303, { location: `${evilBase}/` });
          res.end();
        })();
        return;
      }
      res.setHeader('content-type', 'text/html');
      if (req.url === '/accounts/new') {
        res.end(
          '<form action="/accounts" method="post"><input name="first_name">' +
            '<input name="last_name"><button type="submit">Save</button></form>',
        );
      } else {
        res.end('<h1>Accounts</h1><table><tbody></tbody></table>');
      }
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const appBase = `http://127.0.0.1:${String((app.address() as { port: number }).port)}`;
    const project = makeTempProject('browser-engine-redirect');
    writeFixtureProject(project);
    writeHonestAdapter(project);
    const witness = await startWitness({
      runId: 'browser-engine-redirect',
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir: join(project, '.gateforge/adapters'),
      classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
      targetBaseUrl: appBase,
      targetFingerprint: FINGERPRINT,
      adapterBaseUrl: appBase,
      host: '127.0.0.1',
    });
    try {
      const supervisor = new SupervisorClient(witness.url, TOKEN, VERIFIER_KEY);
      const session = await supervisor.openSession({ testId: 'redirect-escape', workerIndex: 0 });
      const channel = { sessionId: session.sessionId, sessionToken: session.sessionToken, testId: 'redirect-escape' };
      const scope = { witnessUrl: witness.url, token: TOKEN };
      const surface = await loadSurface();
      const registered = await post(scope, '/browser/surface', { ...channel, surface });
      expect(registered.status).toBe(200);
      const action = await post(scope, '/browser/action', {
        ...channel,
        claimIds: [CLAIM],
        operation: 'create',
        fields: { first_name: 'Ada', last_name: 'Lovelace' },
      });
      expect(action.status).toBe(409);
      expect(JSON.stringify(action.json)).toMatch(/trusted application origin|foreign origin/);
      const records = await ledgerRecords(scope);
      expect(records.filter((record) => record.kind === 'ui.action')).toHaveLength(0);
    } finally {
      await witness.stop();
      await new Promise<void>((resolve) => app.close(() => resolve()));
      await new Promise<void>((resolve) => evil.close(() => resolve()));
      removeTempProject(project);
    }
  });
});
