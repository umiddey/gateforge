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

describe('instance baseURL joining (phase 3 dogfood)', () => {
  it('joins a proven literal baseURL into emitted paths, rawPath untouched (the 443-calls dogfood shape)', () => {
    // The exact dogfood shape: the instance is created with a baseURL in
    // one module, callsites are baseURL-relative ('/v1/...') while the
    // backend routes are '/api/v1/...'. The alias specifier is outside
    // the bounded import machinery, so the unique same-named creation
    // across the scanned set proves the base (tier 3).
    const files = new Map<string, string>([
      ['frontend/src/lib/apiClient.ts', `export const apiClient = axios.create({ baseURL: '/api' });\n`],
      ['frontend/src/me.ts', [
        `import { apiClient } from '@/lib/apiClient';`,
        `await apiClient.get('/v1/employee-roles/me/roles');`,
        `await apiClient.post('/v1/accounts', body);`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls(
      'frontend/src/me.ts',
      files.get('frontend/src/me.ts') ?? '',
      { clientSymbols: ['apiClient'] },
      files,
    );
    expect(calls.unresolved).toEqual([]);
    expect(calls.calls.map((call) => `${call.method} ${call.canonicalPath}`).sort()).toEqual([
      'GET /api/v1/employee-roles/me/roles',
      'POST /api/v1/accounts',
    ]);
    for (const call of calls.calls) {
      expect(call.joinedBaseURL).toBe('/api');
      expect(call.rawPath.startsWith('/v1/')).toBe(true); // exactly as written
    }
  });

  it('joins same-file creations and relative-imported creations with a constant config object', () => {
    const files = new Map<string, string>([
      ['src/client.ts', [
        `const config = { baseURL: '/api' };`,
        `export const apiClient = axios.create(config);`,
      ].join('\n')],
      ['src/app.ts', [
        `import { apiClient } from './client';`,
        `apiClient.post('/v1/accounts', body);`,
        `const local = axios.create({ baseURL: '/other' });`,
        `local.get('/v1/x');`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls('src/app.ts', files.get('src/app.ts') ?? '', { clientSymbols: ['apiClient', 'local'] }, files);
    expect(calls.unresolved).toEqual([]);
    expect(calls.calls.map((call) => `${call.method} ${call.canonicalPath} [${call.joinedBaseURL}]`).sort()).toEqual([
      'GET /other/v1/x [/other]',
      'POST /api/v1/accounts [/api]',
    ]);
  });

  it('leaves empty and / bases byte-identical, and joins with exactly one slash seam', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [
        `const empty = axios.create({ baseURL: '' });`,
        `const root = axios.create({ baseURL: '/' });`,
        `const slashed = axios.create({ baseURL: '/api/' });`,
        `const plain = axios.create({ baseURL: '/api' });`,
        `empty.get('/v1/x');`,
        `root.get('/v1/x');`,
        `slashed.get('/v1/x');`,
        `plain.get('v1/relative');`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls(
      'src/a.ts',
      files.get('src/a.ts') ?? '',
      { clientSymbols: ['empty', 'root', 'slashed', 'plain'] },
      files,
    );
    expect(calls.unresolved).toEqual([]);
    expect(calls.calls.map((call) => `${call.canonicalPath} [${call.joinedBaseURL ?? '-'}]`).sort()).toEqual([
      // A relative call path roots onto the base, as axios resolves it.
      '/api/v1/relative [/api]',
      // Trailing/leading slashes collapse to exactly one seam.
      '/api/v1/x [/api/]',
      // '' and '/' join nothing: byte-identical to the pre-feature output.
      '/v1/x [-]',
      '/v1/x [-]',
    ]);
  });

  it('resolves the base through declared constant config objects, spread or assigned, last writer wins', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [
        `const common = { timeout: 5 };`,
        `const withBase = { ...common, baseURL: '/api' };`,
        `const directWins = axios.create({ ...withBase, baseURL: '/v2' });`,
        `const spreadWins = axios.create({ baseURL: '/v2', ...withBase });`,
        `directWins.get('/v1/x');`,
        `spreadWins.get('/v1/x');`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls('src/a.ts', files.get('src/a.ts') ?? '', { clientSymbols: ['directWins', 'spreadWins'] }, files);
    expect(calls.unresolved).toEqual([]);
    expect(calls.calls.map((call) => `${call.canonicalPath} [${call.joinedBaseURL}]`).sort()).toEqual([
      // JavaScript object semantics: the later writer of baseURL prevails.
      '/api/v1/x [/api]',
      '/v2/v1/x [/v2]',
    ]);
  });

  it('never joins a non-literal base: env-dependent bases behave exactly as without the feature', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [
        `const env = axios.create({ baseURL: process.env.API_URL });`,
        `const templated = axios.create({ baseURL: \`\${process.env.API_URL}/api\` });`,
        `env.get('/v1/x');`,
        `templated.get('/v1/x');`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls('src/a.ts', files.get('src/a.ts') ?? '', { clientSymbols: ['env', 'templated'] }, files);
    // Typed resolved emission, paths unchanged, no new blockers.
    expect(calls.unresolved).toEqual([]);
    expect(calls.calls.map((call) => `${call.canonicalPath} [${call.joinedBaseURL ?? '-'}]`).sort()).toEqual([
      '/v1/x [-]',
      '/v1/x [-]',
    ]);
  });

  it('follows the existing absolute-URL rules: absolute call URLs ignore the base; absolute bases canonicalize via sameOriginHosts', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [
        `const api = axios.create({ baseURL: 'https://app.example.com/spa' });`,
        `api.get('/v1/x');`,
        `api.get('https://app.example.com/v2/y');`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls(
      'src/a.ts',
      files.get('src/a.ts') ?? '',
      { clientSymbols: ['api'], sameOriginHosts: ['app.example.com'] },
      files,
    );
    expect(calls.unresolved).toEqual([]);
    expect(calls.calls.map((call) => `${call.rawPath} -> ${call.canonicalPath}`).sort()).toEqual([
      // The absolute call URL keeps its own base (axios isAbsoluteURL).
      // (Sorted output; the literal-joined call sorts before 'https'.)
      '/v1/x -> /spa/v1/x',
      'https://app.example.com/v2/y -> /v2/y',
    ]);
  });

  it('joins config-object instance calls (api({...}) and api.request({...})) too', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [
        `const api = axios.create({ baseURL: '/api' });`,
        `api({ url: '/v1/session', method: 'POST' });`,
        `api.request({ url: '/v1/session' });`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls('src/a.ts', files.get('src/a.ts') ?? '', { clientSymbols: ['api'] }, files);
    expect(calls.unresolved).toEqual([]);
    expect(calls.calls.map((call) => `${call.method} ${call.canonicalPath}`).sort()).toEqual([
      'GET /api/v1/session',
      'POST /api/v1/session',
    ]);
  });

  it('keeps normalization identical for joined paths: slots stay positional (literal-precedence safe downstream)', () => {
    const files = new Map<string, string>([
      ['src/a.ts', [
        `const api = axios.create({ baseURL: '/api' });`,
        'api.get(`/v1/accounts/${id}`);',
      ].join('\n')],
    ]);
    const calls = scanClientCalls('src/a.ts', files.get('src/a.ts') ?? '', { clientSymbols: ['api'] }, files);
    expect(calls.unresolved).toEqual([]);
    const call = calls.calls[0];
    expect(call?.rawPath).toBe('/v1/accounts/${}');
    expect(call?.canonicalPath).toBe('/api/v1/accounts/{}');
  });

  it('fails closed: disagreeing or unprovable same-named creations veto the unique-declaration join', () => {
    const disagreeing = new Map<string, string>([
      ['src/lib/a.ts', `export const apiClient = axios.create({ baseURL: '/api' });\n`],
      ['src/lib/b.ts', `export const apiClient = axios.create({ baseURL: '/other' });\n`],
      ['src/app.ts', `import { apiClient } from '@/lib/a';\napiClient.get('/v1/x');\n`],
    ]);
    const vetoed = scanClientCalls('src/app.ts', disagreeing.get('src/app.ts') ?? '', { clientSymbols: ['apiClient'] }, disagreeing);
    expect(vetoed.unresolved).toEqual([]);
    expect(vetoed.calls.map((call) => `${call.canonicalPath} [${call.joinedBaseURL ?? '-'}]`)).toEqual(['/v1/x [-]']);

    const unmodeled = new Map<string, string>([
      ['src/lib/a.ts', `export const apiClient = axios.create({ baseURL: '/api' });\n`],
      ['src/lib/b.ts', `export const apiClient = getClient();\n`],
      ['src/app.ts', `import { apiClient } from '@/lib/a';\napiClient.get('/v1/x');\n`],
    ]);
    const stillVetoed = scanClientCalls('src/app.ts', unmodeled.get('src/app.ts') ?? '', { clientSymbols: ['apiClient'] }, unmodeled);
    expect(stillVetoed.calls.map((call) => `${call.canonicalPath} [${call.joinedBaseURL ?? '-'}]`)).toEqual(['/v1/x [-]']);
  });

  it('never joins the bare axios global to a same-named creation in another file', () => {
    const files = new Map<string, string>([
      ['src/other.ts', `const axios = axios.create({ baseURL: '/api' });\naxios.get('/shadowed');\n`],
      ['src/app.ts', `axios.get('/v1/x');\n`],
    ]);
    const calls = scanClientCalls('src/app.ts', files.get('src/app.ts') ?? '', {}, files);
    expect(calls.unresolved).toEqual([]);
    // The global axios has no provable base; only the shadowing file's
    // own calls join (its creation is the binding there).
    expect(calls.calls.map((call) => call.canonicalPath)).toEqual(['/v1/x']);
    const shadowed = scanClientCalls('src/other.ts', files.get('src/other.ts') ?? '', {}, files);
    expect(shadowed.calls.map((call) => call.canonicalPath)).toEqual(['/api/shadowed']);
  });

  it('wrapper-wrapped instance calls keep today\u2019s emission (documented boundary: wrappers do not join instance bases)', () => {
    const files = new Map<string, string>([
      ['src/wrap.ts', [
        `const api = axios.create({ baseURL: '/api' });`,
        `const apiGet = (path: string) => api.get(path);`,
        `apiGet('/v1/x');`,
      ].join('\n')],
    ]);
    const calls = scanClientCalls(
      'src/wrap.ts',
      files.get('src/wrap.ts') ?? '',
      { clientSymbols: ['api'], wrapperFunctions: [{ name: 'apiGet', method: 'GET' }] },
      files,
    );
    expect(calls.unresolved).toEqual([]);
    expect(calls.calls.map((call) => `${call.canonicalPath} [${call.joinedBaseURL ?? '-'}]`)).toEqual(['/v1/x [-]']);
  });
});

describe('detector integration: baseURL joining (phase 3 dogfood)', () => {
  it('emits the joined path as normalizedPath while rawPath stays as written; without a base, output is byte-identical to before', () => {
    const withBase = project({
      'frontend/src/lib/apiClient.ts': `export const apiClient = axios.create({ baseURL: '/api' });\n`,
      'frontend/src/me.ts': `import { apiClient } from '@/lib/apiClient';\nawait apiClient.get('/v1/employee-roles/me/roles');\n`,
    });
    const withoutBase = project({
      'frontend/src/lib/apiClient.ts': `export const apiClient = axios.create({});\n`,
      'frontend/src/me.ts': `import { apiClient } from '@/lib/apiClient';\nawait apiClient.get('/v1/employee-roles/me/roles');\n`,
    });
    try {
      const joined = createHttpDetector({ root: withBase, clientScan: { clientSymbols: ['apiClient'] } }).discover(['frontend']);
      expect(frontendFacts(joined)).toEqual(['GET /api/v1/employee-roles/me/roles']);
      const fact = joined.resources[0];
      expect(fact?.attributes['rawPath']).toBe('/v1/employee-roles/me/roles');
      expect(fact?.attributes['normalizedPath']).toBe('/api/v1/employee-roles/me/roles');
      expect(joined.unresolved).toEqual([]);

      // Back-compat control: an instance with no baseURL anywhere emits
      // exactly the pre-feature fact.
      const plain = createHttpDetector({ root: withoutBase, clientScan: { clientSymbols: ['apiClient'] } }).discover(['frontend']);
      expect(frontendFacts(plain)).toEqual(['GET /v1/employee-roles/me/roles']);
      expect(plain.unresolved).toEqual([]);
    } finally {
      rmSync(withBase, { recursive: true, force: true });
      rmSync(withoutBase, { recursive: true, force: true });
    }
  });

  it('composes with clientScanRoots: e2e mock instances outside the roots cannot poison or veto the product join', () => {
    const dir = project({
      'frontend/src/lib/apiClient.ts': `export const apiClient = axios.create({ baseURL: '/api' });\n`,
      'frontend/src/app.ts': `import { apiClient } from '@/lib/apiClient';\nawait apiClient.get('/v1/x');\n`,
      // Harness mock instance with a DIFFERENT base: outside the product
      // scan roots it is invisible to the join.
      'e2e/helpers/api.ts': `export const apiClient = axios.create({ baseURL: '/mock' });\n`,
    });
    try {
      const scoped = createHttpDetector({
        root: dir,
        clientScan: { clientScanRoots: ['frontend/**'], clientSymbols: ['apiClient'] },
      }).discover(['frontend', 'e2e']);
      expect(frontendFacts(scoped)).toEqual(['GET /api/v1/x']);
      expect(scoped.unresolved).toEqual([]);

      // Without roots the harness instance is product-class by the
      // pre-existing contract — its disagreement vetoes the join (fail
      // closed), never silently picks a side.
      const unscoped = createHttpDetector({ root: dir, clientScan: { clientSymbols: ['apiClient'] } }).discover(['frontend', 'e2e']);
      expect(frontendFacts(unscoped)).toEqual(['GET /v1/x']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
