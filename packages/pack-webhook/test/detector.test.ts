/**
 * Detector unit suite: walks each surface's fixture and asserts the
 * resource graph carries the expected ids, attributes, and findings.
 *
 * Determinism: the suite asserts ids and resource order are stable
 * across repeated runs (no `Date.now` / `Math.random` in the detector).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClassificationSignalSchema, ResourceSchema } from '@gateforge/core';
import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
import { createWebhookDetector } from '../src/index.js';

/** Absolute dir of this pack's test fixtures. */
const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures', import.meta.url));

/** Scan every fixture. */
function scan(): DiscoveryOutcome {
  return createWebhookDetector({ root: FIXTURE_ROOT }).discover([FIXTURE_ROOT]);
}

describe('pack-webhook detector: Express', () => {
  it('discovers webhook-shaped paths and assigns correct provider', () => {
    const outcome = scan();
    const expr = outcome.resources.filter((r) => r.attributes['framework'] === 'express');
    expect(expr.length).toBeGreaterThanOrEqual(4);
    for (const r of expr) expect(ResourceSchema.safeParse(r).success).toBe(true);
    const stripe = expr.find((r) => r.attributes['path'] === '/webhook/stripe/payments');
    expect(stripe).toBeDefined();
    expect(stripe?.attributes['signatureAlgorithm']).toBe('hmac-sha256');
    expect(stripe?.attributes['signatureHeader']).toBe('x-signature');
    expect(stripe?.attributes['provider']).toBe('stripe');
    expect(stripe?.attributes['httpMethods']).toEqual(['POST']);
    expect(stripe?.attributes['replayWindow']).toBe(300_000);
    expect(stripe?.attributes['maxBody']).toBe(1_048_576);
  });

  it('discovers /hook/slack and /callback/partner variants', () => {
    const outcome = scan();
    const slack = outcome.resources.find((r) => r.id === 'webhook.slack.events');
    expect(slack).toBeDefined();
    const partner = outcome.resources.find((r) => r.id === 'webhook.partner.order');
    expect(partner).toBeDefined();
  });
});

describe('pack-webhook detector: Fastify', () => {
  it('discovers webhook paths in fastify.METHOD(...)', () => {
    const outcome = scan();
    const ff = outcome.resources.filter((r) => r.attributes['framework'] === 'fastify');
    expect(ff.length).toBeGreaterThanOrEqual(2);
    const payments = ff.find((r) => r.attributes['path'] === '/webhook/fastify/payments');
    expect(payments).toBeDefined();
    expect((payments?.attributes['httpMethods'] as string[])).toContain('POST');
  });
});

describe('pack-webhook detector: Hono', () => {
  it('discovers webhook paths in hono app.METHOD(...)', () => {
    const outcome = scan();
    const h = outcome.resources.filter((r) => r.attributes['framework'] === 'hono');
    expect(h.length).toBeGreaterThanOrEqual(1);
    const payments = h.find((r) => r.attributes['path'] === '/webhook/hono/payments');
    expect(payments).toBeDefined();
  });
});

describe('pack-webhook detector: Decorator', () => {
  it('discovers @webhook(...) and @on(\'webhook.x\') decorators', () => {
    const outcome = scan();
    const dec = outcome.resources.filter((r) => r.attributes['framework'] === 'decorator');
    expect(dec.length).toBeGreaterThanOrEqual(2);
    const stripe = dec.find((r) => r.attributes['provider'] === 'stripe.payments');
    expect(stripe).toBeDefined();
    const github = dec.find((r) => r.attributes['provider'] === 'github.push');
    expect(github).toBeDefined();
  });
});

describe('pack-webhook detector: determinism + cleanup', () => {
  it('emits no resources for files without webhook-shaped paths', () => {
    const outcome = createWebhookDetector({ root: FIXTURE_ROOT }).discover([
      fileURLToPath(new URL('../fixtures/ambiguous.path.ts', import.meta.url)),
    ]);
    expect(outcome.resources).toEqual([]);
    expect(outcome.findings).toEqual([]);
  });

  it('returns a stable ordering on repeated scans', () => {
    const a = scan();
    const b = scan();
    expect(a.resources.map((r) => r.id)).toEqual(b.resources.map((r) => r.id));
  });

  it('every emitted resource validates against ResourceSchema', () => {
    const outcome = scan();
    for (const r of outcome.resources) {
      const result = ResourceSchema.safeParse(r);
      expect(result.success).toBe(true);
    }
  });
});
describe('webhook detector — classification signals (plan phase 4)', () => {
  it('emits one code-positive exposure signal per endpoint, path-derived', () => {
    const outcome = createWebhookDetector({ root: FIXTURE_ROOT }).discover([FIXTURE_ROOT]);
    expect(outcome.classificationSignals.length).toBeGreaterThan(0);
    for (const signal of outcome.classificationSignals) {
      expect(signal.dimension).toBe('exposure');
      expect(signal.assertion).toBe('webhook');
      expect(signal.basis).toBe('code-positive');
      expect(signal.target.resourceName).toBeTruthy();
      expect(ClassificationSignalSchema.safeParse(signal).success).toBe(true);
    }
  });
});
