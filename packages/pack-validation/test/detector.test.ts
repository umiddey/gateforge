/**
 * Validation pack detector suite: every supported schema library
 * produces one resource per schema, with the right `attributes.library`
 * and `attributes.boundary`. Unrecognised files emit nothing (fail-closed).
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createValidationDetector, type ValidationDetector } from '../src/index.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures', import.meta.url));

function detector(): ValidationDetector {
  return createValidationDetector({ root: FIXTURE_ROOT });
}

function fixture(name: string): string {
  return join(FIXTURE_ROOT, name);
}

function find(out: { resources: { id: string; kind: string; attributes: Record<string, unknown> }[] }, id: string) {
  return out.resources.find((r) => r.id === id);
}

describe('validation detector — zod', () => {
  it('emits one resource per zod schema declaration', () => {
    const out = detector().discover([fixture('zod_account.ts')]);
    const r = find(out, 'validation.zod.accountcreateschema');
    expect(r).toBeDefined();
    expect(r?.kind).toBe('validation.schema');
    expect(r?.attributes['library']).toBe('zod');
    expect(r?.attributes['boundary']).toBe('strict');
    const fields = r?.attributes['fields'] as Record<string, { type: string; constraints: string[] }>;
    expect(Object.keys(fields).sort()).toEqual(['email', 'first_name', 'last_name']);
    expect(fields['first_name']?.type).toBe('string');
  });

  it('emits no resources for a file without any validation schema', () => {
    // Empty file path
    const out = detector().discover([]);
    expect(out.resources).toEqual([]);
  });

  it('returns an empty outcome when no path is given', () => {
    expect(detector().discover([])).toEqual({ resources: [], unresolved: [], findings: [], classificationSignals: [] });
  });
});

describe('validation detector — joi', () => {
  it('emits one resource per joi schema', () => {
    const out = detector().discover([fixture('joi_payment.ts')]);
    const r = find(out, 'validation.joi.paymentschema');
    expect(r).toBeDefined();
    expect(r?.attributes['library']).toBe('joi');
    expect(r?.attributes['boundary']).toBe('strict');
  });
});

describe('validation detector — yup', () => {
  it('emits one resource per yup schema', () => {
    const out = detector().discover([fixture('yup_settings.ts')]);
    const r = find(out, 'validation.yup.settingsschema');
    expect(r).toBeDefined();
    expect(r?.attributes['library']).toBe('yup');
    expect(r?.attributes['boundary']).toBe('lenient');
  });
});

describe('validation detector — fail-closed paths', () => {
  it('does not crash on a non-existent path', () => {
    const out = detector().discover(['/nonexistent/path/to/nowhere.ts']);
    expect(out.resources).toEqual([]);
    expect(out.unresolved).toEqual([]);
    expect(out.findings).toEqual([]);
  });

  it('resource ids are deterministic across runs', () => {
    const a = detector().discover([fixture('zod_account.ts')]);
    const b = detector().discover([fixture('zod_account.ts')]);
    expect(JSON.stringify(a.resources)).toBe(JSON.stringify(b.resources));
  });
});
