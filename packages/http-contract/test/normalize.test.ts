/**
 * Phase 0 engine tests: the canonical HTTP contract schema and
 * normalization rules (ADR 0004 D1/D2/D4). Deterministic and offline.
 */
import { describe, expect, it } from 'vitest';
import {
  HTTP_BLOCK_CODES,
  HTTP_CONTRACT_KIND,
  HTTP_ENDPOINT_KIND,
  HTTP_METHOD_DYNAMIC,
  HTTP_PARAM_SLOT,
  HTTP_PATH_DYNAMIC,
  HTTP_WILDCARD_SLOT,
  HttpContractFactSchema,
  normalizeHttpMethod,
  normalizeHttpPath,
  pathSegments,
} from '../src/index.js';

function fact(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    role: 'server-route',
    method: 'GET',
    normalizedPath: '/api/v1/accounts/{}',
    rawPath: '/api/v1/accounts/{account_id}',
    framework: 'fastapi',
    source: { file: 'backend/api.py', line: 12, col: 4 },
    ...overrides,
  };
}

describe('http contract fact schema', () => {
  it('accepts a strict valid fact', () => {
    const parsed = HttpContractFactSchema.safeParse(fact());
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    const parsed = HttpContractFactSchema.safeParse(fact({ confidence: 0.9 }));
    expect(parsed.success).toBe(false);
  });

  it('rejects foreign schema versions', () => {
    expect(HttpContractFactSchema.safeParse(fact({ schemaVersion: 2 })).success).toBe(false);
    expect(HttpContractFactSchema.safeParse(fact({ schemaVersion: '1' })).success).toBe(false);
  });

  it('rejects unknown methods and roles', () => {
    expect(HttpContractFactSchema.safeParse(fact({ method: 'FETCH' })).success).toBe(false);
    expect(HttpContractFactSchema.safeParse(fact({ role: 'middleware' })).success).toBe(false);
  });

  it('rejects malformed locations', () => {
    expect(HttpContractFactSchema.safeParse(fact({ source: { file: 'a.py', line: 0, col: 0 } })).success).toBe(
      false,
    );
    expect(HttpContractFactSchema.safeParse(fact({ source: { file: '', line: 1, col: 0 } })).success).toBe(
      false,
    );
  });
});

describe('canonical path normalization', () => {
  it('is invariant under parameter-name changes', () => {
    const a = normalizeHttpPath('/api/v1/accounts/{account_id}');
    const b = normalizeHttpPath('/api/v1/accounts/{id}');
    const c = normalizeHttpPath('/api/v1/accounts/{item_uid:int}');
    expect(a).toEqual({ ok: true, canonical: '/api/v1/accounts/{}', hasParameters: true });
    expect(b.ok && b.canonical).toBe('/api/v1/accounts/{}');
    expect(c.ok && c.canonical).toBe('/api/v1/accounts/{}');
  });

  it('strips query and fragment, collapses slashes, strips trailing slashes', () => {
    expect(normalizeHttpPath('/api/accounts?limit=5&page=2')).toMatchObject({
      ok: true,
      canonical: '/api/accounts',
    });
    expect(normalizeHttpPath('/api/accounts#fragment')).toMatchObject({
      ok: true,
      canonical: '/api/accounts',
    });
    expect(normalizeHttpPath('//api///accounts///')).toMatchObject({
      ok: true,
      canonical: '/api/accounts',
    });
    expect(normalizeHttpPath('/')).toMatchObject({ ok: true, canonical: '/' });
  });

  it('treats a single trailing slash as insignificant on BOTH routes and calls (dogfood regression)', () => {
    // Runtime frameworks treat `/api/v2/accounts` and `/api/v2/accounts/`
    // as the same resource; the canonical form must mirror that so the
    // static join never misses on the spelling. The root `/` is the bare
    // resource and stays.
    expect(normalizeHttpPath('/v2/accounts/')).toMatchObject({
      ok: true,
      canonical: '/v2/accounts',
    });
    expect(normalizeHttpPath('/api/v2/accounts/')).toMatchObject({
      ok: true,
      canonical: '/api/v2/accounts',
    });
    expect(normalizeHttpPath('/health/')).toMatchObject({ ok: true, canonical: '/health' });
    expect(normalizeHttpPath('/')).toMatchObject({ ok: true, canonical: '/' });
  });

  it('converts template expressions to positional slots', () => {
    expect(normalizeHttpPath('/accounts/${account.id}')).toMatchObject({
      ok: true,
      canonical: `/accounts/${HTTP_PARAM_SLOT}`,
    });
    expect(normalizeHttpPath('/files/${pathSegments.join("/")}')).toMatchObject({
      ok: true,
      canonical: `/files/${HTTP_PARAM_SLOT}`,
    });
  });

  it('keeps query characters inside templates but strips literal tails', () => {
    // `${q ? '?x=1' : ''}` — the literal '?' lies inside the template, so
    // the slot survives; a literal query tail is stripped.
    expect(normalizeHttpPath('/search/${q}?scope=all')).toMatchObject({
      ok: true,
      canonical: '/search/{}',
    });
  });

  it('converts FastAPI path converters and catch-alls to the wildcard slot', () => {
    expect(normalizeHttpPath('/files/{file_path:path}')).toMatchObject({
      ok: true,
      canonical: `/files/${HTTP_WILDCARD_SLOT}`,
    });
    expect(normalizeHttpPath('/static/*')).toMatchObject({
      ok: true,
      canonical: `/static/${HTTP_WILDCARD_SLOT}`,
    });
  });

  it('canonicalizes absolute URLs only for configured same-origin hosts', () => {
    expect(normalizeHttpPath('https://app.example.com/api/v1/accounts', {
      sameOriginHosts: ['app.example.com'],
    })).toMatchObject({ ok: true, canonical: '/api/v1/accounts' });

    const foreign = normalizeHttpPath('https://evil.example.com/api/v1/accounts', {
      sameOriginHosts: ['app.example.com'],
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe(HTTP_PATH_DYNAMIC);
  });

  it('rejects unresolvable shapes with the typed dynamic outcome', () => {
    for (const raw of ['', 'accounts', '/a/../b', '/x/' + '${'.repeat(0) + '{}{']) {
      const result = normalizeHttpPath(raw);
      if (!result.ok) {
        expect(result.code).toBe(HTTP_PATH_DYNAMIC);
        expect(result.detail.length).toBeGreaterThan(0);
      }
    }
    expect(normalizeHttpPath('accounts').ok).toBe(false);
    expect(normalizeHttpPath('/a/../b').ok).toBe(false);
  });

  it('preserves segment structure for the join engine', () => {
    expect(pathSegments('/api/v1/accounts/{}')).toEqual(['api', 'v1', 'accounts', '{}']);
    expect(pathSegments('/')).toEqual([]);
  });
});

describe('method normalization', () => {
  it('uppercases concrete verbs', () => {
    expect(normalizeHttpMethod('get')).toBe('GET');
    expect(normalizeHttpMethod(' Delete ')).toBe('DELETE');
  });

  it('maps catch-all forms to ANY', () => {
    expect(normalizeHttpMethod('any')).toBe('ANY');
    expect(normalizeHttpMethod('*')).toBe('ANY');
  });

  it('returns null for dynamic methods — never a GET default', () => {
    expect(normalizeHttpMethod('methodVar')).toBeNull();
    expect(normalizeHttpMethod('')).toBeNull();
    expect(normalizeHttpMethod('TRACE')).toBeNull();
    expect(HTTP_METHOD_DYNAMIC).toBe('HTTP_METHOD_DYNAMIC');
  });
});

describe('resource-kind separation', () => {
  it('keeps contract facts and endpoints in distinct evidence-only namespaces', () => {
    // Neither kind may ever equal a business resource kind; the graph
    // builder excludes contract facts from business classification and the
    // endpoint compiler owns the endpoint kind.
    expect(HTTP_CONTRACT_KIND).toBe('http.contract');
    expect(HTTP_ENDPOINT_KIND).toBe('http.endpoint');
    expect(HTTP_CONTRACT_KIND).not.toBe('sqlalchemy.table');
    expect(HTTP_ENDPOINT_KIND).not.toBe(HTTP_CONTRACT_KIND);
  });

  it('exposes the full typed code set', () => {
    expect(HTTP_BLOCK_CODES).toHaveLength(10);
    expect(new Set(HTTP_BLOCK_CODES).size).toBe(HTTP_BLOCK_CODES.length);
  });
});
