/**
 * Entity-adapter suite: the pack's schema + validator against the
 * shipped sample adapter (the example app accounts resource), plus the
 * fail-closed rejection paths.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { validateEntityAdapter } from '../src/index.js';

/** The sample adapter shipped with the pack (doc + sample only). */
const SAMPLE_ADAPTER_PATH = fileURLToPath(
  new URL('../examples/example.accounts.adapter.mjs', import.meta.url),
);

describe('entity-adapter schema + sample adapter', () => {
  it('validates the shipped example adapter against the contract', async () => {
    const mod = (await import(SAMPLE_ADAPTER_PATH)) as { default: unknown };
    const validation = validateEntityAdapter(mod.default);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.adapter.resourceId).toBe('example.accounts');
    expect(validation.adapter.deletion).toBe('archive'); // the app archives; no hard delete
    expect(validation.adapter.environmentFingerprint).toBe('example-loopback-v1');
  });

  it('normalize projects the raw body onto { entityId, fields }', async () => {
    const mod = (await import(SAMPLE_ADAPTER_PATH)) as {
      default: { normalize: (body: unknown) => unknown };
    };
    const normalized = mod.default.normalize({
      id: 'acc-1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      status: 'archived',
      created_at: '2026-08-30T20:27:43.188Z',
      updated_at: '2026-08-30T20:27:55.802Z',
    });
    expect(normalized).toEqual({
      entityId: 'acc-1',
      fields: { id: 'acc-1', status: 'archived' },
    });
  });

  it('rejects adapters missing data fields fail-closed', () => {
    const validation = validateEntityAdapter({
      read: async () => null,
      normalize: () => ({ entityId: 'x', fields: {} }),
      deletion: 'hard',
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.join(' ')).toContain('resourceId');
    expect(validation.issues.join(' ')).toContain('environmentFingerprint');
  });

  it('rejects adapters whose read/normalize are not functions', () => {
    const validation = validateEntityAdapter({
      resourceId: 'x',
      read: 'not-a-function',
      normalize: null,
      deletion: 'hard',
      environmentFingerprint: 'env-v1',
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.join(' ')).toContain('read');
    expect(validation.issues.join(' ')).toContain('normalize');
  });

  it('rejects an unknown deletion semantics value', () => {
    const validation = validateEntityAdapter({
      resourceId: 'x',
      read: async () => null,
      normalize: () => ({ entityId: 'x', fields: {} }),
      deletion: 'soft',
      environmentFingerprint: 'env-v1',
    } as unknown);
    expect(validation.ok).toBe(false);
  });
});