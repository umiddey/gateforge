import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'playwright';
import { buildHttpLedger } from '@gate-forge/core';
import { wrapRequestContext } from '../src/fixture/api-request.js';
import { startWitness } from '../src/witness/server.js';
import { SupervisorClient } from '../src/supervisor/client.js';
import type { WitnessHandle } from '@gate-forge/witness/witness/server';

const TOKEN = 'api-transport-token';
const KEY = 'api-transport-key';
const RUN_ID = 'api-transport-run';
const calls: Array<{ method: string; path: string; marker: string | undefined; body: string }> = [];
let app: Server;
let other: Server;
let appUrl: string;
let otherUrl: string;
let witness: WitnessHandle;
let supervisor: SupervisorClient;
let externalSawMarker = false;

beforeAll(async () => {
  app = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const path = req.url ?? '/';
    calls.push({ method: req.method ?? 'GET', path, marker: req.headers['x-gateforge-initiator'] as string | undefined, body });
    res.setHeader('date', 'Sat, 10 Oct 2026 00:00:00 GMT');
    res.setHeader('x-app-response', 'unchanged');
    if (path.startsWith('/redirect/')) {
      const status = Number(path.slice('/redirect/'.length));
      res.writeHead(status, { location: `${appUrl}/answer` });
      res.end();
    } else if (path === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
    } else if (path === '/external-redirect') {
      res.writeHead(302, { location: otherUrl });
      res.end();
    } else {
      res.writeHead(path === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path, body }));
    }
  });
  other = createServer((req, res) => {
    externalSawMarker = req.headers['x-gateforge-initiator'] !== undefined;
    res.end('external origin');
  });
  app.listen(0, '127.0.0.1');
  other.listen(0, '127.0.0.1');
  await Promise.all([once(app, 'listening'), once(other, 'listening')]);
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: KEY, proxyTarget: appUrl });
  supervisor = new SupervisorClient(witness.url, TOKEN, KEY);
});

afterAll(async () => {
  await witness?.stop();
  if (app?.listening) { app.close(); await once(app, 'close'); }
  if (other?.listening) { other.close(); await once(other, 'close'); }
});

async function ledger() {
  const response = await fetch(`${witness.url}/records`, { headers: { 'x-gateforge-run': TOKEN } });
  expect(response.status).toBe(200);
  const value = await response.json() as { records: unknown[] };
  return buildHttpLedger(value.records, []);
}

describe('test-owned API transport through real session proxies', () => {
  it('preserves response status, body and headers for redirects and errors, marking every app hop', async () => {
    const session = await supervisor.openSession({ testId: 'responses', workerIndex: 0, claims: [] });
    const native = await request.newContext({ baseURL: appUrl });
    const wrapped = wrapRequestContext(native, { baseURL: appUrl, sessionProxyUrl: async () => session.proxyUrl });
    try {
      for (const path of ['/answer', '/missing', '/redirect/302']) {
        const direct = await native.get(path);
        const observed = await wrapped.get(path);
        expect(observed.status()).toBe(direct.status());
        expect(await observed.body()).toEqual(await direct.body());
        expect(observed.headers()).toEqual(direct.headers());
      }
      for (const status of [301, 302, 303, 307, 308]) {
        const path = `/redirect/${status}`;
        const direct = await native.post(path, { data: 'payload' });
        const observed = await wrapped.post(path, { data: 'payload' });
        expect(observed.status()).toBe(direct.status());
        expect(await observed.body()).toEqual(await direct.body());
        expect(observed.headers()).toEqual(direct.headers());
      }
      const stopped = await wrapped.get('/redirect/302', { maxRedirects: 0 });
      expect(stopped.status()).toBe(302);
      expect(stopped.headers()['location']).toBe(`${appUrl}/answer`);
      await expect(wrapped.get('/loop', { maxRedirects: 1 })).rejects.toThrow('Max redirect count exceeded');
      await supervisor.closeSession({ sessionId: session.sessionId, outcome: 'passed' });
      const rows = (await ledger()).rows.filter((row) => row.testId === 'responses');
      expect(rows).toContainEqual(expect.objectContaining({ path: '/missing', status: 404, initiator: 'test-code' }));
      expect(rows).toContainEqual(expect.objectContaining({ path: '/redirect/302', status: 302, initiator: 'test-code' }));
      expect(rows).toContainEqual(expect.objectContaining({ path: '/answer', status: 200, initiator: 'test-code' }));
      expect(rows.every((row) => row.initiator === 'test-code')).toBe(true);
      expect(calls.every((call) => call.marker === undefined)).toBe(true);
    } finally { await native.dispose(); }
  });

  it('leaves non-app origins and calls with no current session direct', async () => {
    const session = await supervisor.openSession({ testId: 'direct', workerIndex: 0, claims: [] });
    const native = await request.newContext({ baseURL: appUrl });
    let owner: string | null = session.proxyUrl;
    const wrapped = wrapRequestContext(native, { baseURL: appUrl, sessionProxyUrl: async () => owner });
    try {
      expect(await (await wrapped.get(otherUrl)).text()).toBe('external origin');
      owner = null;
      expect((await wrapped.get('/setup')).status()).toBe(200);
      await supervisor.closeSession({ sessionId: session.sessionId, outcome: 'passed' });
      expect((await ledger()).rows.filter((row) => row.testId === 'direct')).toEqual([]);
    } finally { await native.dispose(); }
  });

  it('follows non-app redirects without sending the engine marker to that origin', async () => {
    const session = await supervisor.openSession({ testId: 'external-redirect', workerIndex: 0, claims: [] });
    const native = await request.newContext({ baseURL: appUrl });
    const wrapped = wrapRequestContext(native, { baseURL: appUrl, sessionProxyUrl: async () => session.proxyUrl });
    try {
      expect(await (await wrapped.get('/external-redirect')).text()).toBe('external origin');
      expect(externalSawMarker).toBe(false);
      await supervisor.closeSession({ sessionId: session.sessionId, outcome: 'passed' });
      expect((await ledger()).rows.filter((row) => row.testId === 'external-redirect')).toEqual([
        expect.objectContaining({ path: '/external-redirect', status: 302, initiator: 'test-code' }),
      ]);
    } finally { await native.dispose(); }
  });

  it('attributes reused contexts to the current test, preserving verbs, payloads and query strings', async () => {
    let session = await supervisor.openSession({ testId: 'owner-a', workerIndex: 0, claims: [] });
    const native = await request.newContext({ baseURL: appUrl });
    const wrapped = wrapRequestContext(native, { baseURL: appUrl, sessionProxyUrl: async () => session.proxyUrl });
    try {
      await wrapped.post('/first?x=1', { data: 'body', headers: { 'X-Gateforge-Initiator': 'page' } });
      await supervisor.closeSession({ sessionId: session.sessionId, outcome: 'passed' });
      session = await supervisor.openSession({ testId: 'owner-b', workerIndex: 0, claims: [] });
      for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'GET']) await wrapped.fetch('/second', { method });
      await supervisor.closeSession({ sessionId: session.sessionId, outcome: 'passed' });
      const rows = (await ledger()).rows;
      expect(rows.filter((row) => row.testId === 'owner-a')).toEqual([
        expect.objectContaining({ method: 'POST', path: '/first', initiator: 'test-code' }),
      ]);
      expect(rows.filter((row) => row.testId === 'owner-b')).toHaveLength(5);
      expect(calls).toContainEqual({ method: 'POST', path: '/first?x=1', marker: undefined, body: 'body' });
    } finally { await native.dispose(); }
  });
});
