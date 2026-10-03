/**
 * Test-directory models never enter the resource graph (problem 14).
 *
 * A pytest module that re-declares a real table's name used to reach the
 * graph as a second business resource: the real table then collided with
 * its own fixture, stayed plane-unresolved, and blocked the gate with no
 * honest answer. `gateforge init` already refused to infer a plane for
 * such a table — the graph now applies the same rule.
 *
 * The rule itself lives in `src/test-paths.ts` (TypeScript) and is
 * mirrored in the python detector; the parity table at the end of this
 * suite pins the TypeScript side against the same cases the end-to-end
 * cases exercise through the detector, because a drift between the two
 * would let a fixture back into the graph.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { FIXTURE_ROOT, runDiscover } from './helpers.js';
import { applyPlanesConfig, isTestSourcePath, type PlaneConfigRule } from '../src/index.js';

/** The fixture tree: one real model plus a fixture copy of the same name. */
const FIXTURE_FILES = [
  'test_dir_tables/models/account.py',
  'test_dir_tables/tests/test_account.py',
] as const;

/** The reviewed plane decision a real repo writes for its model tree. */
const TENANT_RULE: PlaneConfigRule = {
  match: 'test_dir_tables/models/**',
  plane: 'tenant',
  reason: 'the business model tree',
};

type TableResource = DiscoveryOutcome['resources'][number];

/** Temp projects to remove after each case. */
const projects: string[] = [];

const tablesOf = (outcome: DiscoveryOutcome): TableResource[] =>
  outcome.resources.filter((resource) => resource.kind === 'sqlalchemy.table');

/** Copies the fixture tree into a temp project and discovers it. */
async function discoverFixture(): Promise<DiscoveryOutcome> {
  const project = mkdtempSync(join(tmpdir(), 'gateforge-test-dir-'));
  projects.push(project);
  for (const relative of FIXTURE_FILES) {
    mkdirSync(dirname(join(project, relative)), { recursive: true });
    cpSync(join(FIXTURE_ROOT, relative), join(project, relative));
  }
  return runDiscover([...FIXTURE_FILES], { cwd: project });
}

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

describe('test-directory models (problem 14)', () => {
  it('keeps a fixture copy of a real table out of the graph, and the real table resolvable', async () => {
    const outcome = applyPlanesConfig(await discoverFixture(), { rules: [TENANT_RULE] });
    // Exactly one business table, and it is the real one — the fixture's
    // same-named declaration contributes nothing.
    const tables = tablesOf(outcome);
    expect(tables.map((table) => table.attributes['resourceName'])).toEqual(['accounts']);
    expect(tables[0]?.source).toBe('test_dir_tables/models/account.py');
    // The real table resolves its plane normally: no collision, no
    // plane-unresolved resource, no duplicate finding.
    expect(tables[0]?.attributes['plane']).toBe('tenant');
    expect(outcome.findings.map((finding) => finding.code)).not.toContain(
      'DUPLICATE_TABLE_NAME',
    );
    expect(
      outcome.findings.filter((finding) =>
        finding.locations.some((location) => location.file.includes('tests/')),
      ),
    ).toEqual([]);
  });

  it('still records the fixture file as scanned coverage', async () => {
    const outcome = await discoverFixture();
    // Coverage evidence is about what the scan EXAMINED, not what it
    // classified: a hole here would silently invalidate closed-world
    // proofs, so the fixture file stays in the report.
    expect(outcome.scannedPaths).toEqual([...FIXTURE_FILES]);
  });

  it('never lets a fixture class symbol into the graph either', async () => {
    const outcome = await discoverFixture();
    const sources = outcome.resources
      .filter((resource) => resource.kind === 'gateforge.class')
      .map((resource) => resource.source);
    expect(sources.length).toBeGreaterThan(0);
    expect([...new Set(sources)]).toEqual(['test_dir_tables/models/account.py']);
  });

  it('agrees with the python detector on what counts as test surface', () => {
    // The parity table: every case the detector's own segment rule decides
    // (nested tests, a singular segment, a name that merely starts with
    // `test`, a directory that merely CONTAINS the letters).
    for (const [source, expected] of [
      ['tests/test_account.py', true],
      ['backend/tests/services/collector.py', true],
      ['test/models.py', true],
      ['Tests/models.py', true],
      ['models/test_accounts.py', false],
      ['contest/models.py', false],
      ['tests_old/models.py', false],
      ['backend/app/models/account.py', false],
      ['account.py', false],
    ] as const) {
      expect([source, isTestSourcePath(source)]).toEqual([source, expected]);
    }
  });
});