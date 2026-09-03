/**
 * Detector suite for the generic HTTP exposure pack (plan phase 4):
 * route/controller/client-call discovery, path-derived resource names,
 * signal emission, and fail-closed signal hygiene.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassificationSignalSchema } from '@gateforge/core';
import { createHttpDetector, resourceNameFromPath } from '../src/index.js';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-pack-http-'));
  for (const [rel, text] of Object.entries(files)) {
    const absolute = join(dir, rel);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true });
    writeFileSync(absolute, text);
  }
  return dir;
}

describe('resourceNameFromPath (path-derived identity)', () => {
  it('derives the last non-parameter segment, lower-cased, extension-stripped', () => {
    expect(resourceNameFromPath('/api/accounts')).toBe('accounts');
    expect(resourceNameFromPath('/api/accounts/:id')).toBe('accounts');
    expect(resourceNameFromPath('/accounts/{id}/orders/{orderNo}')).toBe('orders');
    expect(resourceNameFromPath('/api/users.json')).toBe('users');
    expect(resourceNameFromPath('/API/Accounts/')).toBe('accounts');
    expect(resourceNameFromPath('/billing/refunds?limit=5')).toBe('refunds');
  });

  it('returns null for underivable paths (never guesses a target)', () => {
    expect(resourceNameFromPath('/')).toBe(null);
    expect(resourceNameFromPath('/:id')).toBe(null);
    expect(resourceNameFromPath('/api/accounts/9')).toBe('accounts');
    expect(resourceNameFromPath('/*')).toBe(null);
    expect(resourceNameFromPath('/{id}')).toBe(null);
  });
});

describe('detector: route and client-call discovery', () => {
  it('discovers express/fastify/hono routes and nestjs controllers with signals', async () => {
    const dir = project({
      'src/express-app.ts': [
        `import express from 'express';`,
        `const app = express();`,
        `app.get('/api/accounts', (req, res) => res.json({}));`,
        `app.post('/api/accounts', (req, res) => res.json({}));`,
        `app.delete('/api/accounts/:id', (req, res) => res.json({}));`,
        `app.get('/', (req, res) => res.json({}));`,
        `app.all('/api/session', (req, res) => res.json({}));`,
      ].join('\n'),
      'src/nest-controller.ts': [
        `import { Controller, Get, Post } from '@nestjs/common';`,
        `@Controller('billing')`,
        `export class BillingController {`,
        `  @Get('refunds')`,
        `  listRefunds() { return []; }`,
        `  @Post()`,
        `  create() { return {}; }`,
        `}`,
      ].join('\n'),
    });
    try {
      const detector = createHttpDetector({ root: dir });
      const outcome = detector.discover(['src']);
      // Routes are EVIDENCE, not business resources (red-team round 2,
      // superseded by ADR 0004 D1): the pack emits `http.contract`
      // evidence facts only — never a business resource carrying the
      // path-derived bare name, which is what collided with the converged
      // table at the same plane-qualified id.
      for (const resource of outcome.resources) {
        expect(resource.kind).toBe('http.contract');
        expect(resource.attributes['resourceName']).toBeUndefined();
        expect(resource.attributes['role']).toBe('server-route');
      }
      expect(outcome.resources.length).toBeGreaterThanOrEqual(6);
      const signalTargets = outcome.classificationSignals.map(
        (s) => `${s.dimension}:${s.target.resourceName ?? ''}`,
      );
      // Express GET /api/accounts: exposure + lifecycle.read; POST/DELETE
      // add create/delete. NestJS prefix + suffix join under 'refunds'.
      expect(signalTargets).toContain('exposure:accounts');
      expect(signalTargets).toContain('lifecycle.read:accounts');
      expect(signalTargets).toContain('lifecycle.create:accounts');
      expect(signalTargets).toContain('lifecycle.delete:accounts');
      expect(signalTargets).toContain('exposure:refunds');
      // The underivable '/' route emits NO signal.
      expect(signalTargets).not.toContain('exposure:');
      // app.all asserts exposure but no lifecycle.
      expect(signalTargets.filter((t) => t.endsWith(':session'))).toEqual(['exposure:session']);
      // The artifact facts live in the signal locations (route file, exact line).
      const refundsSignal = outcome.classificationSignals.find(
        (s) => s.dimension === 'exposure' && s.target.resourceName === 'refunds',
      );
      expect(refundsSignal?.location.file).toBe('src/nest-controller.ts');
      expect(refundsSignal?.assertion).toBe('route');
      // Every signal validates against the frozen core schema.
      for (const signal of outcome.classificationSignals) {
        expect(ClassificationSignalSchema.safeParse(signal).success).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers frontend fetch/axios calls as frontend-call exposure', async () => {
    const dir = project({
      'web/client.ts': [
        `const res = await fetch('/api/accounts');`,
        `await axios.post('/api/accounts', body);`,
        `await axios.delete('/api/accounts/9');`,
      ].join('\n'),
    });
    try {
      const detector = createHttpDetector({ root: dir });
      const outcome = detector.discover(['web/client.ts']);
      const exposures = outcome.classificationSignals.filter((s) => s.dimension === 'exposure');
      expect(exposures).toHaveLength(3);
      for (const exposure of exposures) {
        expect(exposure.assertion).toBe('frontend-call');
        expect(exposure.target.resourceName).toBe('accounts');
      }
      const ops = outcome.classificationSignals
        .filter((s) => s.dimension.startsWith('lifecycle.'))
        .map((s) => s.dimension);
      expect(ops.sort()).toEqual(['lifecycle.create', 'lifecycle.delete', 'lifecycle.read']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic across runs and over an empty path list', async () => {
    const dir = project({
      'src/a.ts': `import express from 'express';\nconst app = express();\napp.get('/x/y', () => {});\n`,
    });
    try {
      const detector = createHttpDetector({ root: dir });
      const first = detector.discover(['src']);
      const second = detector.discover(['src']);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(detector.discover([])).toEqual({
        resources: [],
        unresolved: [],
        findings: [],
        classificationSignals: [],
        scannedPaths: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
