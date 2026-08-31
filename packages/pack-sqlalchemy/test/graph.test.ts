/**
 * Resource-graph integration suite: the pack's discovery output fed to
 * `buildResourceGraph` (G2's frozen ingestion) — cross-module
 * inheritance resolution via the symbol table, detector-unresolved
 * retirement, synthesized `inherited_tablename_unresolved` entries,
 * plane classification binding, and graph-level duplicate detection.
 */
import { describe, expect, it } from 'vitest';
import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
import { buildResourceGraph, type GraphResource, type ResourceGraph } from '@gateforge/core';
import { runDiscover } from './helpers.js';

/** The classifier used by plane-binding tests. */
const ACCOUNTS_CLASSIFICATION = {
  schemaVersion: 1,
  resources: {
    accounts: {
      exposure: 'internal',
      plane: 'master',
      lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' },
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
async function build(paths: readonly string[], classifications: unknown = undefined): Promise<ResourceGraph> {
  const outcome: DiscoveryOutcome = await runDiscover(paths);
  return buildResourceGraph({
    detectors: [
      {
        detectorId: 'gateforge.pack-sqlalchemy',
        detectorVersion: '0.1.0',
        resources: outcome.resources,
        unresolved: outcome.unresolved,
        findings: outcome.findings,
      },
    ],
    classifications,
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

describe('graph integration: plane mapping + classification binding', () => {
  it('binds the example accounts table to master.accounts via the classifier', async () => {
    const graph = await build(['example_models.py'], ACCOUNTS_CLASSIFICATION);
    const account = byName(graph, 'accounts');
    expect(account?.id).toBe('master.accounts');
    expect(account?.plane).toBe('master');
    expect(account?.classification?.exposure).toBe('internal');
    expect(graph.resources).toHaveLength(1);
  }, 60_000);
});

describe('graph integration: GF-20 duplicates at graph level', () => {
  it('flags same-plane duplicate ids after classification, keeping detector findings', async () => {
    const graph = await build(['collisions.py', 'modern_declarative.py'], ACCOUNTS_CLASSIFICATION);
    const graphDup = graph.findings.filter(
      (f) => f.code === 'DUPLICATE_TABLE_NAME' && f.detectorId === 'gateforge.graph',
    );
    expect(graphDup).toHaveLength(1); // shared_items collapses onto master.shared_items (dupes unclassified)
    expect(graphDup[0]?.detail).toContain("table name 'shared_items' declared 2 time(s)");
    // Detector findings survive with provenance.
    const detectorDup = graph.findings.filter(
      (f) => f.code === 'DUPLICATE_TABLE_NAME' && f.detectorId === 'gateforge.pack-sqlalchemy',
    );
    expect(detectorDup).toHaveLength(2);
    expect(detectorDup.map((f) => f.detail).join('\n')).toContain("'dupes'");
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