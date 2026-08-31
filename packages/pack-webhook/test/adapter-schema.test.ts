/**
 * Adapter-schema unit suite: exercises the validate* helpers on the
 * frozen entity-adapter contract.
 */
import { describe, expect, it } from 'vitest';
import {
  validateWebhookEntityAdapter,
  WebhookEntityAdapterSchema,
} from '../src/adapter-schema.js';

describe('pack-webhook adapter schema', () => {
  it('accepts a fully-typed adapter', () => {
    const adapter = {
      resourceId: 'webhook.stripe.payments',
      deletion: 'archive' as const,
      environmentFingerprint: 'example-webhook-v1',
      read: async () => ({ ok: true }),
      normalize: () => ({ entityId: 'evt_1', fields: { status: 'ok' } }),
    };
    const result = validateWebhookEntityAdapter(adapter);
    expect(result.ok).toBe(true);
  });

  it('rejects a missing read function with a single-cause diagnostic', () => {
    const adapter = {
      resourceId: 'webhook.stripe.payments',
      deletion: 'archive' as const,
      environmentFingerprint: 'example-webhook-v1',
      normalize: () => ({ entityId: 'x', fields: {} }),
    };
    const result = validateWebhookEntityAdapter(adapter);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.startsWith('read:'))).toBe(true);
    }
  });

  it('rejects unknown deletion mode', () => {
    const parsed = WebhookEntityAdapterSchema.safeParse({
      resourceId: 'x',
      deletion: 'soft',
      environmentFingerprint: 'f',
      read: () => {},
      normalize: () => ({}),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects extra fields via strict()', () => {
    const parsed = WebhookEntityAdapterSchema.safeParse({
      resourceId: 'x',
      deletion: 'archive',
      environmentFingerprint: 'f',
      read: () => {},
      normalize: () => ({}),
      extra: 'no',
    });
    expect(parsed.success).toBe(false);
  });
});