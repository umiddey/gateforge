/**
 * Linkage integration suite (plan phase 4 checklist): the pack's
 * classification signals flow through the core classifier's deterministic
 * lattice (`classifyResources`) together with sqlalchemy-shaped model
 * facts and worker-shaped internality evidence. Proves the chains:
 *
 *   - route (+ frontend-only) linkage marks a table user-facing and
 *     enables the observed operations;
 *   - a worker-only resource becomes internal ONLY with a complete scan
 *     and an explicit internal declaration + trusted category;
 *   - adding a route to a previously internal resource invalidates
 *     internality (conservative decision + blocking contradiction);
 *   - a parse finding in scope prevents internal classification;
 *   - links that cannot resolve block rather than guess
 *     (STALE_SIGNAL_TARGET for a route naming no discovered resource).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyResources,
  type ClassificationPolicy,
  type ClassifierResourceRef,
} from '@gateforge/core';
import { createHttpDetector } from '../src/index.js';

/** The org policy every scenario uses: sources + trusted worker category
 * + a coverage rule (a scan is only provably complete per detector). */
function policy(dir: string): ClassificationPolicy {
  return {
    schemaVersion: 1,
    scanRoots: [`${dir}/**`],
    trustedInternalEntryPoints: [
      { category: 'worker', patterns: ['**/workers/**'], detector: 'test.fixture-detector' },
    ],
    internalRules: [],
    coverage: [{ capability: 'exposure.http', exhaustive: true, detector: 'test.fixture-detector', appliesTo: [`${dir}/**`] }],
    declarations: { internality: 'gateforge:internal', archiveState: 'gateforge:archive-state' },
    volatileFields: ['updated_at', 'created_at'],
  };
}

/** The discovered table resource the signals converge on. */
function accountsResource(dir: string): ClassifierResourceRef {
  return {
    name: 'accounts',
    id: null,
    kind: 'sqlalchemy.table',
    source: `${dir}/models.py`,
    location: { file: `${dir}/models.py`, line: 5, col: 0 },
    detector: { id: 'gateforge.pack-sqlalchemy', version: '0.1.0' },
    attributes: { classQname: 'Account', plane: 'tenant' },
  };
}

/** Signal builder (matches the packs' emission shape). */
function makeSignal(
  dimension: string,
  assertion: string | boolean | Record<string, string> | string[],
  file: string,
  line: number,
): any {
  return {
    schemaVersion: 1,
    target: { resourceName: 'accounts' },
    dimension,
    assertion,
    basis: 'code-positive',
    source: 'gateforge:internal',
    location: { file, line, col: 0 },
    detector: { id: 'test.fixture-detector', version: '1.0.0' },
  };
}

/** Model-side structural facts (pack-sqlalchemy's phase-3 shapes): the
 * ordered key plus archive semantics with owner-owned archived state. */
function modelFacts(dir: string): any[] {
  return [
    makeSignal('identity', ['id'], `${dir}/models.py`, 7),
    {
      schemaVersion: 1,
      target: { resourceName: 'accounts' },
      dimension: 'delete-semantics',
      assertion: 'archive',
      basis: 'declaration',
      source: 'gateforge:archive-state',
      location: { file: `${dir}/models.py`, line: 8, col: 0 },
      detector: { id: 'gateforge.pack-sqlalchemy', version: '1.0.0' },
    },
    {
      schemaVersion: 1,
      target: { resourceName: 'accounts' },
      dimension: 'archive-state',
      assertion: { status: 'archived' },
      basis: 'declaration',
      source: 'gateforge:archive-state',
      location: { file: `${dir}/models.py`, line: 8, col: 0 },
      detector: { id: 'gateforge.pack-sqlalchemy', version: '1.0.0' },
    },
  ];
}

/** An internal-intent declaration signal (machine-readable, not proof). */
function internalDeclaration(dir: string): any {
  return {
    schemaVersion: 1,
    target: { resourceName: 'accounts' },
    dimension: 'internality',
    assertion: true,
    basis: 'declaration',
    source: 'gateforge:internal',
    location: { file: `${dir}/models.py`, line: 6, col: 0 },
    detector: { id: 'gateforge.core', version: '1' },
  };
}

/** A worker reachability signal (pack-task's phase-4 shape). */
function workerSignal(dir: string): any {
  return makeSignal('internality', { category: 'worker' }, `${dir}/workers/sync.ts`, 3);
}

/** Discovers the pack's signals for one route file. */
function routeSignals(dir: string, file: string, text: string): any[] {
  const projectDir = mkdtempSync(join(tmpdir(), 'gateforge-linkage-'));
  try {
    writeFileSync(join(projectDir, file), text);
    const detector = createHttpDetector({ root: projectDir });
    const outcome = detector.discover([file]);
    // Relocate the pack's signal locations into the scenario project.
    return outcome.classificationSignals.map((s) => ({
      ...s,
      location: { ...s.location, file: `${dir}/${file}` },
    }));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

describe('phase-4 linkage chains through the classifier', () => {
  it('route linkage marks the table user-facing and enables observed operations', () => {
    const dir = 'proj';
    const signals = [
      ...modelFacts(dir),
      ...routeSignals(dir, 'app.ts', [
        `import express from 'express';`,
        `const app = express();`,
        `app.post('/api/accounts', (q, r) => r.json({}));`,
        `app.get('/api/accounts', (q, r) => r.json({}));`,
        `app.delete('/api/accounts/:id', (q, r) => r.json({}));`,
      ].join('\n')),
    ];
    const result = classifyResources({
      resources: [accountsResource(dir)],
      signals,
      policy: policy(dir),
      adapters: ['accounts'],
      scan: { findings: [], unresolved: [], coverage: [{ detector: 'test.fixture-detector', scannedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`, `${dir}/app.ts`, `${dir}/client.ts`] }] },
    });
    expect(result.decisions).toHaveLength(1);
    const decision = result.decisions[0];
    expect(decision?.classification?.exposure).toBe('user-facing');
    expect(decision?.classification?.rules).toContain('EXPOSURE_POSITIVE_SIGNAL');
    expect(decision?.classification?.rules).toContain('LIFECYCLE_POSITIVE_SIGNAL(create)');
    expect(decision?.classification?.rules).toContain('LIFECYCLE_POSITIVE_SIGNAL(read)');
    expect(decision?.classification?.lifecycle.create).toBe(true);
    expect(decision?.classification?.lifecycle.delete).toBe(true);
    // No contradiction: the table never claimed internal.
    expect(decision?.blocks).toEqual([]);
    // Obligations may now accrue: the trace names the pack as contributor.
    expect(decision?.classification?.contributingDetectors).toContain('gateforge.pack-http@0.1.0');
  });

  it('frontend-only linkage also marks the table user-facing', () => {
    const dir = 'proj';
    const signals = [
      ...modelFacts(dir),
      ...routeSignals(dir, 'client.ts', `await fetch('/api/accounts');`),
    ];
    const result = classifyResources({
      resources: [accountsResource(dir)],
      signals,
      policy: policy(dir),
      adapters: ['accounts'],
      scan: { findings: [], unresolved: [], coverage: [{ detector: 'test.fixture-detector', scannedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`, `${dir}/app.ts`, `${dir}/client.ts`] }] },
    });
    const decision = result.decisions[0];
    expect(decision?.classification?.exposure).toBe('user-facing');
    expect(decision?.classification?.rules).toContain('EXPOSURE_POSITIVE_SIGNAL');
    expect(decision?.classification?.lifecycle.read).toBe(true);
  });

  it('worker-only resource becomes internal ONLY with a complete scan + declaration', () => {
    const dir = 'proj';
    const base = {
      resources: [accountsResource(dir)],
      // Channel split (ADR 0003 D2): the internal declaration is
      // HOST-ISSUED authority; the worker reachability signal is
      // detector-channel code-positive evidence.
      signals: [workerSignal(dir), ...modelFacts(dir)],
      authority: [internalDeclaration(dir)],
      policy: policy(dir),
      adapters: ['accounts'],
    };
    // Complete scan: the certificate CAN fire. The requested scope is
    // explicit and covered per detector (red-team round 4).
    const complete = classifyResources({
      ...base,
      scan: {
        requestedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`],
        scannedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`],
        findings: [],
        unresolved: [],
        coverage: [{ detector: 'test.fixture-detector', scannedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`] }],
      },
    });
    expect(complete.decisions[0]?.classification?.exposure).toBe('internal');
    expect(complete.decisions[0]?.classification?.rules).toContain('EXPOSURE_INTERNAL_CERTIFICATE');
    // An unresolved entry in scope invalidates the attestation.
    const holed = classifyResources({
      ...base,
      scan: {
        findings: [],
        unresolved: [{ location: { file: `${dir}/models.py`, line: 40, col: 0 } }],
      },
    });
    expect(holed.decisions[0]?.classification?.exposure).toBe('user-facing');
    expect(holed.decisions[0]?.blocks.map((b) => b.code)).toContain('INCOMPLETE_PROOF_SCOPE');
    // No declaration at all: the worker signal alone never proves internal.
    const undeclared = classifyResources({
      ...base,
      signals: base.signals.filter((s) => s.dimension !== 'internality'),
      scan: { findings: [], unresolved: [], coverage: [{ detector: 'test.fixture-detector', scannedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`, `${dir}/app.ts`, `${dir}/client.ts`] }] },
    });
    expect(undeclared.decisions[0]?.classification?.exposure).toBe('user-facing');
  });

  it('adding a route to a previously internal resource invalidates internality', () => {
    const dir = 'proj';
    const base = {
      resources: [accountsResource(dir)],
      signals: [workerSignal(dir), ...modelFacts(dir)] as any[],
      authority: [internalDeclaration(dir)],
      policy: policy(dir),
      adapters: ['accounts'],
      scan: {
        requestedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`, `${dir}/app.ts`, `${dir}/client.ts`],
        scannedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`, `${dir}/app.ts`, `${dir}/client.ts`],
        findings: [],
        unresolved: [],
        coverage: [{ detector: 'test.fixture-detector', scannedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`, `${dir}/app.ts`, `${dir}/client.ts`] }],
      },
    };
    const before = classifyResources(base);
    expect(before.decisions[0]?.classification?.exposure).toBe('internal');
    // conservative user-facing outcome and the contradiction must block.
    const after = classifyResources({
      ...base,
      signals: [
        ...base.signals,
        ...routeSignals(dir, 'app.ts', `app.get('/api/accounts', (q, r) => r.json({}));`),
      ],
    });
    const decision = after.decisions[0];
    expect(decision?.classification?.exposure).toBe('user-facing');
    expect(decision?.blocks.map((b) => b.code)).toContain('CLASSIFICATION_CONTRADICTION');
    // Monotonicity: the exposure rule is now the positive-signal rule and
    // the contradiction is gate-visible in the trace.
    expect(decision?.classification?.rules).toContain('EXPOSURE_POSITIVE_SIGNAL');
    expect(decision?.classification?.contradictions.length).toBeGreaterThan(0);
  });

  it('a broken parser (parse finding) prevents internal classification', () => {
    const dir = 'proj';
    const result = classifyResources({
      resources: [accountsResource(dir)],
      signals: [workerSignal(dir), ...modelFacts(dir)],
      authority: [internalDeclaration(dir)],
      policy: policy(dir),
      adapters: ['accounts'],
      scan: {
        findings: [
          {
            code: 'PARSE_ERROR',
            locations: [{ file: `${dir}/workers/sync.ts`, line: 1, col: 0 }],
          },
        ],
        unresolved: [],
      },
    });
    const decision = result.decisions[0];
    expect(decision?.classification?.exposure).toBe('user-facing');
    expect(decision?.blocks.map((b) => b.code)).toContain('INCOMPLETE_PROOF_SCOPE');
  });

  it('links that resolve to nothing block rather than guess (STALE_SIGNAL_TARGET)', () => {
    const dir = 'proj';
    const signals = routeSignals(dir, 'app.ts', `app.get('/api/orphans', () => {});`);
    const result = classifyResources({
      resources: [accountsResource(dir)],
      signals,
      policy: policy(dir),
      adapters: [],
      scan: { findings: [], unresolved: [], coverage: [{ detector: 'test.fixture-detector', scannedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`, `${dir}/app.ts`, `${dir}/client.ts`] }] },
    });
    expect(result.staleTargets.length).toBeGreaterThan(0);
    expect(result.staleTargets[0]?.code).toBe('STALE_SIGNAL_TARGET');
    expect(result.staleTargets[0]?.name).toBe('orphans');
  });
});
