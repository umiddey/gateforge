/**
 * Phase 7 scope expansion (plan §12, F7/D4): configuration changes expand
 * `check --changed` to all obligations instead of escaping the gate.
 *
 * - A policy-only (or classification/planes/adapter/waiver/manifest/
 *   ignore-control) staged change yields the NEW obligations as blocking,
 *   carries effective-scope expansion metadata, and exits 1.
 * - Source-only changes keep the narrower scope; substring directory
 *   matches do not expand; providers agree on equivalent changes.
 * - Blocker attribution uses the multi-source (join-aware) mapping, so a
 *   frontend-only joined change keeps its block and unknown-location
 *   blocks stay visible; classifier/stale/scan blocks are never hidden.
 * - A staged/working-tree mismatch is diagnosed, never silently certified.
 *
 * Red-probe rule: on the pre-Phase-7 tree the config-only cases narrow to
 * zero obligations (the F7 escape) and the joined-frontend unclassified
 * block is dropped — these tests fail there and pass after the fix.
 */
import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  withTempRepo,
  type BlockingEntry,
  type Obligation,
  type ResourceGraph,
} from '@gateforge/core';
import { evaluateRun } from '../src/evaluate.js';
import {
  computeEvaluationScope,
  detectStagedWorkingTreeMismatches,
} from '../src/scope.js';
import { resolveStateDir } from '../src/state.js';
import {
  FIXED_AT,
  fixtureFingerprint,
  installFixture,
  OBLIGATION_ACCOUNTS,
  OBLIGATION_ORDERS,
  POLICIES_YML,
  runCli,
} from './helpers.js';

/** Policy document with an added `persistence:update` requirement. */
const POLICIES_WITH_UPDATE_YML = `\
schemaVersion: 1
policies:
  - id: user-facing-crud
    when:
      exposure: user-facing
    require:
      - persistence:read
      - persistence:update
`;

/** The two new obligations a policy-only update-requirement change adds. */
const OBLIGATION_ACCOUNTS_UPDATE = 'tenant.accounts:persistence:update';
const OBLIGATION_ORDERS_UPDATE = 'tenant.orders:persistence:update';

/** Parses the json-format check report, including scope metadata. */
function parseScopeReport(report: string): {
  summary: { blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string; reason: string | null }>;
  blocking: Array<{ kind: string; detail?: string }>;
  run: { provider: string };
  scope?: { mode: string; expandedBecause: string[] };
} {
  return JSON.parse(report);
}

/** A valid, unexpired waiver for one fixture obligation. */
function waiverJson(resourceId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: 'team-' + resourceId.split('.')[1],
    justificationUrl: 'https://example.invalid/justification',
    approver: 'approver@example.invalid',
    scope: { kind: 'exact', resourceId, fingerprint: fixtureFingerprint(resourceId) },
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
}

describe('F7: policy-only staged change expands check --changed to all', () => {
  it('new obligations are present, blocking, with expansion metadata, exit 1', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ '.gateforge/policies.yml': POLICIES_WITH_UPDATE_YML });
      repo.stage(['.gateforge/policies.yml']);

      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.run.provider).toBe('local-staged');
      expect(report.scope?.mode).toBe('all');
      expect(report.scope?.expandedBecause).toContain('.gateforge/policies.yml');
      expect(report.verdicts.map((v) => v.obligationId).sort()).toEqual(
        [
          OBLIGATION_ACCOUNTS,
          OBLIGATION_ACCOUNTS_UPDATE,
          OBLIGATION_ORDERS,
          OBLIGATION_ORDERS_UPDATE,
        ].sort(),
      );
      expect(report.verdicts.every((v) => v.verdict === 'missing')).toBe(true);
      expect(report.summary.blocking).toBe(4);
    });
  });

  it('a custom policy path change expands (never ignored for differing from the default)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const configYml = (
        await import('node:fs').then((fs) => fs.readFileSync(repo.path('.gateforge.yml'), 'utf8'))
      ).replace('policies: .gateforge/policies.yml', 'policies: .gateforge/custom-policies.yml');
      repo.writeFiles({
        '.gateforge.yml': configYml,
        '.gateforge/custom-policies.yml': POLICIES_YML,
      });
      repo.commitFiles({}, 'base with custom policy path');
      repo.writeFiles({ '.gateforge/custom-policies.yml': POLICIES_WITH_UPDATE_YML });
      repo.stage(['.gateforge/custom-policies.yml']);

      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('all');
      expect(report.scope?.expandedBecause).toContain('.gateforge/custom-policies.yml');
      expect(report.verdicts.map((v) => v.obligationId).sort()).toEqual(
        [
          OBLIGATION_ACCOUNTS,
          OBLIGATION_ACCOUNTS_UPDATE,
          OBLIGATION_ORDERS,
          OBLIGATION_ORDERS_UPDATE,
        ].sort(),
      );
    });
  });

  it('a classification-policy change expands to all obligations', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({
        '.gateforge/classification-policy.yml': (
          await import('node:fs').then((fs) =>
            fs.readFileSync(repo.path('.gateforge/classification-policy.yml'), 'utf8'),
          )
        ).concat('# scope probe\n'),
      });
      repo.stage(['.gateforge/classification-policy.yml']);

      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('all');
      expect(report.scope?.expandedBecause).toContain('.gateforge/classification-policy.yml');
      expect(report.verdicts.map((v) => v.obligationId).sort()).toEqual(
        [OBLIGATION_ACCOUNTS, OBLIGATION_ORDERS].sort(),
      );
    });
  });

  it('planes config creation and deletion expand (gate-defining pack input)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ '.gateforge/planes.json': '{"rules": []}\n' });
      repo.stage(['.gateforge/planes.json']);
      {
        const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
        expect(code).toBe(1);
        const report = parseScopeReport(stdout);
        expect(report.scope?.mode).toBe('all');
        expect(report.scope?.expandedBecause).toContain('.gateforge/planes.json');
        expect(report.verdicts).toHaveLength(2);
      }
      repo.commitFiles({}, 'planes added');
      repo.git(['rm', '--quiet', '.gateforge/planes.json']);
      {
        const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
        expect(code).toBe(1);
        const report = parseScopeReport(stdout);
        expect(report.scope?.mode).toBe('all');
        expect(report.scope?.expandedBecause).toContain('.gateforge/planes.json');
        expect(report.verdicts).toHaveLength(2);
      }
    });
  });

  it('http-clients and fastapi creation expand', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ '.gateforge/http-clients.json': '{}\n' });
      repo.stage(['.gateforge/http-clients.json']);
      const created = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(created.code).toBe(1);
      expect(parseScopeReport(created.stdout).scope?.mode).toBe('all');
      expect(parseScopeReport(created.stdout).scope?.expandedBecause).toContain(
        '.gateforge/http-clients.json',
      );
      repo.commitFiles({}, 'http-clients added');
      repo.writeFiles({ '.gateforge/fastapi.json': '{}\n' });
      repo.stage(['.gateforge/fastapi.json']);
      const fastapi = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(fastapi.code).toBe(1);
      expect(parseScopeReport(fastapi.stdout).scope?.mode).toBe('all');
      expect(parseScopeReport(fastapi.stdout).scope?.expandedBecause).toContain(
        '.gateforge/fastapi.json',
      );
    });
  });

  it('an adapter change expands (adapter directory, segment-matched)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ '.gateforge/adapters/accounts.mjs': 'export default { v: 2 };\n' });
      repo.stage(['.gateforge/adapters/accounts.mjs']);
      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('all');
      expect(
        report.scope?.expandedBecause.some((reason) => reason.includes('.gateforge/adapters')),
      ).toBe(true);
      expect(report.verdicts).toHaveLength(2);
    });
  });

  it('a waiver change expands so affected exceptions are reevaluated', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ '.gateforge/waivers/orders.json': waiverJson('tenant.orders') });
      repo.stage(['.gateforge/waivers/orders.json']);
      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('all');
      expect(
        report.scope?.expandedBecause.some((reason) => reason.includes('.gateforge/waivers')),
      ).toBe(true);
      // All obligations are evaluated: accounts still blocks, orders is waived.
      expect(report.verdicts).toHaveLength(2);
      expect(
        report.verdicts.find((v) => v.obligationId === OBLIGATION_ORDERS)?.verdict,
      ).toBe('waived');
      expect(
        report.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS)?.verdict,
      ).toBe('missing');
    });
  });

  it('a dependency manifest change expands', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ 'package.json': '{"name": "fixture"}\n' });
      repo.commitFiles({}, 'base with manifest');
      repo.writeFiles({ 'package.json': '{"name": "fixture", "version": "2.0.0"}\n' });
      repo.stage(['package.json']);
      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('all');
      expect(report.scope?.expandedBecause).toContain('package.json');
      expect(report.verdicts).toHaveLength(2);
    });
  });

  it('a nested ignore-control change expands (scope inventory input)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ 'sub/.gitignore': 'ignored-dir/\n' });
      repo.stage(['sub/.gitignore']);
      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('all');
      expect(report.scope?.expandedBecause).toContain('sub/.gitignore');
    });
  });

  it('a .gateforge.yml pointer change alone triggers a full check', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({
        '.gateforge.yml': (
          await import('node:fs').then((fs) =>
            fs.readFileSync(repo.path('.gateforge.yml'), 'utf8'),
          )
        ).concat('# pointer-change probe\n'),
      });
      repo.stage(['.gateforge.yml']);
      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('all');
      expect(report.scope?.expandedBecause).toContain('.gateforge.yml');
      expect(report.verdicts).toHaveLength(2);
    });
  });
});

describe('F7: source-only scope stays narrow; no substring matches', () => {
  it('a source-only change keeps the narrower scope', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ 'src/orders.txt': 'orders fixture.table\n# changed\n' });
      repo.stage(['src/orders.txt']);
      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('changed');
      expect(report.scope?.expandedBecause).toEqual([]);
      expect(report.verdicts.map((v) => v.obligationId)).toEqual([OBLIGATION_ORDERS]);
    });
  });

  it('a config name in an unrelated directory does not match by substring', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      // `.gateforge/adapters2/` shares a string prefix with the adapters
      // dir but is a different path segment — it must not expand scope.
      repo.writeFiles({ '.gateforge/adapters2/evil.mjs': 'export default {};\n' });
      repo.stage(['.gateforge/adapters2/evil.mjs']);
      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      // Nothing attributable changed: the narrow scope is honestly empty
      // (exit 0), and — the point of this probe — the scope did NOT
      // expand on a mere string-prefix match.
      expect(code).toBe(0);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('changed');
      expect(report.scope?.expandedBecause).toEqual([]);
      expect(report.verdicts).toEqual([]);
    });
  });
});

/** Narrowing guard for closure-assigned run results (TS cannot narrow them). */
function runOrThrow(value: { code: number; stdout: string } | null, label: string): {
  code: number;
  stdout: string;
} {
  if (value === null) {
    throw new Error(`${label} parity run did not execute`);
  }
  return value;
}

describe('F7: provider parity on equivalent config changes', () => {
  it('local-staged and gitlab-mr agree on verdicts and expansion', async () => {
    const change = { '.gateforge/policies.yml': POLICIES_WITH_UPDATE_YML };
    let local: { code: number; stdout: string } | null = null;
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles(change);
      repo.stage(['.gateforge/policies.yml']);
      local = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(local.code).toBe(1);
    });
    let mr: { code: number; stdout: string } | null = null;
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      const baseSha = repo.headSha();
      expect(baseSha).not.toBeNull();
      repo.commitFiles(change, 'policy-only change');
      mr = await runCli(repo, ['check', '--changed', '--format', 'json'], {
        CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha ?? '',
      });
      expect(mr.code).toBe(1);
    });
    if (local === null || mr === null) throw new Error('parity runs did not execute');
    const localReport = parseScopeReport(runOrThrow(local, 'local').stdout);
    const mrReport = parseScopeReport(runOrThrow(mr, 'mr').stdout);
    expect(localReport.run.provider).toBe('local-staged');
    expect(mrReport.run.provider).toBe('gitlab-mr');
    expect(localReport.verdicts).toEqual(mrReport.verdicts);
    expect(localReport.verdicts).toHaveLength(4);
    expect(localReport.scope).toEqual(mrReport.scope);
    expect(localReport.scope?.mode).toBe('all');
  });
});

describe('F7: staged/working-tree mismatch is diagnosed, never certified', () => {
  it('staged verification with a dirty worktree blocks with an explicit diagnostic', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ '.gateforge/policies.yml': POLICIES_WITH_UPDATE_YML });
      repo.stage(['.gateforge/policies.yml']);
      // The worktree moves on after staging: index bytes differ from the
      // bytes discovery actually reads. Certifying "staged" scope from
      // worktree bytes would be dishonest — the run must say so.
      repo.writeFiles({
        '.gateforge/policies.yml': `${POLICIES_WITH_UPDATE_YML}# worktree drift\n`,
      });
      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.scope?.mode).toBe('all');
      const mismatch = report.blocking.find(
        (entry) =>
          entry.kind === 'finding' && (entry.detail ?? '').includes('staged'),
      );
      expect(mismatch).toBeDefined();
      expect(mismatch?.detail).toContain('.gateforge/policies.yml');
    });
  });
});

describe('F7: blocker attribution uses the multi-source mapping', () => {
  /** Synthetic graph: one unclassified resource with a joined frontend call. */
  function joinedGraph(): ResourceGraph {
    return {
      schemaVersion: 1,
      resources: [
        {
          schemaVersion: 1,
          id: 'tenant.ghost',
          name: 'ghost',
          plane: 'tenant',
          kind: 'fixture.resource',
          source: 'backend/ghost.py',
          location: { file: 'backend/ghost.py', line: 1, col: 0 },
          exposure: 'user-facing',
          classification: null,
          classificationTrace: null,
          detector: { id: 'test', version: '1' },
          attributes: { callSources: ['frontend/app.ts:1:0'] },
        },
      ],
      unresolved: [],
      findings: [],
      stale: [],
    } as unknown as ResourceGraph;
  }

  function unclassifiedGhost(): BlockingEntry[] {
    return [
      {
        kind: 'unclassified',
        resourceId: 'tenant.ghost',
        name: 'ghost',
        detail: 'ghost has no effective classification',
        location: { file: 'backend/ghost.py', line: 1, col: 0 },
      },
    ];
  }

  it('a frontend-only joined change keeps the unclassified block', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(repo.path('.gateforge.yml'));
      const result = evaluateRun({
        cwd: repo.root,
        config,
        graph: joinedGraph(),
        obligations: [],
        blocking: unclassifiedGhost(),
        stateDir: resolveStateDir(repo.root),
        now: FIXED_AT,
        changedFiles: ['frontend/app.ts'],
      });
      expect(result.blocking).toHaveLength(1);
      expect(result.blocking[0]).toMatchObject({ kind: 'unclassified' });
    });
  });

  it('an unrelated change drops only the attributable unclassified block', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(repo.path('.gateforge.yml'));
      const result = evaluateRun({
        cwd: repo.root,
        config,
        graph: joinedGraph(),
        obligations: [],
        blocking: unclassifiedGhost(),
        stateDir: resolveStateDir(repo.root),
        now: FIXED_AT,
        changedFiles: ['other.txt'],
      });
      expect(result.blocking).toHaveLength(0);
    });
  });

  it('unknown-location, classifier, stale, and scan blocks are never hidden', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(repo.path('.gateforge.yml'));
      const blocking: BlockingEntry[] = [
        {
          kind: 'finding',
          resourceId: null,
          name: null,
          detail: 'no-location scan failure',
          location: null,
        },
        {
          kind: 'classification',
          resourceId: 'tenant.ghost',
          name: 'ghost',
          detail: 'classifier contradiction on ghost',
          location: { file: 'backend/ghost.py', line: 1, col: 0 },
        },
        {
          kind: 'stale-reference',
          resourceId: null,
          name: 'ghost-claim',
          detail: 'claim points at a removed resource',
          location: null,
        },
        {
          kind: 'finding',
          resourceId: null,
          name: null,
          detail: 'src/data: EACCES; the scan scope has a hole',
          location: { file: 'src/data', line: 1, col: 0 },
        },
      ];
      const result = evaluateRun({
        cwd: repo.root,
        config,
        graph: joinedGraph(),
        obligations: [],
        blocking,
        stateDir: resolveStateDir(repo.root),
        now: FIXED_AT,
        changedFiles: ['other.txt'],
      });
      expect(result.blocking).toHaveLength(4);
    });
  });

  it('a frontend-only joined change includes the endpoint obligation', async () => {    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(repo.path('.gateforge.yml'));
      const obligation: Obligation = {
        schemaVersion: 1,
        id: 'tenant.ghost:persistence:read',
        resourceId: 'tenant.ghost',
        contract: 'persistence:read',
        policyId: 'user-facing-crud',
        lifecycle: {
          create: false,
          read: true,
          update: false,
          delete: false,
          deleteSemantics: undefined,
        },
      };
      const result = evaluateRun({
        cwd: repo.root,
        config,
        graph: joinedGraph(),
        obligations: [obligation],
        blocking: [],
        stateDir: resolveStateDir(repo.root),
        now: FIXED_AT,
        changedFiles: ['frontend/app.ts'],
      });
      expect(result.verdicts.map((v) => v.obligation.id)).toEqual([
        'tenant.ghost:persistence:read',
      ]);
    });
  });
});

describe('F7: scope decision unit matrix (segment matching, deletions)', () => {
  it('matches every gate-defining family and nothing else', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(repo.path('.gateforge.yml'));
      const decide = (changedFiles: readonly string[]): ReturnType<typeof computeEvaluationScope> =>
        computeEvaluationScope({ config, changedFiles });
      expect(decide(['src/orders.txt']).mode).toBe('changed');
      expect(decide(['.gateforge.yml'])).toMatchObject({
        mode: 'all',
        expandedBecause: ['.gateforge.yml'],
      });
      expect(decide(['.gateforge/policies.yml']).expandedBecause).toEqual([
        '.gateforge/policies.yml',
      ]);
      expect(decide(['.gateforge/classification-policy.yml']).expandedBecause).toEqual([
        '.gateforge/classification-policy.yml',
      ]);
      expect(decide(['.gateforge/planes.json']).expandedBecause).toEqual([
        '.gateforge/planes.json',
      ]);
      expect(decide(['.gateforge/http-clients.json']).expandedBecause).toEqual([
        '.gateforge/http-clients.json',
      ]);
      expect(decide(['.gateforge/fastapi.json']).expandedBecause).toEqual([
        '.gateforge/fastapi.json',
      ]);
      expect(decide(['.gateforge/adapters/orders.mjs']).expandedBecause).toEqual([
        '.gateforge/adapters',
      ]);
      expect(decide(['.gateforge/waivers/orders.json']).expandedBecause).toEqual([
        '.gateforge/waivers',
      ]);
      expect(decide(['plugin.mjs']).expandedBecause).toEqual(['plugin.mjs']);
      expect(decide(['package.json']).expandedBecause).toEqual(['package.json']);
      expect(decide(['sub/package-lock.json']).expandedBecause).toEqual([
        'sub/package-lock.json',
      ]);
      expect(decide(['sub/.gitignore']).expandedBecause).toEqual(['sub/.gitignore']);
      expect(decide(['.gitattributes']).expandedBecause).toEqual(['.gitattributes']);
      // Deleted files are still in the changed list and must trigger.
      expect(decide(['.gateforge/planes.json']).mode).toBe('all');
      // Segment, not substring: sibling directories never match.
      expect(decide(['.gateforge/adapters2/evil.mjs']).mode).toBe('changed');
      expect(decide(['.gateforge/waivers-backup/x.json']).mode).toBe('changed');
      expect(decide(['src/package.json.bak']).mode).toBe('changed');
      // Sorted, deduplicated reasons across several matches.
      expect(
        decide(['.gateforge/policies.yml', 'src/orders.txt', '.gateforge.yml']),
      ).toMatchObject({
        mode: 'all',
        expandedBecause: ['.gateforge.yml', '.gateforge/policies.yml'],
      });
    });
  });

  it('honors custom configured paths (no default-list comparison)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const raw = (
        await import('node:fs').then((fs) => fs.readFileSync(repo.path('.gateforge.yml'), 'utf8'))
      )
        .replace('policies: .gateforge/policies.yml', 'policies: config/custom-policies.yml')
        .replace(
          'classificationPolicy: .gateforge/classification-policy.yml',
          'classificationPolicy: config/custom-classification.yml',
        );
      repo.writeFiles({ '.gateforge.yml': raw });
      const config = loadConfig(repo.path('.gateforge.yml'));
      // The default paths are no longer gate-defining for this repo…
      expect(
        computeEvaluationScope({ config, changedFiles: ['.gateforge/policies.yml'] }).mode,
      ).toBe('changed');
      // …while the custom paths are.
      expect(
        computeEvaluationScope({ config, changedFiles: ['config/custom-policies.yml'] }),
      ).toMatchObject({
        mode: 'all',
        expandedBecause: ['config/custom-policies.yml'],
      });
      expect(
        computeEvaluationScope({ config, changedFiles: ['config/custom-classification.yml'] }),
      ).toMatchObject({
        mode: 'all',
        expandedBecause: ['config/custom-classification.yml'],
      });
    });
  });

  it('detects staged/working-tree mismatches exactly', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      expect(detectStagedWorkingTreeMismatches(repo.root, {})).toEqual([]);
      repo.writeFiles({ 'src/orders.txt': 'orders fixture.table\n# v2\n' });
      repo.stage(['src/orders.txt']);
      // Staged and clean: no mismatch.
      expect(detectStagedWorkingTreeMismatches(repo.root, {})).toEqual([]);
      // Staged, then the worktree moves on: mismatch.
      repo.writeFiles({ 'src/orders.txt': 'orders fixture.table\n# v3\n' });
      expect(detectStagedWorkingTreeMismatches(repo.root, {})).toEqual(['src/orders.txt']);
    });
  });
});

describe('F7: effective-scope reporting (JSON, SARIF, text)', () => {
  it('sarif carries the scope in the run property bag; text explains the expansion', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ '.gateforge/policies.yml': POLICIES_WITH_UPDATE_YML });
      repo.stage(['.gateforge/policies.yml']);

      const sarif = await runCli(repo, ['check', '--changed', '--format', 'sarif']);
      expect(sarif.code).toBe(1);
      const document = JSON.parse(sarif.stdout) as {
        runs: Array<{ properties?: { scope?: { mode: string; expandedBecause: string[] } } }>;
      };
      expect(document.runs[0]?.properties?.scope?.mode).toBe('all');
      expect(document.runs[0]?.properties?.scope?.expandedBecause).toContain(
        '.gateforge/policies.yml',
      );

      const text = await runCli(repo, ['check', '--changed', '--format', 'text']);
      expect(text.code).toBe(1);
      expect(text.stdout).toContain(
        'scope: all obligations; expanded because .gateforge/policies.yml',
      );
    });
  });

  it('json always carries effective-scope metadata, even for full runs', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseScopeReport(stdout);
      expect(report.run.provider).toBe('all-files');
      expect(report.scope).toEqual({ mode: 'all', expandedBecause: [] });
    });
  });
});
