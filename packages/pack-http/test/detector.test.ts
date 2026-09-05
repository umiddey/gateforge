/**
 * Detector suite for the generic HTTP exposure pack (plan phase 4):
 * route/controller/client-call discovery, contract-fact emission, and
 * phase-4 signal hygiene — the pack mints NO classification signals
 * (path-derived targets were STALE_SIGNAL_TARGET noise; see
 * classifier-linkage.test.ts for the classification fallback proof).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpDetector } from '../src/index.js';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-pack-http-'));
  for (const [rel, text] of Object.entries(files)) {
    const absolute = join(dir, rel);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true });
    writeFileSync(absolute, text);
  }
  return dir;
}

describe('path-derived targets emit NO signals (dogfood remediation phase 4)', () => {
  // Red/green: the pre-phase-4 pack minted `exposure` + `lifecycle.<op>`
  // signals targeted at the path-derived resource name here ('accounts',
  // 'refunds', 'session', 'users'), every one a guess that mostly named no
  // discovered resource and surfaced as STALE_SIGNAL_TARGET noise.
  it('a route whose derived name matches no model emits no signal at all', () => {
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
      // Old code emitted exposure:accounts / lifecycle.*:accounts /
      // exposure:refunds / exposure:session here. Now: silence — the
      // CLI endpoint compiler owns route→resource linkage.
      expect(outcome.classificationSignals).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('frontend calls whose derived names match no model emit no signal either', () => {
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
      // Old code emitted exposure:frontend-call + lifecycle.* targeted at
      // 'accounts' from these very callsites. Now: silence.
      expect(outcome.classificationSignals).toEqual([]);
      // The contract facts still flow to the endpoint compiler.
      const methods = outcome.resources
        .map((resource) => resource.attributes['method'])
        .sort();
      expect(methods).toEqual(['DELETE', 'GET', 'POST']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('detector: route and client-call discovery', () => {
  it('discovers express/fastify/hono routes and nestjs controllers as contract facts', async () => {
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
      // No classification signals at all (phase 4): the underivable '/'
      // route never had one, and the derivable ones lost their guesses.
      expect(outcome.classificationSignals).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers frontend fetch/axios calls as frontend-call contract facts', async () => {
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
      const facts = outcome.resources.filter(
        (resource) => resource.attributes['role'] === 'frontend-call',
      );
      expect(facts).toHaveLength(3);
      for (const fact of facts) {
        expect(fact.kind).toBe('http.contract');
      }
      // No signals (phase 4): exposure defaults user-facing without them.
      expect(outcome.classificationSignals).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not classify configured client symbols as server routers', () => {
    const dir = project({
      'web/api.ts': [
        `import api from './authFetch';`,
        `export const loadAccounts = () => api.get('/api/accounts');`,
      ].join('\n'),
    });
    try {
      const detector = createHttpDetector({
        root: dir,
        clientScan: { clientSymbols: ['api'] },
      });
      const outcome = detector.discover(['web/api.ts']);
      expect(outcome.resources).toHaveLength(1);
      expect(outcome.resources[0]?.attributes['role']).toBe('frontend-call');
      expect(outcome.resources[0]?.attributes['method']).toBe('GET');
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

  it('skips symlinks when resolving directory inputs (never scans outside the tree)', async () => {
    const dir = project({
      'src/real.ts': `import express from 'express';\nconst app = express();\napp.get('/api/real', () => {});\n`,
      'vendor/ghost.ts': `import express from 'express';\nconst app = express();\napp.get('/api/ghost', () => {});\n`,
    });
    symlinkSync(join(dir, 'missing-target'), join(dir, 'src', 'dangling.ts'));
    symlinkSync(join(dir, 'vendor'), join(dir, 'src', 'linked'));
    symlinkSync(join(dir, 'vendor', 'ghost.ts'), join(dir, 'src', 'top-link.ts'));
    try {
      const detector = createHttpDetector({ root: dir });
      const outcome = detector.discover(['src']);
      // Only the repo's real file is scanned: symlinked dirs are not
      // recursed, symlinked files are not collected, dangling links are
      // not errors (mirrors the CLI walker's scope-integrity rule).
      expect(outcome.scannedPaths).toEqual(['src/real.ts']);
      // Only the real file produced a fact (and no signals exist at all).
      const factFiles = outcome.resources.map((resource) => resource.location.file);
      expect(factFiles).toEqual(['src/real.ts']);
      expect(outcome.classificationSignals).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
