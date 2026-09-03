/**
 * Resource-graph ingestion tests (G2): detector-output normalization,
 * plane-qualified ids, deterministic ordering, duplicate-table-name
 * detection (GF-20 groundwork), and path/name hardening.
 *
 * Since the automatic-classification cutover (plan phase 5, ADR 0003 D5)
 * the graph binds NO business meaning: identity is qualified only by
 * detector `attributes.plane` evidence, and effective classifications
 * come exclusively from the deterministic classifier over signals
 * (covered in classifier.test.ts and the classifier-linkage suites).
 */
import { describe, expect, it } from 'vitest';
import {
  buildResourceGraph,
  canonicalJson,
  CLASS_SYMBOL_KIND,
  ResourceGraphSchema,
  type DetectorOutput,
  type JsonValue,
  type ResourceGraphInput,
} from '../src/index.js';
import type { Resource } from '../src/index.js';

/**
 * Byte-form of a graph: canonical JSON with a cast past the open
 * `attributes: Record<string, unknown>` payload (runtime values are
 * JSON-representable by construction — detectors emit JSON).
 */
function bytes(value: unknown): string {
  return canonicalJson(value as JsonValue);
}

/** Builds a minimal table-shaped detector resource. */
function tableResource(overrides: Partial<Resource> & { attributes: Record<string, unknown> }): Resource {
  return {
    schemaVersion: 1,
    id: 'sqlalchemy:table:placeholder',
    kind: 'sqlalchemy.table',
    source: 'backend/models/x.py',
    location: { file: 'backend/models/x.py', line: 10, col: 0 },
    detectorVersion: '0.1.0',
    ...overrides,
  };
}

/** A detector contribution with defaults. */
function detector(resources: Resource[], overrides: Partial<DetectorOutput> = {}): DetectorOutput {
  return {
    detectorId: 'gateforge.discovery.sqlalchemy',
    detectorVersion: '0.1.0',
    resources,
    unresolved: [],
    findings: [],
    classificationSignals: [],
    ...overrides,
  };
}

describe('graph ingestion (normalization + determinism)', () => {
  it('normalizes detector output to plane-qualified ids and repo-relative sources', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([
          tableResource({
            id: 'sqlalchemy:table:./backend/models/account.py:Account',
            source: './backend/models/account.py',
            location: { file: './backend/models/account.py', line: 17, col: 0 },
            attributes: { resourceName: 'accounts', plane: 'tenant' },
          }),
        ]),
      ],
    });

    expect(graph.resources).toHaveLength(1);
    const entry = graph.resources[0];
    expect(entry?.id).toBe('tenant.accounts');
    expect(entry?.name).toBe('accounts');
    expect(entry?.plane).toBe('tenant');
    expect(entry?.source).toBe('backend/models/account.py');
    expect(entry?.location.file).toBe('./backend/models/account.py'); // original location preserved
    // The graph binds NO business meaning — that is the classifier's job.
    expect(entry?.exposure).toBeNull();
    expect(entry?.classification).toBeNull();
    expect(entry?.classificationTrace).toBeNull();
    expect(entry?.detector).toEqual({ id: 'gateforge.discovery.sqlalchemy', version: '0.1.0' });
    expect(graph.stale).toEqual([]);
  });

  it('binds nothing when no plane evidence exists (id-less but visible)', () => {
    const graph = buildResourceGraph({
      detectors: [detector([tableResource({ attributes: { resourceName: 'accounts' } })])],
    });
    const entry = graph.resources[0];
    expect(entry?.id).toBeNull();
    expect(entry?.classification).toBeNull();
    expect(entry?.exposure).toBeNull();
  });

  it('stays id-less but visible when no plane can be derived', () => {
    const graph = buildResourceGraph({
      detectors: [detector([tableResource({ attributes: { resourceName: 'orphan' } })])],
    });
    expect(graph.resources[0]?.id).toBeNull();
    expect(graph.resources[0]?.plane).toBeNull();
  });

  it('is byte-for-byte deterministic across input array orders (canonical JSON)', () => {
    const accounts = tableResource({
      source: 'backend/models/account.py',
      location: { file: 'backend/models/account.py', line: 17, col: 0 },
      attributes: { resourceName: 'accounts', plane: 'tenant' },
    });
    const sessions = tableResource({
      source: 'backend/models/session.py',
      location: { file: 'backend/models/session.py', line: 5, col: 0 },
      attributes: { resourceName: 'sessions', plane: 'tenant' },
    });
    const input: ResourceGraphInput = {
      detectors: [detector([accounts, sessions])],
    };
    // Same artifacts, different input orderings — output must not care.
    const shuffled: ResourceGraphInput = {
      detectors: [detector([sessions, accounts])],
    };

    const a = buildResourceGraph(input);
    const b = buildResourceGraph(shuffled);
    expect(bytes(a)).toBe(bytes(b));
    expect(ResourceGraphSchema.parse(a)).toEqual(a);
    // sorted by id
    expect(a.resources.map((r) => r.id)).toEqual(['tenant.accounts', 'tenant.sessions']);
  });

  it('round-trips through canonical JSON: serialize → parse → identical bytes', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector(
          [tableResource({ attributes: { resourceName: 'accounts', plane: 'tenant' } })],
          {
            unresolved: [
              { code: 'computed_tablename', detail: 'decorated function (1 decorator(s))', location: { file: 'backend/models/x.py', line: 40, col: 4 } },
            ],
            findings: [
              { code: 'PARSE_ERROR', detail: 'syntax error at line 9', locations: [{ file: 'backend/models/x.py', line: 9, col: 0 }] },
            ],
          },
        ),
      ],
    });
    const reparsed: unknown = JSON.parse(bytes(graph));
    expect(bytes(reparsed)).toBe(bytes(graph));
    expect(graph.unresolved[0]?.detectorId).toBe('gateforge.discovery.sqlalchemy');
    expect(graph.unresolved[0]?.detectorVersion).toBe('0.1.0');
    expect(graph.findings[0]?.detectorId).toBe('gateforge.discovery.sqlalchemy');
  });
});

describe('duplicate-table-name detection (GF-20 groundwork)', () => {
  it('flags the same name declared in two files (one finding, both locations)', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([
          tableResource({
            id: 'raw:a',
            source: 'backend/models/a.py',
            location: { file: 'backend/models/a.py', line: 3, col: 0 },
            attributes: { resourceName: 'dupes', plane: 'tenant' },
          }),
          tableResource({
            id: 'raw:b',
            source: 'backend/models/b.py',
            location: { file: 'backend/models/b.py', line: 8, col: 0 },
            attributes: { resourceName: 'dupes', plane: 'tenant' },
          }),
        ]),
      ],
    });

    expect(graph.resources).toHaveLength(2);
    expect(graph.resources[0]?.id).toBe('tenant.dupes');
    expect(graph.resources[1]?.id).toBe('tenant.dupes');
    expect(graph.findings).toHaveLength(1);
    const finding = graph.findings[0];
    expect(finding?.code).toBe('DUPLICATE_TABLE_NAME');
    expect(finding?.detail).toContain('2 time(s) across 2 file(s)');
    expect(finding?.detail).toContain('backend/models/a.py, backend/models/b.py');
    expect(finding?.locations).toEqual([
      { file: 'backend/models/a.py', line: 3, col: 0 },
      { file: 'backend/models/b.py', line: 8, col: 0 },
    ]);
    expect(finding?.detectorId).toBe('gateforge.graph');
  });

  it('flags a same-file duplicate declared twice in one file', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([
          tableResource({
            source: 'backend/models/dupes.py',
            location: { file: 'backend/models/dupes.py', line: 3, col: 0 },
            attributes: { resourceName: 'dupes', plane: 'tenant' },
          }),
          tableResource({
            source: 'backend/models/dupes.py',
            location: { file: 'backend/models/dupes.py', line: 30, col: 4 },
            attributes: { resourceName: 'dupes', plane: 'tenant' },
          }),
        ]),
      ],
    });
    expect(graph.findings).toHaveLength(1);
    expect(graph.findings[0]?.code).toBe('DUPLICATE_TABLE_NAME');
    expect(graph.findings[0]?.detail).toContain('2 time(s) across 1 file(s)');
    expect(graph.findings[0]?.locations).toHaveLength(2);
  });

  it('does not flag the same name on different planes (plane qualification disambiguates)', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([
          tableResource({
            id: 'raw:tenant',
            source: 'backend/models/tenant_items.py',
            location: { file: 'backend/models/tenant_items.py', line: 3, col: 0 },
            attributes: { resourceName: 'items', plane: 'tenant' },
          }),
          tableResource({
            id: 'raw:master',
            source: 'backend/models/master_items.py',
            location: { file: 'backend/models/master_items.py', line: 3, col: 0 },
            attributes: { resourceName: 'items', plane: 'master' },
          }),
        ]),
      ],
    });
    expect(graph.resources.map((r) => r.id)).toEqual(['master.items', 'tenant.items']);
    // Business meaning is never bound here — even with plane evidence.
    expect(graph.resources.every((r) => r.classification === null)).toBe(true);
    expect(graph.findings).toEqual([]);
  });

  it('leaves same-name plane-less resources id-less (identity never guessed)', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([tableResource({ attributes: { resourceName: 'items' } })]),
      ],
    });
    expect(graph.resources[0]?.id).toBeNull();
    expect(graph.findings).toEqual([]);
  });
});

describe('graph hardening', () => {
  it('converts schema-invalid resources into INVALID_RESOURCE findings, never crashes', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([
          { broken: true } as unknown as Resource,
          tableResource({ attributes: { resourceName: 'accounts' } }),
        ]),
      ],
    });
    expect(graph.resources).toHaveLength(1);
    expect(graph.findings[0]?.code).toBe('INVALID_RESOURCE');
  });

  it('reports resources without a resourceName attribute as typed unresolved entries', () => {
    const graph = buildResourceGraph({
      detectors: [detector([tableResource({ attributes: { style: 'declarative_base' } })])],
    });
    expect(graph.resources).toEqual([]);
    expect(graph.unresolved[0]?.reason.code).toBe('no_resource_name');
    expect(graph.unresolved[0]?.detectorVersion).toBe('0.1.0');
  });

  it('rejects paths escaping the repo root but keeps their names non-stale', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([
          tableResource({
            source: '../secrets/models.py',
            attributes: { resourceName: 'accounts' },
          }),
        ]),
      ],
    });
    expect(graph.resources).toEqual([]);
    expect(graph.findings[0]?.code).toBe('NON_REPO_RELATIVE_PATH');
    expect(graph.stale).toEqual([]); // name was declared → references not stale
  });

  it('rejects names that break the plane.name / id:contract grammars', () => {
    const graph = buildResourceGraph({
      detectors: [detector([tableResource({ attributes: { resourceName: 'bad.name' } })])],
    });
    expect(graph.resources).toEqual([]);
    expect(graph.findings[0]?.code).toBe('INVALID_RESOURCE_NAME');
  });

  it('never emits class-symbol resources as business resources', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([
          tableResource({
            kind: CLASS_SYMBOL_KIND,
            attributes: { qname: 'models.Base', resourceKind: 'sqlalchemy.table', tableName: 'bases' },
          }),
        ]),
      ],
    });
    expect(graph.resources).toEqual([]);
  });
});
