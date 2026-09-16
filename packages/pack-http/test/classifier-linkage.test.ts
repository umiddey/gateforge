/**
 * Linkage integration suite (dogfood remediation phase 4): the pack mints
 * NO classification signals, and this suite proves the classification
 * chain stays sound without them — against `classifyResources` with
 * sqlalchemy-shaped model facts and worker-shaped internality evidence:
 *
 *   - a route/frontend tree whose path-derived names match no discovered
 *     resource contributes NOTHING and produces ZERO stale targets (the
 *     pre-phase-4 pack produced 1,071 STALE_SIGNAL_TARGET blockers in one
 *     dogfood repo, 322 in another);
 *   - the conservative defaults still hold without the removed signals:
 *     exposure defaults user-facing (ADR 0003 D5) and every lifecycle
 *     operation defaults enabled, so crud:/persistence: obligation
 *     generation (`lifecycleAllowsContract`) is unchanged;
 *   - a genuinely corroborated positive exposure signal (fixture for
 *     what the endpoint compiler mints from schema/handler evidence)
 *     still binds and flips the rule off the default;
 *   - STALE_SIGNAL_TARGET remains for genuinely stale AUTHORITY signals
 *     (declaration markers targeting a removed resource);
 *   - a worker-only resource becomes internal ONLY with a complete scan
 *     and an explicit internal declaration + trusted category.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyResources,
  lifecycleAllowsContract,
  type ClassificationPolicy,
  type ClassifierResourceRef,
} from '@gate-forge/core';
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

/** The discovered table resource the signals used to converge on. */
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
function internalDeclaration(dir: string, target = 'accounts'): any {
  return {
    schemaVersion: 1,
    target: { resourceName: target },
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

/**
 * Discovers the pack's contribution for route files whose path-derived
 * names (`accounts`, `orphans`) may or may not match a discovered
 * resource. Phase 4: the contribution is always an EMPTY signal list —
 * the red side of the red/green pair is the pre-phase-4 pack, which
 * minted `exposure`/`lifecycle.*` signals for every one of these routes.
 */
function packSignalsFor(files: Record<string, string>): any[] {
  const projectDir = mkdtempSync(join(tmpdir(), 'gateforge-linkage-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(projectDir, file), text);
    }
    const detector = createHttpDetector({ root: projectDir });
    const outcome = detector.discover(Object.keys(files));
    // Facts still flow to the endpoint compiler; signals never do.
    expect(outcome.resources.length).toBeGreaterThan(0);
    return outcome.classificationSignals;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

describe('phase-4 linkage: silence where the pack used to guess', () => {
  it('routes naming no discovered resource yield ZERO stale targets; defaults keep the table user-facing and obligations on', () => {
    const dir = 'proj';
    // 'accounts' happens to match the table below (a name COINCIDENCE);
    // 'orphans' matches nothing — the pre-phase-4 shape of the dogfood
    // STALE_SIGNAL_TARGET flood.
    const packSignals = packSignalsFor({
      'app.ts': [
        `import express from 'express';`,
        `const app = express();`,
        `app.post('/api/accounts', (q, r) => r.json({}));`,
        `app.get('/api/accounts', (q, r) => r.json({}));`,
        `app.delete('/api/accounts/:id', (q, r) => r.json({}));`,
        `app.get('/api/orphans', (q, r) => r.json({}));`,
      ].join('\n'),
      'client.ts': `await fetch('/api/accounts');`,
    });
    expect(packSignals).toEqual([]);
    const result = classifyResources({
      resources: [accountsResource(dir)],
      signals: [...modelFacts(dir), ...packSignals],
      policy: policy(dir),
      adapters: ['accounts'],
      scan: { findings: [], unresolved: [], coverage: [{ detector: 'test.fixture-detector', scannedPaths: [`${dir}/models.py`, `${dir}/workers/sync.ts`, `${dir}/app.ts`, `${dir}/client.ts`] }] },
    });
    // The old pack output blocked the gate here (STALE_SIGNAL_TARGET for
    // 'orphans'). Silence is the fix, not more stale detection.
    expect(result.staleTargets).toEqual([]);
    expect(result.decisions).toHaveLength(1);
    const decision = result.decisions[0];
    // Invariant (ADR 0003 D5): unknown exposure DEFAULTS user-facing —
    // removing the guessed exposure signal flipped no resource internal.
    expect(decision?.classification?.exposure).toBe('user-facing');
    expect(decision?.classification?.rules).toContain('EXPOSURE_DEFAULT_USER_FACING');
    // Invariant: unknown lifecycle operations DEFAULT enabled, so the
    // crud:/persistence: obligation gates stay open exactly as before.
    expect(decision?.classification?.lifecycle.create).toBe(true);
    expect(decision?.classification?.lifecycle.read).toBe(true);
    expect(decision?.classification?.lifecycle.delete).toBe(true);
    expect(decision?.classification?.defaultsApplied).toContain('LIFECYCLE_DEFAULT_ENABLED(create)');
    expect(lifecycleAllowsContract('crud:create', decision!.classification!.lifecycle)).toBe(true);
    expect(lifecycleAllowsContract('persistence:read', decision!.classification!.lifecycle)).toBe(true);
    // Archive delete semantics still proven from the model pack's own facts.
    expect(decision?.classification?.lifecycle.deleteSemantics).toBe('archive');
    expect(decision?.blocks).toEqual([]);
    // The pack contributes nothing to the decision trace (it minted
    // nothing); the model pack's facts still do.
    expect(decision?.classification?.contributingDetectors).not.toContain('gateforge.pack-http@0.1.0');
    expect(decision?.classification?.contributingDetectors).toContain('gateforge.pack-sqlalchemy@1.0.0');
  });

  it('a genuinely corroborated exposure signal still binds (positive control)', () => {
    const dir = 'proj';
    // Fixture for corroborated evidence (what the engine mints when the
    // endpoint compiler's schema/handler linkage resolved): same shape the
    // pack used to emit, but with real linkage behind it.
    const corroborated = makeSignal('exposure', 'route', `${dir}/app.ts`, 3);
    const result = classifyResources({
      resources: [accountsResource(dir)],
      signals: [...modelFacts(dir), corroborated],
      policy: policy(dir),
      adapters: ['accounts'],
      scan: { findings: [], unresolved: [], coverage: [{ detector: 'test.fixture-detector', scannedPaths: [`${dir}/models.py`, `${dir}/app.ts`] }] },
    });
    const decision = result.decisions[0];
    expect(decision?.classification?.exposure).toBe('user-facing');
    // The positive rule replaces the default when evidence is real.
    expect(decision?.classification?.rules).toContain('EXPOSURE_POSITIVE_SIGNAL');
    expect(decision?.classification?.rules).not.toContain('EXPOSURE_DEFAULT_USER_FACING');
    expect(result.staleTargets).toEqual([]);
  });

  it('STALE_SIGNAL_TARGET remains for genuinely stale AUTHORITY signals', () => {
    const dir = 'proj';
    // A declaration marker targeting a resource that no longer exists —
    // exactly the stale-reference case the phase-4 remediation KEPT.
    const result = classifyResources({
      resources: [accountsResource(dir)],
      signals: [...modelFacts(dir)],
      authority: [internalDeclaration(dir, 'removed_table')],
      policy: policy(dir),
      adapters: [],
      scan: { findings: [], unresolved: [], coverage: [{ detector: 'test.fixture-detector', scannedPaths: [`${dir}/models.py`] }] },
    });
    expect(result.staleTargets).toHaveLength(1);
    expect(result.staleTargets[0]?.code).toBe('STALE_SIGNAL_TARGET');
    expect(result.staleTargets[0]?.name).toBe('removed_table');
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
});
