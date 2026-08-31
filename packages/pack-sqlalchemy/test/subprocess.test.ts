/**
 * GPP/2 subprocess transport suite: the documented
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
  ResourceSchema,
  type Resource,
} from '@gateforge/core';
import { isProtocolFailure, PluginSession } from '@gateforge/plugin-protocol';
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

describe('GPP/2 subprocess transport x python detector', () => {
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
    expect(tableResources(outcome)).toHaveLength(12);
    // 29 class symbols: one per declarative/base class across the 10 fixtures.
    expect(symbolResources(outcome)).toHaveLength(29);
    expect(outcome.unresolved).toHaveLength(9);
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

  it('GF-20: emits DUPLICATE_TABLE_NAME findings for the 2-file and 1-file variants', async () => {
    const outcome = await runDiscover([
      'collisions.py',
      'modern_declarative.py',
    ]);
    const duplicates = outcome.findings.filter(
      (finding) => finding.code === 'DUPLICATE_TABLE_NAME',
    );
    const shared = duplicates.find((f) => f.detail.includes("'shared_items'"));
    const dupes = duplicates.find((f) => f.detail.includes("'dupes'"));
    expect(duplicates).toHaveLength(2);
    // 2-file variant: one location per file, distinct files counted.
    expect(shared?.detail).toContain('across 2 file(s)');
    expect(shared?.locations).toHaveLength(2);
    expect(new Set(shared?.locations.map((l) => l.file))).toEqual(
      new Set(['collisions.py', 'modern_declarative.py']),
    );
    // 1-file variant: both declarations in collisions.py.
    expect(dupes?.detail).toContain('across 1 file(s)');
    expect(dupes?.locations).toHaveLength(2);
    expect(new Set(dupes?.locations.map((l) => l.file))).toEqual(new Set(['collisions.py']));
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