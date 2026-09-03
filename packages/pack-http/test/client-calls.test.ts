/**
 * Phase 3 engine tests: the bounded static dataflow for frontend
 * API-client calls (ADR 0004 D6, plan phase 3 verification checklist).
 * Pure and offline.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpDetector } from '../src/index.js';
import { scanClientCalls } from '../src/client-calls.js';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-client-'));
  for (const [rel, text] of Object.entries(files)) {
    const absolute = join(dir, rel);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true });
    writeFileSync(absolute, text);
  }
  return dir;
}

function frontendFacts(outcome: { resources: ReadonlyArray<{ kind: string; attributes: Record<string, unknown> }> }): string[] {
  return outcome.resources
    .filter((resource) => resource.kind === 'http.contract' && resource.attributes['role'] === 'frontend-call')
    .map((resource) => `${resource.attributes['method'] as string} ${resource.attributes['normalizedPath'] as string}`)
    .sort();
}

describe('bounded dataflow resolution', () => {
  it('resolves constants, imports, templates, instances, and builders', () => {
    const files = new Map<string, string>([
      ['src/api.ts', [
        `export const API_BASE = '/api';`,
        `export const ACCOUNTS = \`\${API_BASE}/accounts\`;`,
      ].join('\n')],
      ['src/app.ts', [
        `import { API_BASE, ACCOUNTS } from './api';`,
        `const apiClient = getClient();`,
        `const route = buildApiPath('/v1/orders');`,
        `await fetch(ACCOUNTS);`,
        `await apiClient.get(\`\${ACCOUNTS}/\${id}\`);`,
        `await apiClient.post(ACCOUNTS + '/x', body);`,
        `axios.patch('/api/accounts/42');`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls('src/app.ts', files.get('src/app.ts') ?? '', { clientSymbols: ['apiClient'] }, files);
    // `ACCOUNTS + '/x'` is arbitrary concatenation: outside the model.
    expect(calls.calls.map((call) => `${call.method} ${call.rawPath}`).sort()).toEqual([
      'GET /api/accounts',
      'GET /api/accounts/${}',
      'PATCH /api/accounts/42',
    ]);
    expect(calls.unresolved).toHaveLength(1);
    expect(calls.unresolved[0]?.code).toBe('FRONTEND_CALL_TARGET_UNRESOLVED');
  });

  it('extracts methods from fetch options and axios config objects', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [
        `const method = 'DELETE';`,
        `fetch('/api/accounts/7', { method });`,
        `fetch('/api/accounts', { method: 'POST', body });`,
        `axios({ url: '/api/session', method: 'PATCH' });`,
        `axios.request({ url: '/api/session' });`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls('src/a.ts', files.get('src/a.ts') ?? '', {}, files);
    expect(calls.calls.map((call) => `${call.method} ${call.rawPath}`).sort()).toEqual([
      'DELETE /api/accounts/7',
      'GET /api/session',
      'PATCH /api/session',
      'POST /api/accounts',
    ]);
    expect(calls.unresolved).toEqual([]);
  });

  it('resolves simple single-return wrappers through bounded substitution', () => {
    const files = new Map<string, string>([
      ['src/wrap.ts', [
        `const apiGet = (path: string) => fetch(\`/api/v1\${path}\`);`,
        `const apiPost = (path: string) => fetch(\`/api/v1\${path}\`, { method: 'POST' });`,
        `apiGet('/accounts');`,
        `apiPost('/accounts');`,
      ].join('\n')],
    ]);
    const config = {
      wrapperFunctions: [
        { name: 'apiGet', method: 'GET' as const },
        { name: 'apiPost', method: 'POST' as const },
      ],
    };
    const calls = scanClientCalls('src/wrap.ts', files.get('src/wrap.ts') ?? '', config, files);
    expect(calls.calls.map((call) => `${call.method} ${call.rawPath}`).sort()).toEqual([
      'GET /api/v1/accounts',
      'POST /api/v1/accounts',
    ]);
    expect(calls.unresolved).toEqual([]);
  });

  it('treats ${} slots mid-path as positional without runtime values', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [`fetch(\`/api/accounts/\${account.id}/orders\`);`].join('\n')],
    ]);
    const calls = scanClientCalls('src/a.ts', files.get('src/a.ts') ?? '', {}, files);
    expect(calls.calls.map((call) => call.rawPath)).toEqual(['/api/accounts/${}/orders']);
    expect(calls.unresolved).toEqual([]);
  });

  it('blocks environment-dependent hosts and unknown prefixes', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [
        `fetch(\`\${process.env.API_URL}/accounts\`);`,
        `fetch('https://random-host.example.com/api/accounts');`,
        `const path = window.location.pathname; fetch(path);`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls('src/a.ts', files.get('src/a.ts') ?? '', {}, files);
    expect(calls.calls).toEqual([]);
    expect(calls.unresolved).toHaveLength(3);
    for (const entry of calls.unresolved) {
      expect(entry.code).toBe('FRONTEND_CALL_TARGET_UNRESOLVED');
    }
  });

  it('canonicalizes configured same-origin absolute URLs', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [`fetch('https://app.example.com/api/v1/accounts');`].join('\n')],
    ]);
    const calls = scanClientCalls(
      'src/a.ts',
      files.get('src/a.ts') ?? '',
      { sameOriginHosts: ['app.example.com'] },
      files,
    );
    expect(calls.calls.map((call) => call.rawPath)).toEqual(['https://app.example.com/api/v1/accounts']);
    expect(calls.calls.map((call) => call.canonicalPath)).toEqual(['/api/v1/accounts']);
  });
});

describe('detector integration (phase 3)', () => {
  it('resolves configured client symbols and builders end to end, one fact per callsite', () => {
    const dir = project({
      'src/api.ts': `export const ACCOUNTS_PATH = buildApiPath('/accounts');\n`,
      'src/app.ts': [
        `import { ACCOUNTS_PATH } from './api';`,
        `apiClient.get(ACCOUNTS_PATH);`,
        `apiClient.get(ACCOUNTS_PATH);`,
      ].join('\n'),
    });
    try {
      const detector = createHttpDetector({
        root: dir,
        clientScan: {
          clientSymbols: ['apiClient'],
          urlBuilders: [{ name: 'buildApiPath', base: '/api' }],
        },
      });
      const outcome = detector.discover(['src']);
      // Both callsites record independently even though they join the
      // same endpoint (plan phase 3.6).
      expect(frontendFacts(outcome)).toEqual(['GET /api/accounts', 'GET /api/accounts']);
      const roles = outcome.resources
        .filter((resource) => resource.kind === 'http.contract' && resource.attributes['role'] === 'frontend-call')
        .map((resource) => resource.attributes['callsites']);
      expect(roles[0]).not.toEqual(roles[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('red probe: removing wrapper support makes the call a visible unresolved entry', () => {
    const dir = project({
      'src/app.ts': [
        `const apiGet = (path: string) => fetch(\`/api/v1\${path}\`);`,
        `apiGet('/accounts');`,
      ].join('\n'),
    });
    try {
      const withoutSupport = createHttpDetector({ root: dir, clientScan: {} }).discover(['src']);
      expect(withoutSupport.resources.filter((resource) => resource.kind === 'http.contract')).toEqual([]);
      expect(withoutSupport.unresolved).toHaveLength(1);
      expect(withoutSupport.unresolved[0]?.['code']).toBe('FRONTEND_CALL_TARGET_UNRESOLVED');
      expect(String(withoutSupport.unresolved[0]?.['detail'])).toContain('apiGet');

      const withSupport = createHttpDetector({
        root: dir,
        clientScan: { wrapperFunctions: [{ name: 'apiGet', method: 'GET' }] },
      }).discover(['src']);
      expect(frontendFacts(withSupport)).toEqual(['GET /api/v1/accounts']);
      expect(withSupport.unresolved).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('obays the configured scan scope: paths outside the request never yield facts', () => {
    const dir = project({
      'src/app.ts': `fetch('/api/accounts');\n`,
      'test/fixtures/dead.ts': `fetch('/api/ghost');\n`,
    });
    try {
      const detector = createHttpDetector({ root: dir });
      const outcome = detector.discover(['src']);
      expect(frontendFacts(outcome)).toEqual(['GET /api/accounts']);
      expect(outcome.scannedPaths).toEqual(['src/app.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the .gateforge/http-clients.json config document', () => {
    const dir = project({
      '.gateforge/http-clients.json': JSON.stringify({
        clientSymbols: ['apiClient'],
        urlBuilders: [{ name: 'buildApiPath', base: '/api' }],
      }),
      'src/api.ts': `export const ACCOUNTS_PATH = buildApiPath('/accounts');\n`,
      'src/app.ts': `import { ACCOUNTS_PATH } from './api';\napiClient.get(ACCOUNTS_PATH);\n`,
    });
    try {
      const outcome = createHttpDetector({ root: dir }).discover(['src']);
      expect(frontendFacts(outcome)).toEqual(['GET /api/accounts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
