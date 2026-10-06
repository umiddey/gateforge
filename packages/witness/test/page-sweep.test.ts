import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineBrowserManager } from '../src/witness/browser.js';
import { sweepPageVisits } from '../src/witness/page-observer-registration.js';

describe('referee page sweep', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => cleanup?.());

  it('issues swept-channel records carrying the shared visit verdict', async () => {
    const app = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.headers.cookie?.includes('auth=ready') ? '<body>Ready</body>' : '<body>Something went wrong</body>');
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    cleanup = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const records: Array<{ obligationId: string; testId: string; payload: { channel?: unknown; apiRequestsSettled?: unknown; observationSequence?: unknown } }> = [];
    try {
      const visits = await sweepPageVisits({
        browser: manager,
        sessionId: 'sweep-test',
        testId: 'referee',
        appBase,
        routes: [{ id: 'tenant.page-home', path: '/' }, { id: 'tenant.page-other', path: '/other' }],
        loginRoutes: [],
        errorMarkers: [],
        storageState: {
          cookies: [{
            name: 'auth',
            value: 'ready',
            domain: [127, 0, 0, 1].join('.'),
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          }],
          origins: [],
        },
        issueRecord: (obligationId, testId, payload) => {
          if (payload === null || typeof payload !== 'object' || !('channel' in payload)) throw new Error('sweep record has no channel');
          records.push({ obligationId, testId, payload });
          return String(records.length);
        },
      });
      expect(visits[0]?.verdict.loads.satisfied).toBe(true);
      expect(visits[1]?.verdict.loads.satisfied).toBe(true);
      expect(records.map((record) => record.payload.channel)).toEqual(['swept', 'swept', 'swept', 'swept']);
      expect(records.map((record) => record.obligationId)).toEqual([
        'tenant.page-home:page:loads',
        'tenant.page-home:page:data-ok',
        'tenant.page-other:page:loads',
        'tenant.page-other:page:data-ok',
      ]);
      // One payload per route visit, shared by both promise records; the
      // sequence increases within the sweep and settled is stamped honestly.
      expect(records.map((record) => record.payload.observationSequence)).toEqual([0, 0, 1, 1]);
      expect(records.every((record) => record.payload.apiRequestsSettled === true)).toBe(true);
    } finally {
      await cleanup();
      cleanup = undefined;
    }
  });
});
