/**
 * Resource-graph integration suite: the pack's discovery output fed to
 * `buildResourceGraph` (G2's frozen ingestion) — cross-module
 * inheritance resolution via the symbol table, detector-unresolved
 * retirement, synthesized `inherited_tablename_unresolved` entries,
 * plane classification binding, and graph-level duplicate detection.
 */
import { describe, expect, it } from 'vitest';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import {
  buildResourceGraph,
  runClassification,
  type ClassificationSignal,
  type GraphResource,
  type ResourceGraph,
} from '@gate-forge/core';
import { runDiscover } from './helpers.js';

/** The classifier used by plane-binding tests. */
const ACCOUNTS_CLASSIFICATION = {
  schemaVersion: 1,
  resources: {
    accounts: {
      exposure: 'internal',
      plane: 'master',
      lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive', archiveFields: { status: 'archived' } },
      primaryKey: ['id'],
    },
    shared_items: {
      exposure: 'internal',
      plane: 'master',
      lifecycle: { create: false, read: true, update: false, delete: false },
      primaryKey: ['id'],
    },
  },
};

/** Runs discovery + graph build over a fixture subset. */
async function build(paths: readonly string[]): Promise<ResourceGraph> {
  const outcome: DiscoveryOutcome = await runDiscover(paths);
  return buildResourceGraph({
    detectors: [
      {
        detectorId: 'gateforge.pack-sqlalchemy',
        detectorVersion: '0.1.0',
        resources: outcome.resources,
        unresolved: outcome.unresolved,
        findings: outcome.findings,
        classificationSignals: outcome.classificationSignals,
      },
    ],
  });
}

const byName = (graph: ResourceGraph, name: string): GraphResource | undefined =>
  graph.resources.find((resource) => resource.name === name);

describe('graph integration: cross-module inheritance (symbol table)', () => {
  it('resolves a subclass tablename through a base declared in another file', async () => {
    const graph = await build([
      'cross_module/base.py',
      'cross_module/computed.py',
      'cross_module/child.py',
    ]);

    // InheritedChild resolved across files: one concrete table.
    const tables = graph.resources.filter((r) => r.kind === 'sqlalchemy.table');
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe('archive_rows');
    expect(tables[0]?.attributes['provenance']).toBe('inherited-from-abstract:ArchiveBase');
    expect(tables[0]?.attributes['classQname']).toBe('InheritedChild');
    expect(tables[0]?.location).toEqual({ file: 'cross_module/child.py', line: 17, col: 0 });

    // The resolved symbol RETIRES the detector's unresolved entry at the
    // class statement (location convention); the genuinely computed chain
    // keeps BOTH the detector entry and the graph-synthesized one (GF-21:
    // never absent).
    const codes = graph.unresolved.map((u) => u.reason.code).sort();
    expect(codes).toEqual([
      'computed_tablename', // ComputedBase (detector, computed.py:14)
      'inherited_tablename_unresolved', // ComputedBase (graph)
      'inherited_tablename_unresolved', // RuntimeChild (graph, child.py:23)
      'no_tablename_source', // RuntimeChild (detector, child.py:23)
    ]);
    // InheritedChild's detector entry was retired with the resolution.
    expect(
      graph.unresolved.some(
        (u) => u.reason.location.file === 'cross_module/child.py' && u.reason.location.line === 17,
      ),
    ).toBe(false);
  }, 60_000);
});

describe('graph integration: same-file inheritance + retirement', () => {
  it('resolves the same-file abstract-base chain and retires the detector entry', async () => {
    const graph = await build(['legacy_declarative.py']);
    const table = byName(graph, 'abstract_never_materialized');
    expect(table).toBeDefined();
    expect(table?.attributes['provenance']).toBe('inherited-from-abstract:ArchiveBase');
    expect(table?.attributes['classQname']).toBe('InheritedAlpha');
    expect(graph.unresolved.some((u) => u.reason.location.file === 'legacy_declarative.py' && u.reason.location.line === 50)).toBe(false);
    // Literal tables still surface as detector resources.
    expect(byName(graph, 'alphas')?.attributes['tablenameProvenance']).toBe('literal');
    expect(byName(graph, 'archived_alphas')).toBeDefined();
  }, 60_000);
});

describe('graph integration: GF-21 computed identity (nothing absent)', () => {
  it('keeps typed unresolved entries and graph-synthesized ones for computed names', async () => {
    const graph = await build(['computed_names.py']);
    expect(graph.resources).toHaveLength(0);
    const codes = graph.unresolved.map((u) => u.reason.code).sort();
    expect(codes).toEqual([
      'computed_tablename',
      'computed_tablename',
      'computed_tablename',
      'computed_tablename', // Widget, Gadget, Gizmo, Doohickey (detector)
      'inherited_tablename_unresolved',
      'inherited_tablename_unresolved',
      'inherited_tablename_unresolved',
      'inherited_tablename_unresolved', // one synthesized per unresolved class
    ]);
    expect(graph.unresolved.length).toBe(8);
    const widgetSynth = graph.unresolved.find(
      (u) => u.detectorId === 'gateforge.graph' && u.reason.location.line === 28,
    );
    expect(widgetSynth?.reason.code).toBe('inherited_tablename_unresolved');
    // The detector's typed reason survives verbatim next to it.
    const widgetDetector = graph.unresolved.find(
      (u) => u.detectorId === 'gateforge.pack-sqlalchemy' && u.reason.location.line === 28,
    );
    expect(widgetDetector?.reason.detail).toContain('3 decorator(s)');
  }, 60_000);
});

describe('graph integration: classification cutover', () => {
  it('leaves business classification to the classification pipeline', async () => {
    const graph = await build(['example_models.py']);
    const account = byName(graph, 'accounts');
    expect(account?.id).toBeNull();
    expect(account?.plane).toBeNull();
    expect(account?.classification).toBeNull();
    expect(graph.resources).toHaveLength(1);
  }, 60_000);
});

describe('graph integration: detector findings', () => {
  it('keeps detector duplicate findings without synthesizing classification duplicates', async () => {
    const graph = await build(['collisions.py', 'modern_declarative.py']);
    const graphDup = graph.findings.filter(
      (f) => f.code === 'DUPLICATE_TABLE_NAME' && f.detectorId === 'gateforge.graph',
    );
    expect(graphDup).toHaveLength(0);
    const detectorDup = graph.findings.filter(
      (f) => f.code === 'DUPLICATE_TABLE_NAME' && f.detectorId === 'gateforge.pack-sqlalchemy',
    );
    expect(detectorDup).toHaveLength(2);
  }, 60_000);
});

describe('graph integration: GF-01 non-collapse', () => {
  it('keeps all four function-local Row tables as distinct graph resources', async () => {
    const graph = await build(['function_local.py']);
    const rows = graph.resources.filter((r) => r.kind === 'sqlalchemy.table');
    expect(rows).toHaveLength(4);
    const qnames = new Set(rows.map((r) => r.attributes['classQname']));
    expect(qnames.size).toBe(4);
    // worker + tenant share a table name; identical names never merge.
    const worker = rows.filter((r) => r.name === 'rows_worker_b');
    expect(worker).toHaveLength(2);
    expect(new Set(worker.map((r) => r.attributes['classQname']))).toEqual(
      new Set(['build_worker_rows.Row', 'build_tenant_rows.Row']),
    );
  }, 60_000);
});

describe('graph integration: GF-20 bound-id non-collapse', () => {
  it('binds BOTH same-name tables and flags DUPLICATE_BOUND_RESOURCE_ID', async () => {
    // The two `dupes` tables in collisions.py survive discovery and graph
    // build as DISTINCT resources; once classification binds each to the
    // same plane-qualified id, the graph must report the collision as a
    // finding — never silently collapse or pick a winner.
    const outcome: DiscoveryOutcome = await runDiscover(['collisions.py']);
    const graph = buildResourceGraph({
      detectors: [
        {
          detectorId: 'gateforge.pack-sqlalchemy',
          detectorVersion: '0.1.0',
          resources: outcome.resources,
          unresolved: outcome.unresolved,
          findings: outcome.findings,
          classificationSignals: outcome.classificationSignals,
        },
      ],
    });
    const dupes = graph.resources.filter((r) => r.name === 'dupes');
    expect(dupes).toHaveLength(2);
    const location = dupes[0]!.location;
    // The exact signal set policy.test.ts uses to produce a bound
    // decision (plane + identity + full lifecycle + adapter binding),
    // targeting the shared bare name — so BOTH resources bind.
    const signals = ([
      { dimension: 'plane', assertion: 'tenant' },
      { dimension: 'identity', assertion: ['id'] },
      { dimension: 'lifecycle.create', assertion: true },
      { dimension: 'lifecycle.read', assertion: true },
      { dimension: 'lifecycle.update', assertion: true },
      { dimension: 'lifecycle.delete', assertion: true },
      { dimension: 'delete-semantics', assertion: 'hard' },
      { dimension: 'adapter-binding', assertion: 'adapter' },
    ].map((part) => ({
      schemaVersion: 1 as const,
      target: { resourceName: 'dupes' },
      source: 'gateforge:internal',
      location,
      detector: { id: 'gateforge.core', version: '1' },
      basis: 'declaration' as const,
      ...part,
    }))) as ClassificationSignal[];
    const classified = runClassification({
      graph,
      signals,
      policy: {
        schemaVersion: 1,
        scanRoots: ['**/*.py'],
        trustedInternalEntryPoints: [],
        internalRules: [],
        coverage: [],
        declarations: { internality: 'gateforge:internal' },
        volatileFields: [],
      },
      adapters: ['adapter'],
      scan: {
        requestedPaths: ['collisions.py'],
        scannedPaths: ['collisions.py'],
        configuredDetectors: 1,
        successfulDetectors: 1,
      },
    });
    const bound = classified.graph.resources.filter((r) => r.id !== null);
    expect(bound).toHaveLength(2);
    expect(new Set(bound.map((r) => r.id))).toEqual(new Set(['tenant.dupes']));
    const boundDuplicates = classified.graph.findings.filter(
      (f) => f.code === 'DUPLICATE_BOUND_RESOURCE_ID',
    );
    expect(boundDuplicates).toHaveLength(1);
    expect(boundDuplicates[0]?.locations).toHaveLength(2);
    // Detector-level GF-20 evidence stays alongside (never replaced).
    expect(
      classified.graph.findings.filter(
        (f) => f.code === 'DUPLICATE_TABLE_NAME' && f.detectorId === 'gateforge.pack-sqlalchemy',
      ),
    ).toHaveLength(1);
  }, 60_000);
});