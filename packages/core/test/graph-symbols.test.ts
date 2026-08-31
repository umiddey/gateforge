/**
 * Symbol-table tests (G2, go/no-go first action #2): cross-module
 * inheritance resolution so inherited tablenames stop being
 * `unresolved` when statically resolvable — and typed unresolved when
 * truly non-literal.
 *
 * Location convention: a detector unresolved entry is retired only when
 * its location points at the class statement (`file:line`) of a class
 * symbol the symbol table resolved this run, from the SAME detector.
 */
import { describe, expect, it } from 'vitest';
import { buildResourceGraph, CLASS_SYMBOL_KIND, type DetectorOutput, type Resource } from '../src/index.js';

/** A validated resource with overrides. */
function resource(overrides: Partial<Resource> & { attributes: Record<string, unknown> }): Resource {
  return {
    schemaVersion: 1,
    id: 'raw',
    kind: 'sqlalchemy.table',
    source: 'backend/models/x.py',
    location: { file: 'backend/models/x.py', line: 1, col: 0 },
    detectorVersion: '0.1.0',
    ...overrides,
  };
}

/** A class-symbol resource (kind `gateforge.class`). */
function classSymbol(overrides: Partial<Resource> & { attributes: Record<string, unknown> }): Resource {
  return resource({ kind: CLASS_SYMBOL_KIND, ...overrides });
}

/** A detector contribution with defaults. */
function detector(resources: Resource[], overrides: Partial<DetectorOutput> = {}): DetectorOutput {
  return {
    detectorId: 'gateforge.discovery.sqlalchemy',
    detectorVersion: '0.1.0',
    resources,
    unresolved: [],
    findings: [],
    ...overrides,
  };
}

const ACCOUNT_CLASSIFICATIONS = {
  schemaVersion: 1,
  resources: {
    'tenant.widgets': {
      exposure: 'user-facing',
      plane: 'tenant',
      lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
      primaryKey: ['id'],
      evidenceAdapter: 'tenant.widgets',
    },
  },
};

describe('cross-module inheritance resolution (symbol table)', () => {
  it('resolves a subclass tablename through a base declared in another file', () => {
    // models/widget.py: Widget(Base) with a computed/unresolvable name —
    // the detector emits a class symbol AND a typed unresolved entry
    // pointing at the class statement.
    const widgetFile = 'backend/models/widget.py';
    const detectorA = detector(
      [
        classSymbol({
          source: widgetFile,
          location: { file: widgetFile, line: 28, col: 6 },
          attributes: {
            qname: 'models.widget.Widget',
            resourceKind: 'sqlalchemy.table',
            baseNames: ['models.base.Base'],
            tablenameUnresolved: true,
          },
        }),
      ],
      {
        unresolved: [
          {
            code: 'no_tablename_source',
            detail: 'no literal __tablename__ found on the same-file base chain',
            location: { file: widgetFile, line: 28, col: 6 },
          },
        ],
      },
    );
    // models/base.py: the base lives in ANOTHER file — what the spike
    // could not resolve. Same detector (repo-wide run), second file.
    const baseFile = 'backend/models/base.py';
    detectorA.resources.push(
      classSymbol({
        source: baseFile,
        location: { file: baseFile, line: 12, col: 6 },
        attributes: {
          qname: 'models.base.Base',
          resourceKind: 'sqlalchemy.table',
          tableName: 'widgets',
          abstract: true,
        },
      }),
    );

    const graph = buildResourceGraph({ detectors: [detectorA], classifications: ACCOUNT_CLASSIFICATIONS });

    expect(graph.resources).toHaveLength(1);
    const entry = graph.resources[0];
    expect(entry?.id).toBe('tenant.widgets');
    expect(entry?.name).toBe('widgets');
    expect(entry?.kind).toBe('sqlalchemy.table');
    expect(entry?.attributes['provenance']).toBe('inherited-from-abstract:models.base.Base');
    expect(entry?.attributes['classQname']).toBe('models.widget.Widget');
    expect(entry?.location).toEqual({ file: widgetFile, line: 28, col: 6 });
    // The resolved symbol retires the detector's unresolved entry.
    expect(graph.unresolved).toEqual([]);
  });

  it('keeps the typed unresolved entry when the base chain carries no literal tablename', () => {
    const file = 'backend/models/computed.py';
    const graph = buildResourceGraph({
      detectors: [
        detector(
          [
            classSymbol({
              source: file,
              location: { file, line: 40, col: 6 },
              attributes: {
                qname: 'models.computed.Gadget',
                resourceKind: 'sqlalchemy.table',
                baseNames: ['models.computed.Base'],
                tablenameUnresolved: true,
              },
            }),
            classSymbol({
              source: file,
              location: { file, line: 5, col: 6 },
              attributes: {
                qname: 'models.computed.Base',
                resourceKind: 'sqlalchemy.table',
                baseNames: [], // abstract but tablename itself computed — no literal anywhere
                tablenameUnresolved: true,
              },
            }),
          ],
          {
            unresolved: [
              {
                code: 'computed_tablename',
                detail: 'f-string tablename',
                location: { file, line: 40, col: 6 },
              },
            ],
          },
        ),
      ],
    });

    // Nothing resolved: the detector's entry survives verbatim…
    expect(graph.resources).toEqual([]);
    const detectorEntry = graph.unresolved.find((u) => u.detectorId !== 'gateforge.graph');
    expect(detectorEntry?.reason.code).toBe('computed_tablename');
    // Both flagged symbols (Base at line 5, Gadget at line 40) synthesize
    // graph-issued entries; the Gadget one must name the failing class.
    const synthesized = graph.unresolved.filter((u) => u.detectorId === 'gateforge.graph');
    expect(synthesized).toHaveLength(2);
    const gadgetEntry = synthesized.find((u) => u.reason.detail.includes('models.computed.Gadget'));
    expect(gadgetEntry?.reason.code).toBe('inherited_tablename_unresolved');
    expect(gadgetEntry?.reason.location).toEqual({ file, line: 40, col: 6 });
  });

  it('prefers the unique same-file base when the last name is shadowed across files', () => {
    const widgetFile = 'backend/models/widget.py';
    // The shadowing `Base` lives in the SAME file as Widget — lexical
    // scope wins over the repo-wide `Base` in other_base.py.
    const ownBaseFile = widgetFile;
    const graph = buildResourceGraph({
      detectors: [
        detector([
          classSymbol({
            source: widgetFile,
            location: { file: widgetFile, line: 9, col: 6 },
            attributes: {
              qname: 'models.widget.Widget',
              resourceKind: 'sqlalchemy.table',
              baseNames: ['Base'], // bare name: same-file symbol must win over the repo-wide one
              tablenameUnresolved: true,
            },
          }),
          classSymbol({
            source: ownBaseFile,
            location: { file: ownBaseFile, line: 3, col: 6 },
            attributes: { qname: 'models.widget.Base', resourceKind: 'sqlalchemy.table', tableName: 'widget_rows' },
          }),
          classSymbol({
            source: 'backend/models/other_base.py',
            location: { file: 'backend/models/other_base.py', line: 3, col: 6 },
            attributes: { qname: 'models.other_base.Base', resourceKind: 'sqlalchemy.table', tableName: 'other_rows' },
          }),
        ]),
      ],
      classifications: {
        schemaVersion: 1,
        resources: {
          'tenant.widget_rows': {
            exposure: 'user-facing',
            plane: 'tenant',
            lifecycle: { create: false, read: true, update: false, delete: false },
            primaryKey: ['id'],
            evidenceAdapter: 'tenant.widget_rows',
          },
        },
      },
    });

    expect(graph.resources).toHaveLength(1);
    expect(graph.resources[0]?.id).toBe('tenant.widget_rows');
    expect(graph.resources[0]?.attributes['provenance']).toBe('inherited-from-abstract:models.widget.Base');
  });

  it('leaves the entry unresolved when a bare base name is ambiguous repo-wide', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector(
          [
            classSymbol({
              source: 'backend/models/widget.py',
              location: { file: 'backend/models/widget.py', line: 9, col: 6 },
              attributes: {
                qname: 'models.widget.Widget',
                resourceKind: 'sqlalchemy.table',
                baseNames: ['Base'], // two repo-wide `Base`s, none in widget.py
                tablenameUnresolved: true,
              },
            }),
            classSymbol({
              source: 'backend/models/a_base.py',
              location: { file: 'backend/models/a_base.py', line: 3, col: 6 },
              attributes: { qname: 'models.a_base.Base', resourceKind: 'sqlalchemy.table', tableName: 'a_rows' },
            }),
            classSymbol({
              source: 'backend/models/b_base.py',
              location: { file: 'backend/models/b_base.py', line: 3, col: 6 },
              attributes: { qname: 'models.b_base.Base', resourceKind: 'sqlalchemy.table', tableName: 'b_rows' },
            }),
          ],
          {
            unresolved: [
              { code: 'no_tablename_source', detail: 'cross-module base', location: { file: 'backend/models/widget.py', line: 9, col: 6 } },
            ],
          },
        ),
      ],
    });

    expect(graph.resources).toEqual([]);
    expect(graph.unresolved.some((u) => u.reason.code === 'no_tablename_source')).toBe(true);
    expect(graph.unresolved.some((u) => u.reason.code === 'inherited_tablename_unresolved')).toBe(true);
  });

  it('guards against inheritance cycles', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([
          classSymbol({
            attributes: {
              qname: 'models.A',
              resourceKind: 'sqlalchemy.table',
              baseNames: ['models.B'],
              tablenameUnresolved: true,
            },
          }),
          classSymbol({
            attributes: {
              qname: 'models.B',
              resourceKind: 'sqlalchemy.table',
              baseNames: ['models.A'],
              tablenameUnresolved: true,
            },
          }),
        ]),
      ],
    });
    expect(graph.resources).toEqual([]);
    expect(graph.unresolved.filter((u) => u.reason.code === 'inherited_tablename_unresolved')).toHaveLength(2);
  });

  it('reports malformed class-symbol payloads as findings instead of crashing', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector([
          classSymbol({ attributes: { qname: 42 } } as unknown as { attributes: Record<string, unknown> }),
        ]),
      ],
    });
    expect(graph.resources).toEqual([]);
    expect(graph.findings[0]?.code).toBe('INVALID_RESOURCE');
  });
});
