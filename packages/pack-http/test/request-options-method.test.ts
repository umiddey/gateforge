/**
 * The request-options method model: the verb of `fetch(url, options)`.
 *
 * `fetch` sends a GET only when its options carry no `method`. Reading
 * "the second argument is not an inline object literal" as a GET invented
 * a call to a route the server never serves (`fetch(PATH,
 * withDeadline({ method: 'POST' }))` became `GET /path`), which then
 * surfaced as a frontend call to a missing backend route. These tests pin
 * the three outcomes the bounded model may answer with — provably POST,
 * provably no method (so GET really is the verb), and provably nothing,
 * which is a typed blocker and NO call fact.
 *
 * Engine-class tests: pure, offline, files only.
 */
import { describe, expect, it } from 'vitest';
import { scanClientCalls, type ClientScanConfig } from '../src/client-calls.js';

function scan(files: Record<string, string>, entry: string, config: ClientScanConfig = {}) {
  const map = new Map<string, string>(Object.entries(files));
  const result = scanClientCalls(entry, files[entry] ?? '', config, map);
  return {
    calls: result.calls
      .map((call) => `${call.method} ${call.canonicalPath}`)
      .sort(),
    unresolved: result.unresolved.map((entry_) => `${entry_.code}`).sort(),
  };
}

describe('fetch request options: the verb comes from the options, never from a guess', () => {
  it('resolves the method through an options constant', () => {
    const result = scan(
      {
        'src/api.ts': [
          `const REFRESH = { method: 'POST', credentials: 'include' };`,
          `fetch('/api/v1/auth/refresh', REFRESH);`,
        ].join('\n'),
      },
      'src/api.ts',
    );
    // Before: the constant options were not an inline object literal, so
    // the call silently kept the fetch default and joined as a GET.
    expect(result.calls).toEqual(['POST /api/v1/auth/refresh']);
    expect(result.unresolved).toEqual([]);
  });

  it('resolves the method through a single-return helper that forwards its argument', () => {
    const result = scan(
      {
        'src/api.ts': [
          `const withHeaders = (options) => ({ ...options, headers: { Accept: 'application/json' } });`,
          `fetch('/api/v1/session/renew', withHeaders({ method: 'POST' }));`,
        ].join('\n'),
      },
      'src/api.ts',
    );
    expect(result.calls).toEqual(['POST /api/v1/session/renew']);
    expect(result.unresolved).toEqual([]);
  });

  it('honours last-writer-wins through a spread, so an override beats what it follows', () => {
    const result = scan(
      {
        'src/api.ts': [
          `const BASE = { method: 'GET' };`,
          `const OPTS = { ...BASE, method: 'POST' };`,
          `fetch('/api/v1/orders', OPTS);`,
        ].join('\n'),
      },
      'src/api.ts',
    );
    // Before: `OPTS` was not an inline object literal, so the call kept
    // the fetch default and the POST was lost.
    expect(result.calls).toEqual(['POST /api/v1/orders']);
    expect(result.unresolved).toEqual([]);
  });

  it('keeps the platform default when the options provably carry no method', () => {
    const result = scan(
      {
        'src/api.ts': [
          `const CREDENTIALS = { credentials: 'include' };`,
          `fetch('/api/v1/session', CREDENTIALS);`,
        ].join('\n'),
      },
      'src/api.ts',
    );
    // Proven absent: GET is what this call really sends.
    expect(result.calls).toEqual(['GET /api/v1/session']);
    expect(result.unresolved).toEqual([]);
  });

  it('marks options it cannot prove instead of assuming GET, and emits no call', () => {
    const result = scan(
      {
        'src/deadline.js': [
          `export function withDeadline(options) {`,
          `  return { ...options, signal: controller.signal };`,
          `}`,
        ].join('\n'),
        'src/api.ts': [
          `import { withDeadline } from './deadline.js';`,
          `fetch('/api/v1/auth/refresh', withDeadline(buildOptions()));`,
        ].join('\n'),
      },
      'src/api.ts',
    );
    // `withDeadline` is not a single-return declaration and
    // `buildOptions()` is not a value this model can see: unprovable.
    // Before: a GET call fact joined `/api/v1/auth/refresh` as a route
    // that does not exist.
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual(['HTTP_METHOD_DYNAMIC']);
  });

  it('leaves an axios verb call alone: its second argument is a body, not options', () => {
    const result = scan(
      {
        'src/api.ts': [
          `const api = axios.create({ baseURL: '/api' });`,
          `api.post('/v1/orders', { note: 'x' });`,
          `api.post('/v1/orders', makePayload());`,
        ].join('\n'),
      },
      'src/api.ts',
      { clientSymbols: ['api'] },
    );
    expect(result.calls).toEqual(['POST /api/v1/orders', 'POST /api/v1/orders']);
    expect(result.unresolved).toEqual([]);
  });
});