/**
 * SQLModel tables: the canonical FastAPI template's model style.
 *
 * `class Item(SQLModel, table=True)` declares a real table whose name
 * SQLModel derives at runtime by lowercasing the class name. Before this
 * suite the detector only understood declarative bases, so an app written
 * this way produced ZERO model resources and the whole persistence layer
 * was invisible to the gate.
 *
 * Pinned here, in both directions:
 *   - `table=True` on a SQLModel base yields a table resource, with the
 *     framework-derived name and the `sqlmodel-class-name` provenance;
 *   - a SQLModel class WITHOUT `table=True` (and one with `table=False`)
 *     is a plain class, not a model, and stays invisible in every channel.
 *
 * Deterministic and offline: the documented `python3 -m
 * gateforge_sqlalchemy_detector` subprocess over a fixture that is never
 * imported or executed.
 */
import { describe, expect, it } from 'vitest';
import { runDiscover } from './helpers.js';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';

interface AttrResource {
  attributes: Record<string, unknown>;
}

const tables = (outcome: DiscoveryOutcome): AttrResource[] =>
  outcome.resources.filter((r) => r.kind === 'sqlalchemy.table') as AttrResource[];
const symbols = (outcome: DiscoveryOutcome): AttrResource[] =>
  outcome.resources.filter((r) => r.kind === 'gateforge.class') as AttrResource[];

/** The resource name a signal targets, read through a checked guard. */
const targetNameOf = (target: unknown): string =>
  typeof target === 'object' && target !== null && 'resourceName' in target &&
  typeof target.resourceName === 'string'
    ? target.resourceName
    : '';

describe('SQLModel: table=True classes are detected with their table names', () => {
  it('emits one table per SQLModel table=True class, named by SQLModel rules', async () => {
    const outcome = await runDiscover(['sqlmodel_tables.py']);
    expect(
      tables(outcome)
        .map((table) => table.attributes['resourceName'])
        .sort(),
    ).toEqual(['hero', 'item', 'named_item']);
  }, 60_000);

  it('labels the derived name as sqlmodel-class-name, a literal name as literal', async () => {
    const outcome = await runDiscover(['sqlmodel_tables.py']);
    const provenanceOf = (name: string): unknown =>
      tables(outcome).find((table) => table.attributes['resourceName'] === name)
        ?.attributes['tablenameProvenance'];
    expect(provenanceOf('hero')).toBe('sqlmodel-class-name');
    expect(provenanceOf('item')).toBe('sqlmodel-class-name');
    expect(provenanceOf('named_item')).toBe('literal');
    for (const table of tables(outcome)) {
      expect(table.attributes['tableKeywordTrue']).toBe(true);
      expect(table.attributes['abstract']).toBe(false);
    }
  }, 60_000);

  it('reads SQLModel Field() facts: primary key and foreign key targets', async () => {
    const outcome = await runDiscover(['sqlmodel_tables.py']);
    const item = tables(outcome).find(
      (table) => table.attributes['resourceName'] === 'item',
    );
    expect(item?.attributes['primaryKeyColumns']).toEqual(['id']);
    expect(item?.attributes['foreignKeyReferences']).toEqual([
      { column: 'hero_id', references: 'hero.id' },
    ]);
    const identityTargets = outcome.classificationSignals
      .filter((signal) => signal.dimension === 'identity')
      .map((signal) => targetNameOf(signal.target));
    expect(identityTargets.sort()).toEqual(['hero', 'item']);
  }, 60_000);

  it('keeps a derived-name table out of the unresolved channels', async () => {
    const outcome = await runDiscover(['sqlmodel_tables.py']);
    expect(
      outcome.unresolved.filter(
        (entry) =>
          entry.location.file === 'sqlmodel_tables.py' &&
          entry.code === 'table_name_derived_runtime',
      ),
    ).toEqual([]);
    const symbol = symbols(outcome).find(
      (entry) => entry.attributes['qname'] === 'Item',
    );
    expect(symbol?.attributes['tablenameUnresolved']).toBe(false);
    expect(symbol?.attributes['tableName']).toBe('item');
  }, 60_000);

  it('a SQLModel class without table=True is NOT a model (no resource at all)', async () => {
    const outcome = await runDiscover(['sqlmodel_tables.py']);
    const names = [
      ...symbols(outcome).map((entry) => entry.attributes['qname'] as string),
      ...tables(outcome).map((table) => table.attributes['classQname'] as string),
    ];
    expect(names).not.toContain('ItemCreate');
    expect(names).not.toContain('HeroStats');
    // The only unresolved entry left is the INHERITED primary key of
    // `NamedItem` (declared on `Item`, invisible to a flat scan): GF-21
    // keeps it typed instead of defaulting it to 'id'.
    expect(
      outcome.unresolved
        .filter((entry) => entry.location.file === 'sqlmodel_tables.py')
        .map((entry) => `${entry.code}@${entry.location.line}`),
    ).toEqual(['PRIMARY_KEY_UNRESOLVED@28']);
  }, 60_000);
});
