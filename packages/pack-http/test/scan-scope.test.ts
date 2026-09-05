/**
 * Phase 3 scan-scoping suite: `clientScanRoots` / `serverScanRoots` and
 * per-symbol include/exclude in `.gateforge/http-clients.json`.
 *
 * Two real dogfood failures drove the design (both reproduced here as
 * red probes, then fixed by scoping):
 *
 *   - a consumer's e2e specs defined a helper ALSO named `api`, and the
 *     client scanner picked every harness call up as product frontend
 *     consumption (FRONTEND_CALL_TARGET_UNRESOLVED blockers + phantom
 *     consumption). Test-harness calls are a different contract class.
 *   - false `http.endpoint` server routes were discovered inside
 *     `tests/e2e` because test-harness mock servers matched the generic
 *     server-route regex. Test servers are not product routes.
 *
 * Determinism: offline fixture trees, pure discovery, sorted assertions.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpDetector } from '../src/index.js';
import { readClientScanConfigOrNull, type ClientScanConfig } from '../src/client-calls.js';

/** Materializes a repo-root-relative fixture tree in a temp directory. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-scan-scope-'));
  for (const [rel, text] of Object.entries(files)) {
    const absolute = join(dir, rel);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true });
    writeFileSync(absolute, text);
  }
  return dir;
}

interface ContractRow {
  kind: string;
  attributes: Record<string, unknown>;
  location: { file: string; line: number; col: number };
}

/** Sorted `METHOD path` rows of the frontend-call facts. */
function frontendFacts(outcome: { resources: ReadonlyArray<ContractRow> }): string[] {
  return outcome.resources
    .filter((resource) => resource.kind === 'http.contract' && resource.attributes['role'] === 'frontend-call')
    .map((resource) => `${resource.attributes['method'] as string} ${resource.attributes['normalizedPath'] as string}`)
    .sort();
}

/** Sorted `METHOD path` rows of the server-route facts. */
function serverFacts(outcome: { resources: ReadonlyArray<ContractRow> }): string[] {
  return outcome.resources
    .filter((resource) => resource.kind === 'http.contract' && resource.attributes['role'] === 'server-route')
    .map((resource) => `${resource.attributes['method'] as string} ${resource.attributes['normalizedPath'] as string}`)
    .sort();
}

/** The dogfood-shaped tree: product frontend + e2e harness sharing the symbol name `api`. */
function clientFixture(): Record<string, string> {
  return {
    // Product client: the only `api` the configuration means to declare.
    'frontend/src/api/authFetch.js': `export const API_BASE = '/api';\n`,
    // Product callsite; imports a constant from OUTSIDE clientScanRoots
    // to pin the rule that scoping narrows fact emission, not the
    // value-table dataflow (imports still resolve across the full set).
    'frontend/src/products.ts': [
      `import { api } from './api/authFetch';`,
      `import { ACCOUNTS_PATH } from '../../shared/constants';`,
      `await api.get(ACCOUNTS_PATH);`,
    ].join('\n'),
    'shared/constants.ts': `export const ACCOUNTS_PATH = '/api/accounts';\n`,
    // Test harness: same symbol name, different contract class.
    'e2e/helpers/api.ts': [
      `export function api(method: string, path: string, body?: unknown): unknown {`,
      `  return http.request(path, { method, body });`,
      `}`,
    ].join('\n'),
    'e2e/scenarios/login.spec.ts': [
      `import { api } from '../helpers/api';`,
      `api('POST', '/api/login', { user: 'e2e' });`,
    ].join('\n'),
    'e2e/scenarios/logout.spec.ts': [
      `import { api } from '../helpers/api';`,
      `api('POST', '/api/logout', {});`,
    ].join('\n'),
  };
}

describe('clientScanRoots (top-level client-call scoping)', () => {
  it('produces zero facts and zero unresolved entries from e2e files; product calls still resolve', () => {
    const dir = project(clientFixture());
    try {
      const detector = createHttpDetector({
        root: dir,
        clientScan: {
          clientScanRoots: ['frontend/**'],
          clientSymbols: [{ name: 'api', include: ['frontend/src/**'] }],
        },
      });
      const outcome = detector.discover(['frontend', 'shared', 'e2e']);
      // The product call resolves — including its import of a constant
      // that lives outside the roots (dataflow is not narrowed).
      expect(frontendFacts(outcome)).toEqual(['GET /api/accounts']);
      // The harness helper and both spec calls vanish ENTIRELY: no
      // phantom facts, no FRONTEND_CALL_TARGET_UNRESOLVED blockers.
      expect(outcome.unresolved).toEqual([]);
      const factFiles = outcome.resources.map((resource) => resource.location.file);
      expect(factFiles.every((file) => file.startsWith('frontend/'))).toBe(true);
      // No classification signals exist at all (phase 4) — the harness
      // calls cannot leak in as path-derived exposure guesses either way.
      expect(outcome.classificationSignals).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('red probe: the same tree without scoping surfaces the harness calls as blockers', () => {
    const dir = project(clientFixture());
    try {
      const detector = createHttpDetector({ root: dir, clientScan: { clientSymbols: ['api'] } });
      const outcome = detector.discover(['frontend', 'shared', 'e2e']);
      // Unscoped, every `api('POST', '/path', body)` harness call is
      // scanned as product frontend consumption — the dogfood failure
      // (20 FRONTEND_CALL_TARGET_UNRESOLVED blockers in e2e specs).
      expect(frontendFacts(outcome)).toEqual(['GET /api/accounts']);
      expect(outcome.unresolved.length).toBeGreaterThanOrEqual(2);
      for (const entry of outcome.unresolved) {
        expect(entry.code).toBe('FRONTEND_CALL_TARGET_UNRESOLVED');
        expect(String(entry.location.file).startsWith('e2e/')).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('per-symbol include/exclude', () => {
  it('a symbol scoped to frontend still resolves there; the same-named helper outside the scope is ignored', () => {
    const dir = project(clientFixture());
    try {
      // No clientScanRoots: per-symbol scoping must stand on its own.
      const detector = createHttpDetector({
        root: dir,
        clientScan: { clientSymbols: [{ name: 'api', include: ['frontend/src/**'] }] },
      });
      const outcome = detector.discover(['frontend', 'shared', 'e2e']);
      expect(frontendFacts(outcome)).toEqual(['GET /api/accounts']);
      expect(outcome.unresolved).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exclude wins over include: a glob named by both keeps the file out of scope', () => {
    const dir = project(clientFixture());
    try {
      const detector = createHttpDetector({
        root: dir,
        clientScan: {
          clientSymbols: [{ name: 'api', include: ['**'], exclude: ['e2e/**', 'shared/**'] }],
        },
      });
      const outcome = detector.discover(['frontend', 'shared', 'e2e']);
      expect(frontendFacts(outcome)).toEqual(['GET /api/accounts']);
      expect(outcome.unresolved).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('composes with the top-level roots: a symbol is active only where BOTH gates admit the file', () => {
    const dir = project(clientFixture());
    try {
      // The symbol admits everything, but the top-level roots gate the
      // client channel to frontend/ — outside, NOTHING is extracted.
      const detector = createHttpDetector({
        root: dir,
        clientScan: { clientScanRoots: ['frontend/**'], clientSymbols: ['api'] },
      });
      const outcome = detector.discover(['frontend', 'shared', 'e2e']);
      expect(frontendFacts(outcome)).toEqual(['GET /api/accounts']);
      expect(outcome.unresolved).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a wrapper scoped to the product tree resolves product calls and ignores the e2e helper of the same name', () => {
    const dir = project({
      'frontend/src/api.ts': [
        `const apiGet = (path: string) => fetch(\`/api/v1\${path}\`);`,
        `apiGet('/accounts');`,
      ].join('\n'),
      // Harness helper with the SAME wrapper name — the phantom
      // consumption risk from the dogfood report.
      'e2e/helpers.ts': [
        `const apiGet = (path: string) => http.request(path);`,
        `apiGet('/e2e-probe');`,
      ].join('\n'),
    });
    try {
      const scoped = createHttpDetector({
        root: dir,
        clientScan: { wrapperFunctions: [{ name: 'apiGet', method: 'GET', include: ['frontend/**'] }] },
      }).discover(['frontend', 'e2e']);
      expect(frontendFacts(scoped)).toEqual(['GET /api/v1/accounts']);
      expect(scoped.unresolved).toEqual([]);

      // Red probe: unscoped, the harness helper's call goes through the
      // wrapper model too and surfaces a harness-side blocker.
      const unscoped = createHttpDetector({
        root: dir,
        clientScan: { wrapperFunctions: [{ name: 'apiGet', method: 'GET' }] },
      }).discover(['frontend', 'e2e']);
      expect(unscoped.unresolved.some((entry) => String(entry.location.file).startsWith('e2e/'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a builder scoped away stops resolving (fail-closed), and clientScanRoots then removes the file entirely', () => {
    const dir = project({
      'frontend/src/api.ts': `fetch(buildApiPath('/accounts'));\n`,
      'e2e/helpers.ts': `fetch(buildApiPath('/e2e-probe'));\n`,
    });
    try {
      // Builder scoping controls RESOLUTION, not call discovery: the
      // e2e fetch is still an in-scope call, and its target now cannot
      // resolve — a typed block, never silence.
      const builderScoped = createHttpDetector({
        root: dir,
        clientScan: { urlBuilders: [{ name: 'buildApiPath', base: '/api', include: ['frontend/**'] }] },
      }).discover(['frontend', 'e2e']);
      expect(frontendFacts(builderScoped)).toEqual(['GET /api/accounts']);
      expect(builderScoped.unresolved).toHaveLength(1);
      expect(builderScoped.unresolved[0]?.location.file).toBe('e2e/helpers.ts');

      // Composing the top-level roots scopes the whole e2e file out of
      // the client channel — facts and unresolved entries both vanish.
      const fully = createHttpDetector({
        root: dir,
        clientScan: {
          clientScanRoots: ['frontend/**'],
          urlBuilders: [{ name: 'buildApiPath', base: '/api', include: ['frontend/**'] }],
        },
      }).discover(['frontend', 'e2e']);
      expect(frontendFacts(fully)).toEqual(['GET /api/accounts']);
      expect(fully.unresolved).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('serverScanRoots (server-route scoping)', () => {
  function serverFixture(): Record<string, string> {
    return {
      'src/app.ts': [
        `import express from 'express';`,
        `const app = express();`,
        `app.get('/api/accounts', () => ({}));`,
      ].join('\n'),
      // Test-harness mock server: matches the generic route regex, but
      // it is NOT a product route.
      'tests/e2e/mock-server.ts': [
        `import express from 'express';`,
        `const server = express();`,
        `server.get('/api/mock-accounts', () => ({}));`,
      ].join('\n'),
      // Harness NestJS module: decorator pairs must be gated too.
      'tests/e2e/nest-mock.ts': [
        `import { Controller, Get } from '@nestjs/common';`,
        `@Controller('mock')`,
        `export class MockController {`,
        `  @Get('ping')`,
        `  ping() { return {}; }`,
        `}`,
      ].join('\n'),
    };
  }

  it('yields no server-route facts from the e2e dir; product routes still discover', () => {
    const dir = project(serverFixture());
    try {
      const detector = createHttpDetector({ root: dir, clientScan: { serverScanRoots: ['src/**'] } });
      const outcome = detector.discover(['src', 'tests']);
      expect(serverFacts(outcome)).toEqual(['GET /api/accounts']);
      // No classification signals exist at all (phase 4); the mock server
      // and nest module produce no facts either way.
      expect(outcome.classificationSignals).toEqual([]);
      // Scoping narrows facts, not coverage reporting: the walk still
      // read the e2e files, so they remain in scannedPaths.
      expect(outcome.scannedPaths).toContain('tests/e2e/mock-server.ts');
      expect(outcome.scannedPaths).toContain('tests/e2e/nest-mock.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('red probe: without serverScanRoots the harness servers become route facts', () => {
    const dir = project(serverFixture());
    try {
      const outcome = createHttpDetector({ root: dir }).discover(['src', 'tests']);
      expect(serverFacts(outcome).sort()).toEqual([
        'GET /api/accounts',
        'GET /api/mock-accounts',
        'GET /mock/ping',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('client-symbol disambiguation is scope-aware: out of client scope, api.get(path, handler) is a router again', () => {
    const dir = project({
      // Express-shaped registration via a name that is ALSO a configured
      // client symbol — inside the symbol's scope it is a client call,
      // outside (backend/) it can only be a router registration.
      'frontend/src/client.ts': `api.get('/api/session', (req) => req);\n`,
      'backend/routes.ts': `api.get('/api/admin', (req) => req);\n`,
    });
    try {
      const detector = createHttpDetector({
        root: dir,
        clientScan: { clientSymbols: [{ name: 'api', include: ['frontend/**'] }] },
      });
      const outcome = detector.discover(['frontend', 'backend']);
      expect(frontendFacts(outcome)).toEqual(['GET /api/session']);
      expect(serverFacts(outcome)).toEqual(['GET /api/admin']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('http-clients.json parsing of the scoping keys', () => {
  it('reads scoped config end to end from the default document path', () => {
    const config: ClientScanConfig = {
      clientScanRoots: ['frontend/**'],
      serverScanRoots: ['src/**'],
      clientSymbols: [{ name: 'api', include: ['frontend/src/**'], exclude: ['frontend/src/generated/**'] }],
    };
    const dir = project({
      '.gateforge/http-clients.json': JSON.stringify(config),
      'frontend/src/app.ts': `api.get('/api/accounts');\n`,
      'e2e/spec.ts': `api('POST', '/api/login', {});\n`,
    });
    try {
      const outcome = createHttpDetector({ root: dir }).discover(['frontend', 'e2e']);
      expect(frontendFacts(outcome)).toEqual(['GET /api/accounts']);
      expect(outcome.unresolved).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the old shapes byte-for-byte and keeps the non-array posture', () => {
    const dir = project({
      '.gateforge/old.json': JSON.stringify({
        clientSymbols: ['apiClient'],
        wrapperFunctions: [{ name: 'apiGet', method: 'GET' }],
        urlBuilders: ['buildPath', { name: 'buildApiPath', base: '/api' }],
        sameOriginHosts: ['app.example.com'],
      }),
      '.gateforge/new.json': JSON.stringify({
        clientScanRoots: 'frontend/**', // non-array: ignored, as before
        clientSymbols: [{ name: 'api', include: ['frontend/**'] }],
      }),
    });
    try {
      const oldConfig = readClientScanConfigOrNull(join(dir, '.gateforge/old.json'));
      expect(oldConfig).toEqual({
        clientSymbols: ['apiClient'],
        wrapperFunctions: [{ name: 'apiGet', method: 'GET' }],
        urlBuilders: [{ name: 'buildPath' }, { name: 'buildApiPath', base: '/api' }],
        sameOriginHosts: ['app.example.com'],
      });
      const newConfig = readClientScanConfigOrNull(join(dir, '.gateforge/new.json'));
      expect(newConfig).toEqual({
        clientSymbols: [{ name: 'api', include: ['frontend/**'] }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on malformed scoping entries (fail closed) but ignores unknown keys (unchanged posture)', () => {
    const dir = project({
      '.gateforge/missing-name.json': JSON.stringify({ clientSymbols: [{ include: ['x/**'] }] }),
      '.gateforge/bad-include.json': JSON.stringify({ clientSymbols: [{ name: 'api', include: 'x/**' }] }),
      '.gateforge/bad-wrapper-scope.json': JSON.stringify({
        wrapperFunctions: [{ name: 'apiGet', method: 'GET', exclude: 42 }],
      }),
      '.gateforge/unknown.json': JSON.stringify({ totallyUnknownKey: true, clientSymbols: ['api'] }),
    });
    try {
      const read = (name: string) => readClientScanConfigOrNull(join(dir, `.gateforge/${name}`));
      expect(() => read('missing-name.json')).toThrow(/must carry a name/);
      expect(() => read('bad-include.json')).toThrow(/must be an array of globs/);
      expect(() => read('bad-wrapper-scope.json')).toThrow(/must be an array of globs/);
      // Unknown keys stay ignored — the parser was never strict about
      // them, and consistency beats new strictness on old surface.
      expect(read('unknown.json')).toEqual({ clientSymbols: ['api'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
