/**
 * GPP/3 subprocess transport suite: the documented
 * `python3 -m gateforge_sqlalchemy_detector` invocation driven through
 * the hardened host, against fixtures replicating the spike's
 * adversarial cases (GF-01/02/19/20/21) plus cross-module inputs.
 *
 * Determinism (plan invariant 7): two fresh sessions over the same
 * paths must produce byte-identical discovery documents.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLASS_SYMBOL_KIND,
  ClassSymbolAttributesSchema,
  ClassificationSignalSchema,
  ResourceSchema,
  type Resource,
} from '@gate-forge/core';
import { isProtocolFailure, PluginSession } from '@gate-forge/plugin-protocol';
import { ALL_FIXTURES, FIXTURE_ROOT, pythonEnv, runDiscover } from './helpers.js';
import { PACK_VERSION } from '../src/version.js';

/** Raw text of the python detector package (version-parity check). */
const PYTHON_INIT = fileURLToPath(
  new URL('../python/gateforge_sqlalchemy_detector/__init__.py', import.meta.url),
);

const byId = (doc: { resources: Resource[] }, id: string): Resource | undefined =>
  doc.resources.find((resource) => resource.id === id);

const tableResources = (doc: { resources: Resource[] }): Resource[] =>
  doc.resources.filter((resource) => resource.kind === 'sqlalchemy.table');

const symbolResources = (doc: { resources: Resource[] }): Resource[] =>
  doc.resources.filter((resource) => resource.kind === CLASS_SYMBOL_KIND);

describe('GPP/3 subprocess transport x python detector', () => {
  it('handshakes, discovers every fixture, and shuts down cleanly', async () => {
    const outcome = await runDiscover(ALL_FIXTURES);
    // Every emitted resource matches the frozen core schema.
    for (const resource of outcome.resources) {
      const parsed = ResourceSchema.safeParse(resource);
      expect(parsed.success, `resource ${resource.id} must validate: ${parsed.error?.issues[0]?.message}`).toBe(true);
    }
    // Class-symbol attributes obey the strict gateforge.class vocabulary.
    for (const resource of symbolResources(outcome)) {
      const parsed = ClassSymbolAttributesSchema.safeParse(resource.attributes);
      expect(parsed.success, `class symbol ${resource.id} must validate`).toBe(true);
    }
    expect(tableResources(outcome)).toHaveLength(36);
    // 61 class symbols: one per declarative/base class across the 21
    // fixtures — non-model fixtures (non_models.py, denylisted_base.py,
    // shadow_schemas.py) contribute ZERO symbols under the phase-2
    // candidate predicate.
    expect(symbolResources(outcome)).toHaveLength(61);
    expect(outcome.unresolved).toHaveLength(17);
    // Row (GF-01) + dupes + rows_worker_b + shared_items (GF-20,
    // base-qualified: collisions + shared_base_models share the imported
    // Base root; modern_declarative's distinct local Base is suppressed)
    // + PARSE_ERROR (GF-19).
    expect(outcome.findings).toHaveLength(5);
  }, 60_000);

  it('is byte-identical across two fresh sessions (determinism, invariant 7)', async () => {
    const first = await runDiscover(ALL_FIXTURES);
    const second = await runDiscover(ALL_FIXTURES);
    // Determinism is a BYTE contract: identical sorted arrays and fixed
    // key order reproduce identical wire bytes across fresh sessions.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  }, 60_000);

  it('matches the pack version pinned in python and the TS entry', async () => {
    const init = readFileSync(PYTHON_INIT, 'utf8');
    expect(init).toContain(`VERSION = "${PACK_VERSION}"`);
  });

  it('GF-20 (base-qualified): flags same-Base duplicates, suppresses distinct-Base ones', async () => {
    // Distinct LOCAL Bases (separate MetaData at runtime) never collide:
    // collisions.py and modern_declarative.py each define their own
    // `class Base(DeclarativeBase)`, so the shared_items group is
    // provably distinct and only the same-file dupes group is flagged.
    const distinctBases = await runDiscover(['collisions.py', 'modern_declarative.py']);
    const distinctDups = distinctBases.findings.filter(
      (finding) => finding.code === 'DUPLICATE_TABLE_NAME',
    );
    expect(distinctDups).toHaveLength(1);
    expect(distinctDups[0]?.detail).toContain("'dupes'");

    // The SAME Base arriving through an import is one MetaData root: the
    // shared_items group (collisions.py + shared_base_models.py) is a
    // real collision and stays flagged, with per-file locations.
    const sameBase = await runDiscover(['collisions.py', 'shared_base_models.py']);
    const sameBaseDups = sameBase.findings.filter(
      (finding) => finding.code === 'DUPLICATE_TABLE_NAME',
    );
    const shared = sameBaseDups.find((f) => f.detail.includes("'shared_items'"));
    const dupes = sameBaseDups.find((f) => f.detail.includes("'dupes'"));
    expect(sameBaseDups).toHaveLength(2);
    expect(shared?.detail).toContain('across 2 file(s)');
    expect(new Set(shared?.locations.map((l) => l.file))).toEqual(
      new Set(['collisions.py', 'shared_base_models.py']),
    );
    // 1-file variant: both declarations in collisions.py.
    expect(dupes?.detail).toContain('across 1 file(s)');
    expect(dupes?.locations).toHaveLength(2);
    expect(new Set(dupes?.locations.map((l) => l.file))).toEqual(new Set(['collisions.py']));

    // Fail closed: a plain Table() call carries no class evidence, so the
    // group it joins can never be proven distinct — flagged even though
    // the class declarations alone would be provably distinct.
    const withTableCall = await runDiscover(['shared_base_models.py', 'modern_declarative.py']);
    const tableCallDups = withTableCall.findings.filter(
      (finding) => finding.code === 'DUPLICATE_TABLE_NAME',
    );
    expect(tableCallDups).toHaveLength(1);
    expect(tableCallDups[0]?.detail).toContain("'shared_items'");
    expect(tableCallDups[0]?.locations).toHaveLength(3);
  }, 60_000);

  it('GF-20: keeps THREE distinct resources for duplicated names, never merged', async () => {
    const outcome = await runDiscover(['collisions.py']);
    const names = tableResources(outcome).map((r) => r.attributes['resourceName']);
    expect(names.sort()).toEqual(['dupes', 'dupes', 'shared_items']);
    const ids = new Set(tableResources(outcome).map((r) => r.id));
    expect(ids.size).toBe(3);
    // Distinct qnames survive: same name, different identity.
    const dupes = tableResources(outcome).filter((r) => r.attributes['resourceName'] === 'dupes');
    expect(new Set(dupes.map((r) => r.attributes['classQname']))).toEqual(
      new Set(['SharedItemsMirror', 'SharedItemsReplica']),
    );
  }, 60_000);

  it('GF-01: function-local shadowing yields 4 distinct stable IDs + a non-collapse finding', async () => {
    const outcome = await runDiscover(['function_local.py']);
    const tables = tableResources(outcome);
    expect(tables).toHaveLength(4);
    const ids = new Set(tables.map((r) => r.id));
    expect(ids.size).toBe(4);
    const finding = outcome.findings.find((f) => f.code === 'CLASS_NAME_REPEATED_IN_FILE');
    expect(finding?.detail).toContain("class name 'Row' occurs in 4 distinct scopes");
    expect(finding?.detail).toContain('build_worker_rows.Row');
    expect(finding?.locations).toHaveLength(4);
    // Qualified names: module Row is unscoped, locals are scope-qualified.
    const qnames = tables.map((r) => r.attributes['classQname']).sort();
    expect(qnames).toEqual([
      'Row',
      'build_queue_rows.Row',
      'build_tenant_rows.Row',
      'build_worker_rows.Row',
    ]);
  }, 60_000);

  it('GF-02: nested-decorator reasons keep the full signature (count + return kind)', async () => {
    const outcome = await runDiscover(['computed_names.py']);
    const widget = outcome.unresolved.find((u) => u.location.line === 28);
    expect(widget?.code).toBe('computed_tablename');
    expect(widget?.detail).toContain('3 decorator(s)');
    expect(widget?.detail).toContain("binop:'widget_' + cls.__name__.lower()");
    // Signature not truncated: the full expression is present.
    expect(widget?.detail.length).toBeGreaterThan(60);
    expect(widget?.location).toEqual({ file: 'computed_names.py', line: 28, col: 0 });
  }, 60_000);

  it('GF-21: every computed-name shape is a typed unresolved entry, never absent', async () => {
    const outcome = await runDiscover(['computed_names.py', 'modern_declarative.py']);
    const codes = outcome.unresolved.map((u) => `${u.code}@${u.location.line}`);
    expect(codes).toContain('computed_tablename@28'); // declared_attr, 3 decorators
    expect(codes).toContain('computed_tablename@40'); // f-string
    expect(codes).toContain('computed_tablename@47'); // call expression
    expect(codes).toContain('computed_tablename@54'); // name reference
    expect(codes).toContain('table_name_derived_runtime@33'); // SQLModel table=True

    const fstring = outcome.unresolved.find((u) => u.location.line === 40);
    expect(fstring?.detail).toContain('assigned from f-string');
    const call = outcome.unresolved.find((u) => u.location.line === 47);
    expect(call?.detail).toContain('assigned from call:resolve_tablename');
    const name = outcome.unresolved.find((u) => u.location.line === 54);
    expect(name?.detail).toContain('assigned from name:doohickey_table_name');

    // Every unresolved class also carries a class symbol asserting
    // `tablenameUnresolved` — the graph's fail-closed hook (D1).
    const widgetSymbol = byId(outcome, 'sqlalchemy.class:computed_names.py:Widget');
    expect(widgetSymbol?.attributes['tablenameUnresolved']).toBe(true);
    const sqlModelSymbol = byId(outcome, 'sqlalchemy.class:modern_declarative.py:SqlModelStyleRow');
    expect(sqlModelSymbol?.attributes['tablenameUnresolved']).toBe(true);
  }, 60_000);

  it('GF-19: a malformed file yields a PARSE_ERROR finding with a line and no resources', async () => {
    const outcome = await runDiscover(['malformed.py', 'legacy_declarative.py']);
    const parseErrors = outcome.findings.filter((f) => f.code === 'PARSE_ERROR');
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]?.locations[0]).toEqual({ file: 'malformed.py', line: 6, col: 0 });
    // The malformed file contributes no resources — the scan did not crash.
    expect(outcome.resources.every((r) => r.source !== 'malformed.py')).toBe(true);
    expect(tableResources(outcome).length).toBeGreaterThan(0);
  }, 60_000);

  it('rejects non-repo-relative paths fail-closed (no path escape)', async () => {
    // A failed discover kills the session (fail closed), so each bad
    // path gets a fresh session.
    const runWith = async (path: string): Promise<void> => {
      const session = new PluginSession({
        command: ['python3', '-m', 'gateforge_sqlalchemy_detector'],
        pluginId: 'gateforge.pack-sqlalchemy',
        pluginVersion: PACK_VERSION,
        cwd: FIXTURE_ROOT,
        env: pythonEnv(),
        timeouts: { handshakeMs: 10_000, requestMs: 30_000, shutdownMs: 10_000 },
      });
      try {
        await session.start();
        await expect(session.discover([path])).rejects.toSatisfy((error: unknown) => {
          expect(isProtocolFailure(error, 'E_PLUGIN_ERROR')).toBe(true);
          return true;
        });
      } finally {
        await session.dispose();
      }
    };
    await runWith('/etc/passwd'); // absolute path
    await runWith('../outside.py'); // `..` escape
  }, 60_000);
});

describe('classification signals (plan phase 3, ADR 0003 D1)', () => {
  /** Signal lookup by dimension + target name. */
  const signalsOf = (
    outcome: { classificationSignals: Array<{ dimension: string; target: { resourceName?: string } }> },
    dimension: string,
    name?: string,
  ): unknown[] =>
    outcome.classificationSignals.filter(
      (s) => s.dimension === dimension && (name === undefined || s.target.resourceName === name),
    );

  it('every emitted signal validates against the frozen core schema', async () => {
    const outcome = await runDiscover(ALL_FIXTURES);
    for (const signal of outcome.classificationSignals) {
      const parsed = ClassificationSignalSchema.safeParse(signal);
      expect(parsed.success, `signal ${JSON.stringify(signal)} must validate`).toBe(true);
    }
    // Phase-3 guard: a table declaration NEVER claims exposure.
    expect(outcome.classificationSignals.every((s) => s.dimension !== 'exposure')).toBe(true);
  }, 60_000);

  it('simple and composite PK fixtures emit ORDERED identity signals', async () => {
    const outcome = await runDiscover(['composite_pk.py']);
    const assertionOf = (name: string): unknown => {
      const signals = signalsOf(outcome, 'identity', name);
      expect(signals).toHaveLength(1);
      return (signals[0] as { assertion: unknown }).assertion;
    };
    // Simple key.
    expect(assertionOf('simple_pks')).toEqual(['id']);
    // Composite key in column written order.
    expect(assertionOf('composite_pks')).toEqual(['tenant_id', 'member_no']);
    // Composite via PrimaryKeyConstraint: the constraint's literal order wins.
    expect(assertionOf('constraint_pks')).toEqual(['region', 'banner']);
    // mapped_column style.
    expect(assertionOf('mapped_pks')).toEqual(['id']);
    // Composite on a raw Table() call.
    expect(assertionOf('orders')).toEqual(['shop_id', 'order_no']);
  }, 60_000);

  it('soft-delete fixture emits archive semantics and owner-state evidence', async () => {
    const outcome = await runDiscover(['signals_archive.py']);
    const semantics = signalsOf(outcome, 'delete-semantics', 'archived_docs');
    expect(semantics).toHaveLength(1);
    expect(semantics[0]).toMatchObject({
      assertion: 'archive',
      basis: 'declaration',
      source: 'gateforge.declaration:delete-semantics',
    });
    const archiveState = signalsOf(outcome, 'archive-state', 'archived_docs');
    expect(archiveState).toHaveLength(1);
    expect(archiveState[0]).toMatchObject({
      assertion: { status: 'archived' },
      basis: 'declaration',
      source: 'gateforge.declaration:archive-state',
    });
    // Proven hard delete is asserted directly.
    expect(signalsOf(outcome, 'delete-semantics', 'hard_sessions')[0]).toMatchObject({
      assertion: 'hard',
      basis: 'declaration',
    });
    // Read-only declarations assert lifecycle unsupported — assertions the
    // core classifier consumes conservatively, never suppressions.
    for (const operation of ['create', 'update', 'delete']) {
      expect(signalsOf(outcome, `lifecycle.${operation}`, 'read_only_ledger')[0]).toMatchObject({
        assertion: false,
        basis: 'declaration',
        source: 'gateforge.declaration:read-only',
      });
    }
  }, 60_000);

  it('computed or invisible identity and archive state become unresolved, never guessed', async () => {
    const outcome = await runDiscover(['signals_computed_pk.py', 'signals_archive.py']);
    // No identity signal exists for either broken-key table.
    expect(signalsOf(outcome, 'identity', 'computed_pks')).toHaveLength(0);
    expect(signalsOf(outcome, 'identity', 'inherited_pks')).toHaveLength(0);
    const codes = outcome.unresolved.map((u) => u.code);
    expect(codes).toContain('PRIMARY_KEY_UNRESOLVED');
    expect(codes).toContain('ARCHIVE_STATE_UNRESOLVED');
    const computedPk = outcome.unresolved.find(
      (u) => u.code === 'PRIMARY_KEY_UNRESOLVED' && u.location.line === 22,
    );
    expect(computedPk?.detail).toContain('computed');
    const inheritedPk = outcome.unresolved.find(
      (u) => u.code === 'PRIMARY_KEY_UNRESOLVED' && u.location.line === 29,
    );
    expect(inheritedPk?.detail).toContain("never defaulted to 'id'");
    // No archive-state signal for the non-literal declaration.
    expect(signalsOf(outcome, 'archive-state', 'computed_archive')).toHaveLength(0);
  }, 60_000);

  it('foreign-key and soft-delete-candidate facts ride attributes, never semantics', async () => {
    const outcome = await runDiscover(['composite_pk.py']);
    const fkTable = tableResources(outcome).find(
      (r) => r.attributes['resourceName'] === 'fk_tables',
    );
    expect(fkTable?.attributes['foreignKeyReferences']).toEqual([
      { column: 'parent_id', references: 'simple_pks.id' },
    ]);
    expect(fkTable?.attributes['softDeleteCandidateFields']).toEqual(['deleted_at']);
    expect(fkTable?.attributes['primaryKeyColumns']).toEqual(['id']);
    // A candidate column without a declaration emits NO delete-semantics.
    expect(signalsOf(outcome, 'delete-semantics', 'fk_tables')).toHaveLength(0);
  }, 60_000);

  it('updateable-field declarations ride attributes, literal ones only', async () => {
    const outcome = await runDiscover(['signals_updateable.py']);
    const attrOf = (name: string): unknown => {
      const table = tableResources(outcome).find(
        (r) => r.attributes['resourceName'] === name,
      );
      expect(table, `table resource ${name}`).toBeDefined();
      return table?.attributes['updateableFields'];
    };
    // Tuple and list literals are copied in written order.
    expect(attrOf('departments')).toEqual(['name', 'description']);
    expect(attrOf('settings')).toEqual(['theme']);
    // Non-literal and empty declarations contribute NOTHING — never a guess.
    expect(attrOf('computed_fields')).toBeUndefined();
    expect(attrOf('empty_fields')).toBeUndefined();
  }, 60_000);

  it('signal documents are deterministic across sessions (byte-identical)', async () => {
    const first = await runDiscover(['composite_pk.py', 'signals_archive.py']);
    const second = await runDiscover(['composite_pk.py', 'signals_archive.py']);
    expect(JSON.stringify(first.classificationSignals)).toBe(
      JSON.stringify(second.classificationSignals),
    );
  }, 60_000);
});