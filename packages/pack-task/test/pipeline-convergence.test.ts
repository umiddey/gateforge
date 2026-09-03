/**
 * Task/model convergence regression (plan open item, ADR 0003 D5): the
 * pack's resources and internality signals must CONVERGE through the real
 * graph + classifier path — the resource's bare `resourceName` is the
 * graph identity, the internality signal targets exactly that name, and
 * a worker-only task can be certified internal ONLY inside a complete
 * certificate (declaration + complete scan + trusted category).
 *
 * Guards the whole chain against identity drift between the detector's
 * resource ids (`task.<name>`), its signal targets (`<name>`), and the
 * graph's bare-name normalization (`^[^.]+$`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildResourceGraph,
  runClassification,
  type ClassificationPolicy,
} from '@gateforge/core';
import { createTaskDetector, PACK_PLUGIN_ID, PACK_VERSION } from '../src/index.js';

function policy(_dir: string): ClassificationPolicy {
  return {
    schemaVersion: 1,
    // Scan roots are repo-root-relative globs (the detector's location
    // space): everything the temp project contains is in scope.
    scanRoots: ['**'],
    // Reachability for the worker category is bound to the REAL pack-task
    // detector (red-team round 5): its own signals are the only ones the
    // certificate may use for this category.
    trustedInternalEntryPoints: [
      { category: 'worker', patterns: ['**/workers/**'], detector: 'gateforge.pack-task' },
    ],
    internalRules: [],
    // A scan is only provably complete per detector (red-team round 3).
    coverage: [{ capability: 'exposure.http', exhaustive: true, detector: 'gateforge.pack-task', appliesTo: ['**'] }],
    declarations: { internality: 'gateforge:internal', archiveState: 'gateforge:archive-state' },
    volatileFields: [],
  };
}

/** The core-issued internal-intent declaration signal (authorized issuer). */
function internalDeclaration(dir: string) {
  return {
    schemaVersion: 1 as const,
    target: { resourceName: 'accounts' },
    dimension: 'internality' as const,
    assertion: true,
    basis: 'declaration' as const,
    source: 'gateforge:internal',
    location: { file: `${dir}/workers/sync.ts`, line: 1, col: 0 },
    detector: { id: 'gateforge.core', version: '1' },
  };
}

/** Builds the graph + classification for a temp project with one worker and an accounts table. */
async function classifyProject(
  dir: string,
  extraSignals: Array<{
    schemaVersion: 1;
    target: { resourceName: string };
    dimension: string;
    assertion: unknown;
    basis: string;
    source: string;
    location: { file: string; line: number; col: number };
    detector: { id: string; version: string };
  }> = [],
  graphFindings: Array<{ code: string; file?: string }> = [],
) {
  const detector = createTaskDetector({ rootDir: dir });
  const outcome = await detector.discover(['workers/sync.ts']);
  const modelSignals = [
    {
      schemaVersion: 1 as const,
      target: { resourceName: 'accounts' },
      dimension: 'identity' as const,
      assertion: ['id'],
      basis: 'code-positive' as const,
      source: 'gateforge.pack-model',
      location: { file: 'models/account.py', line: 10, col: 0 },
      detector: { id: 'gateforge.pack-model', version: '1.0.0' },
    },
    {
      schemaVersion: 1 as const,
      target: { resourceName: 'accounts' },
      dimension: 'delete-semantics' as const,
      assertion: 'hard',
      basis: 'code-positive' as const,
      source: 'gateforge.pack-model',
      location: { file: 'models/account.py', line: 10, col: 0 },
      detector: { id: 'gateforge.pack-model', version: '1.0.0' },
    },
  ];
  const graph = buildResourceGraph({
    detectors: [
      {
        detectorId: 'gateforge.pack-model',
        detectorVersion: '1.0.0',
        resources: [
          {
            schemaVersion: 1,
            id: 'tenant.accounts',
            kind: 'sqlalchemy.table',
            source: 'models/account.py',
            location: { file: 'models/account.py', line: 10, col: 0 },
            detectorVersion: '1.0.0',
            attributes: { resourceName: 'accounts', plane: 'tenant' },
          },
        ],
        unresolved: [],
        findings: [],
        classificationSignals: modelSignals,
      },
      {
        detectorId: PACK_PLUGIN_ID,
        detectorVersion: PACK_VERSION,
        resources: outcome.resources,
        unresolved: outcome.unresolved,
        findings: outcome.findings,
        classificationSignals: outcome.classificationSignals,
      },
    ],
  });
  if (graphFindings.length > 0) {
    graph.findings.push(
      ...graphFindings.map((f) => ({
        code: f.code,
        detail: f.code,
        locations: [{ file: f.file ?? 'workers/sync.ts', line: 2, col: 0 }],
        detectorId: 'gateforge.test',
      })),
    );
  }
  const suppressive = (signal: { dimension: string; basis: string }): boolean =>
    (signal.dimension === 'internality' &&
      (signal.basis === 'declaration' || signal.basis === 'organization-policy')) ||
    (signal.dimension.startsWith('lifecycle.') && signal.basis === 'code-negative-closed-world');
  return {
    graph,
    outcome,
    result: runClassification({
      graph,
      signals: [
        ...modelSignals,
        ...outcome.classificationSignals,
        ...extraSignals.filter((s) => !suppressive(s)),
      ] as never,
      authority: extraSignals.filter((s) => suppressive(s)) as never,
      policy: policy(dir),
      adapters: [],
      scan: {
        requestedPaths: ['workers/sync.ts'],
        scannedPaths: ['workers/sync.ts'],
        coverage: [{ detector: 'gateforge.pack-task', scannedPaths: ['workers/sync.ts'] }],
        configuredDetectors: 1,
        successfulDetectors: 1,
      },
    }),
  };
}

describe('task/model convergence through the real pipeline path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-task-convergence-'));
  mkdirSync(join(dir, 'workers'), { recursive: true });
  writeFileSync(
    join(dir, 'workers', 'sync.ts'),
    [
      `/** Nightly sync worker for accounts. */`,
      `import { Account } from '../models/account';`,
      `register('sync_accounts', async (job) => {`,
      `  await run(job.data);`,
      `});`,
      ``,
    ].join('\n'),
  );

  it('worker traces to target model and emits internality signals targeting accounts', async () => {
    const { graph, outcome } = await classifyProject(dir);
    expect(graph.resources).toHaveLength(1);
    expect(graph.resources[0]?.name).toBe('accounts');
    expect(outcome.resources).toHaveLength(0);
    const targetNames = outcome.classificationSignals.map((s) => s.target.resourceName);
    expect(targetNames).toContain('accounts');
  });

  it('worker-only model certifies internal inside a complete certificate', async () => {
    const evidence = [internalDeclaration(dir)];
    const ok = await classifyProject(dir, evidence);
    const accounts = ok.result.classification.decisions.find((d) => d.name === 'accounts');
    expect(accounts?.classification?.exposure).toBe('internal');
    expect(accounts?.classification?.rules).toContain('EXPOSURE_INTERNAL_CERTIFICATE');
  });

  it('in-scope finding invalidates the closed-world attestation', async () => {
    const evidence = [internalDeclaration(dir)];
    const holed = await classifyProject(dir, evidence, [
      { code: 'parse_error', file: 'workers/sync.ts' },
    ]);
    const accounts = holed.result.classification.decisions.find((d) => d.name === 'accounts');
    expect(accounts?.classification?.exposure).not.toBe('internal');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
