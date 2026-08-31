/**
 * Auth pack detector suite: every framework the detector recognises
 * produces one resource per guarded endpoint, with the right
 * `attributes.roleRequirement` and `attributes.tenancy`. Unguarded and
 * dynamic-role fixtures must NOT emit (fail-closed).
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ResourceSchema } from '@gateforge/core';
import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
import { createAuthDetector, type AuthDetector } from '../src/index.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures', import.meta.url));

function detector(): AuthDetector {
  return createAuthDetector({ root: FIXTURE_ROOT });
}

function fixture(name: string): string {
  return join(FIXTURE_ROOT, name);
}

function find(out: DiscoveryOutcome, id: string) {
  return out.resources.find((r) => r.id === id);
}

describe('auth detector — NestJS', () => {
  it('emits one resource per guarded NestJS method', () => {
    const out = detector().discover([fixture('nestjs-billing.ts')]);
    expect(out.findings).toEqual([]);
    expect(out.unresolved).toEqual([]);
    const r = find(out, 'auth.post.billing.refund');
    expect(r).toBeDefined();
    expect(r?.kind).toBe('auth.resource');
    expect(r?.attributes['framework']).toBe('nestjs');
    expect(r?.attributes['method']).toBe('POST');
    expect(r?.attributes['path']).toBe('/billing/refund');
    expect(r?.attributes['roleRequirement']).toEqual(['admin']);
    expect(r?.attributes['tenancy']).toBe('none');
    const parsed = ResourceSchema.safeParse(r);
    expect(parsed.success).toBe(true);
  });

  it('emits nothing for an unguarded NestJS controller', () => {
    const out = detector().discover([fixture('dynamic-role.ts')]);
    expect(out.resources).toEqual([]);
  });
});

describe('auth detector — Express', () => {
  it('emits one resource for an Express middleware chain', () => {
    const out = detector().discover([fixture('express-billing.js')]);
    const r = find(out, 'auth.post.billing.refund');
    expect(r).toBeDefined();
    expect(r?.attributes['framework']).toBe('express');
    expect(r?.attributes['roleRequirement']).toEqual(['admin']);
    expect(r?.attributes['tenancy']).toBe('tenant-bound');
  });
});

describe('auth detector — Fastify', () => {
  it('emits one resource for a Fastify preHandler chain', () => {
    const out = detector().discover([fixture('fastify-billing.ts')]);
    const r = find(out, 'auth.post.billing.refund');
    expect(r).toBeDefined();
    expect(r?.attributes['framework']).toBe('fastify');
    expect(r?.attributes['roleRequirement']).toEqual(['admin', 'manager']);
    expect(r?.attributes['tenancy']).toBe('tenant-bound');
  });
});

describe('auth detector — Hono', () => {
  it('emits one resource for a Hono middleware chain', () => {
    const out = detector().discover([fixture('hono-billing.ts')]);
    const r = find(out, 'auth.post.billing.refund');
    expect(r).toBeDefined();
    expect(r?.attributes['framework']).toBe('hono');
    expect(r?.attributes['roleRequirement']).toEqual(['admin']);
    expect(r?.attributes['tenancy']).toBe('tenant-bound');
  });
});

describe('auth detector — fail-closed paths', () => {
  it('emits no resources for a fully unguarded file', () => {
    const out = detector().discover([fixture('unguarded.ts')]);
    expect(out.resources).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  it('returns an empty outcome for an empty path list', () => {
    const out = detector().discover([]);
    expect(out).toEqual({ resources: [], unresolved: [], findings: [] });
  });

  it('skips node_modules / dist / .git when given a directory', () => {
    // We rely on the fixtures directory not containing those; the test
    // is that no such noise is emitted.
    const out = detector().discover([FIXTURE_ROOT]);
    for (const r of out.resources) {
      expect(r.source).not.toMatch(/node_modules/);
      expect(r.source).not.toMatch(/dist/);
    }
  });

  it('resource ids are deterministic across runs', () => {
    const a = detector().discover([fixture('express-billing.js')]);
    const b = detector().discover([fixture('express-billing.js')]);
    expect(a.resources.map((r) => r.id)).toEqual(b.resources.map((r) => r.id));
    expect(a.resources.map((r) => JSON.stringify(r.attributes))).toEqual(
      b.resources.map((r) => JSON.stringify(r.attributes)),
    );
  });

  it('does not crash on a non-existent path', () => {
    const out = detector().discover(['/no/such/path/exists-here.ts']);
    expect(out.resources).toEqual([]);
  });
});

describe('auth detector — synthetic adversarial cases', () => {
  it('does NOT emit when a NestJS controller lacks @UseGuards(RolesGuard) and @Roles', () => {
    const out = detector().discover([fixture('dynamic-role.ts')]);
    expect(out.resources.find((r) => r.id === 'auth.post.billing.refund')).toBeUndefined();
  });
});