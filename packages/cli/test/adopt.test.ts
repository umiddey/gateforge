/**
 * `gateforge adopt` end-to-end (phase 8 workstream C): the one
 * sanctioned bulk-add. Adopt on a fixture repo with findings seeds the
 * baseline + wires the gate + exits 0; a second adopt is a no-op
 * success; `baseline update` stays subset-only after adoption; check
 * exits 0 post-adopt with the forgiveness loud; and every laundering-
 * shaped corner fails closed (unrecorded baseline forgives nothing,
 * record-without-baseline exits 2).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockingEntryFingerprint } from '@gateforge/core';
import {
  FIXED_AT,
  PLUGIN_SOURCE,
  fixtureFingerprint,
  installFixture,
  runCli,
  withTempRepo,
} from './helpers.js';

const BASELINE_PATH = '.gateforge/baselines/obligations.json';
const RECORD_PATH = '.gateforge/baselines/adoption.json';

/** The fixture plugin, extended to emit one detector finding. */
const FINDING_PLUGIN_SOURCE = PLUGIN_SOURCE.replace(
  'return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
  'return { resources, unresolved: [], findings: [{ code: "PARTIAL_DISCOVERY", detail: "fixture finding: one route unverified", locations: [{ file: "src/accounts.txt", line: 1, col: 0 }] }], classificationSignals, scannedPaths };',
);

/**
 * The fixture plugin, with every resource plane-signaled EXCEPT `legacy`
 * (and `orphos`, introduced post-adopt as the NEW blocked resource): a
 * resource with no plane evidence blocks classification — PLANE_UNRESOLVED,
 * fail-closed — and generates no obligations. Unlike the base fixture it
 * reports REAL line numbers, so a merge that moves a declaration shifts
 * the whole-entry fingerprints while the resource identity stays put.
 */
const CLASSIFICATION_PLUGIN_SOURCE = PLUGIN_SOURCE.replace(
  "for (const line of text.split('\\n')) {",
  "for (const [lineNo, line] of text.split('\\n').entries()) {",
)
  .replace(
    'const location = { file: rel, line: 1, col: 0 };',
    'const location = { file: rel, line: lineNo + 1, col: 0 };',
  )
  .replace(
    "signal('plane', 'tenant');",
    "if (name !== 'legacy' && name !== 'orphos') signal('plane', 'tenant');",
  );

interface Report {
  summary: { missing: number; waived: number; blocking: number; baselinedObligations?: number; baselinedBlockingEntries?: number; baselinedClassificationBlocked?: number };
  verdicts: Array<{ verdict: string; fingerprint: string }>;
  blocking: Array<{ kind: string; resourceId: string | null; name: string | null; detail: string }>;
}

async function installClassificationFixture(
  repo: Parameters<Parameters<typeof withTempRepo>[1]>[0],
): Promise<void> {
  installFixture(repo);
  repo.writeFiles({
    'plugin.mjs': CLASSIFICATION_PLUGIN_SOURCE,
    'src/legacy.txt': 'legacy fixture.table\n',
    '.gateforge/adapters/legacy.mjs': 'export default {};\n',
  });
}

/** The adoption receipt on disk. */
function receipt(repo: Parameters<Parameters<typeof withTempRepo>[1]>[0]): Record<string, unknown> {
  return JSON.parse(readFileSync(repo.path(RECORD_PATH), 'utf8')) as Record<string, unknown>;
}

async function installFindingFixture(repo: Parameters<Parameters<typeof withTempRepo>[1]>[0]): Promise<void> {
  installFixture(repo);
  repo.writeFiles({ 'plugin.mjs': FINDING_PLUGIN_SOURCE });
}

describe('gateforge adopt — the one sanctioned bulk-add (phase 8 C)', () => {
  it('seeds the baseline from current debt, wires the gate, exits 0', async () => {
    await withTempRepo({}, async (repo) => {
      await installFindingFixture(repo);
      // Pre-adoption: the gate is red (2 missing obligations + 1 finding).
      const pre = await runCli(repo, ['check', '--format', 'json']);
      expect(pre.code).toBe(1);
      const preReport = JSON.parse(pre.stdout) as Report;
      expect(preReport.summary.missing).toBe(2);
      expect(preReport.blocking).toHaveLength(1);
      const entryFp = blockingEntryFingerprint(preReport.blocking[0] as never);

      const { code, stdout } = await runCli(repo, ['adopt']);
      expect(code).toBe(0);
      expect(stdout).toContain('adopted as forgiven: 3; already proven: 0');
      expect(stdout).toContain('verdict:missing: 2');
      expect(stdout).toContain('entry:finding: 1');
      expect(stdout).toContain('shrink-only');
      // Wiring went through the shared init --blocking path.
      expect(existsSync(repo.path('.gateforge/hooks/gateforge-check.sh'))).toBe(true);
      expect(existsSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'))).toBe(true);
      expect(readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8')).toContain('gateforge-check');

      // The baseline holds exactly the captured red set: both obligation
      // fingerprints and the finding's whole-entry fingerprint.
      const baseline = JSON.parse(readFileSync(repo.path(BASELINE_PATH), 'utf8')) as {
        schemaVersion: number;
        fingerprints: string[];
      };
      const expected = [fixtureFingerprint('tenant.accounts'), fixtureFingerprint('tenant.orders'), entryFp].sort();
      expect(baseline).toEqual({ schemaVersion: 1, fingerprints: expected });

      // The loud receipt: dated (fixed clock), count-annotated, valid.
      const record = JSON.parse(readFileSync(repo.path(RECORD_PATH), 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({ schemaVersion: 1, adoptedAt: FIXED_AT, adopted: 3, proven: 0 });
      expect(record['gitSha']).toBeNull(); // fixture repo has no commits
    });
  });

  it('post-adopt check exits 0 with the forgiveness loud', async () => {
    await withTempRepo({}, async (repo) => {
      await installFindingFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);

      const text = await runCli(repo, ['check']);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain(
        'baseline (adopted): 2 obligation(s) + 1 blocking entry(ies) + 0 classification-blocked resource(s) forgiven',
      );
      expect(text.stdout).toContain('exit code: 0');

      const json = await runCli(repo, ['check', '--format', 'json']);
      expect(json.code).toBe(0);
      const report = JSON.parse(json.stdout) as Report;
      expect(report.summary.waived).toBe(2);
      expect(report.summary.missing).toBe(0);
      expect(report.summary.baselinedObligations).toBe(2);
      expect(report.summary.baselinedBlockingEntries).toBe(1);
      expect(report.blocking).toHaveLength(0);
      // The re-graded verdicts name the receipt (invariant 8: explain).
      expect(json.stdout).toContain('baselined: adopted as forgiven');
    });
  });

  it('a second adopt is a no-op success that refuses the second bulk-add', async () => {
    await withTempRepo({}, async (repo) => {
      await installFindingFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);
      const before = readFileSync(repo.path(BASELINE_PATH), 'utf8');
      const hookCount = (): number =>
        readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8').split('id: gateforge-check').length - 1;
      expect(hookCount()).toBe(1);

      const again = await runCli(repo, ['adopt']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('already adopted');
      expect(again.stdout).toContain('baseline update');
      expect(readFileSync(repo.path(BASELINE_PATH), 'utf8')).toBe(before); // untouched
      expect(hookCount()).toBe(1); // wiring stays idempotent
    });
  });

  it('baseline update post-adopt is still subset-only (GF-07/08 unchanged)', async () => {
    await withTempRepo({}, async (repo) => {
      await installFindingFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);
      const baseline = (): { fingerprints: string[] } =>
        JSON.parse(readFileSync(repo.path(BASELINE_PATH), 'utf8') as string);

      // GF-08: shrinking to a strict subset passes.
      const accounts = fixtureFingerprint('tenant.accounts');
      const shrink = await runCli(repo, ['baseline', 'update', accounts]);
      expect(shrink.code).toBe(0);
      expect(shrink.stdout).toContain('baseline updated: 1 fingerprint(s) (was 3)');
      expect(baseline().fingerprints).toEqual([accounts]);

      // GF-07: adding a NEW fingerprint (laundering) still fails closed.
      const laundry = await runCli(repo, [
        'baseline',
        'update',
        accounts,
        fixtureFingerprint('tenant.laundry'),
      ]);
      expect(laundry.code).toBe(2);
      expect(laundry.stderr).toContain('strict subset');
      expect(baseline().fingerprints).toEqual([accounts]);

      // Removing forgiveness returns the red: the finding entry is no
      // longer baselined, so the gate blocks again.
      const post = await runCli(repo, ['check']);
      expect(post.code).toBe(1);
    });
  });

  it('an unrecorded baseline forgives nothing (fail closed)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Hand-written baseline with NO adoption receipt: exactly the
      // laundering-shaped state adoption's record gate exists for.
      repo.writeFiles({
        [BASELINE_PATH]: `${JSON.stringify(
          {
            schemaVersion: 1,
            fingerprints: [
              fixtureFingerprint('tenant.accounts'),
              fixtureFingerprint('tenant.orders'),
            ].sort(),
          },
          null,
          2,
        )}\n`,
      });
      const { code, stdout } = await runCli(repo, ['check']);
      expect(code).toBe(1); // not forgiven
      expect(stdout).not.toContain('baseline (adopted)');
    });
  });

  it('a record without its baseline document exits 2 (broken adoption)', async () => {
    await withTempRepo({}, async (repo) => {
      await installFindingFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);
      rmSync(repo.path(BASELINE_PATH));
      const { code, stderr } = await runCli(repo, ['check']);
      expect(code).toBe(2);
      expect(stderr).toContain('baseline');
    });
  });

  it('refuses to run without a gateforge config, and rejects unknown args', async () => {
    await withTempRepo({}, async (repo) => {
      const bare = await runCli(repo, ['adopt']);
      expect(bare.code).toBe(2);
      expect(bare.stderr).toContain('gateforge init');

      await installFindingFixture(repo);
      const unknown = await runCli(repo, ['adopt', '--force']);
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain('unknown arguments for adopt');

      const help = await runCli(repo, ['adopt', '--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('usage: gateforge adopt');
    });
  });
});

describe('gateforge adopt — the classification layer (two-layer adoption)', () => {
  it('records BOTH layers: fingerprints in the baseline, blocked resource ids in the receipt', async () => {
    await withTempRepo({}, async (repo) => {
      await installClassificationFixture(repo);
      // Pre-adoption: 2 missing obligations + legacy blocked twice over
      // (the typed [classification] PLANE_UNRESOLVED entry and its
      // definitional [unclassified] shadow).
      const pre = await runCli(repo, ['check', '--format', 'json']);
      expect(pre.code).toBe(1);
      const preReport = JSON.parse(pre.stdout) as Report;
      expect(preReport.summary.missing).toBe(2);
      expect(preReport.blocking).toHaveLength(2);
      expect(preReport.blocking.map((entry) => entry.kind).sort()).toEqual(['classification', 'unclassified']);

      const { code, stdout } = await runCli(repo, ['adopt']);
      expect(code).toBe(0);
      expect(stdout).toContain('adopted as forgiven: 4; already proven: 0');
      expect(stdout).toContain('entry:classification: 1');
      expect(stdout).toContain('entry:unclassified: 1');
      expect(stdout).toContain('classification layer adopted: 1 blocked resource(s)');

      // The receipt carries the classification layer under the bare-name
      // namespace: a plane-unresolved resource has no plane-qualified id.
      expect(receipt(repo)).toMatchObject({
        schemaVersion: 1,
        adoptedAt: FIXED_AT,
        adopted: 4,
        proven: 0,
        classificationBlocked: ['name:legacy'],
      });
      // And the fingerprint baseline still holds every captured red.
      const baseline = JSON.parse(readFileSync(repo.path(BASELINE_PATH), 'utf8')) as {
        fingerprints: string[];
      };
      expect(baseline.fingerprints).toHaveLength(4);
    });
  });

  it('post-adopt check exits 0: the classification waiver is loud, the resource not exit-counted', async () => {
    await withTempRepo({}, async (repo) => {
      await installClassificationFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);

      const text = await runCli(repo, ['check']);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain(
        'baseline (adopted): 2 obligation(s) + 0 blocking entry(ies) + 1 classification-blocked resource(s) forgiven',
      );
      expect(text.stdout).not.toContain('PLANE_UNRESOLVED');
    });
  });

  it('post-adopt check (json): waived via the receipt, absent from blocking, exit 0', async () => {
    await withTempRepo({}, async (repo) => {
      await installClassificationFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);

      const json = await runCli(repo, ['check', '--format', 'json']);
      expect(json.code).toBe(0);
      const report = JSON.parse(json.stdout) as Report;
      expect(report.summary.baselinedClassificationBlocked).toBe(1);
      expect(report.blocking).toHaveLength(0);
      expect(json.stdout).not.toContain('PLANE_UNRESOLVED');
      expect(json.stdout).not.toContain('legacy');
    });
  });

  it('a NEW classification-blocked resource post-adopt still blocks (fail closed)', async () => {
    await withTempRepo({}, async (repo) => {
      await installClassificationFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);

      // `orphos` appears AFTER adoption: same plane-less shape, fresh
      // identity — never in the adopted set, never forgiven.
      repo.writeFiles({
        'src/orphos.txt': 'orphos fixture.table\n',
        '.gateforge/adapters/orphos.mjs': 'export default {};\n',
      });
      const json = await runCli(repo, ['check', '--format', 'json']);
      expect(json.code).toBe(1);
      const report = JSON.parse(json.stdout) as Report;
      expect(report.blocking).toHaveLength(2);
      expect(report.blocking.every((entry) => entry.name === 'orphos')).toBe(true);
      expect(JSON.stringify(report.blocking)).toContain('PLANE_UNRESOLVED');
      // The adopted resource stays waived; only the newcomer blocks.
      expect(report.summary.baselinedClassificationBlocked).toBe(1);
    });
  });

  it('the id layer survives an upstream merge that shifts every line number', async () => {
    await withTempRepo({}, async (repo) => {
      await installClassificationFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);

      // The merge: legacy's declaration moves down a line. The whole-
      // entry fingerprints captured at adoption no longer match — the
      // RESOURCE identity does.
      repo.writeFiles({ 'src/legacy.txt': '# moved by the merge\nlegacy fixture.table\n' });
      const json = await runCli(repo, ['check', '--format', 'json']);
      expect(json.code).toBe(0);
      const report = JSON.parse(json.stdout) as Report;
      expect(report.summary.baselinedClassificationBlocked).toBe(1);
      expect(report.summary.baselinedBlockingEntries).toBe(0);
      expect(report.blocking).toHaveLength(0);

      // And WITHOUT the classification layer (a pre-layer receipt) the
      // same shifted repo blocks again: not adopted for the layer = no
      // identity waiver, fail closed.
      const record = receipt(repo);
      delete record['classificationBlocked'];
      repo.writeFiles({ [RECORD_PATH]: `${JSON.stringify(record, null, 2)}\n` });
      const legacy = await runCli(repo, ['check']);
      expect(legacy.code).toBe(1);
      expect(legacy.stdout).toContain('PLANE_UNRESOLVED');
    });
  });

  it('a second adopt is a no-op success; both layers stay untouched', async () => {
    await withTempRepo({}, async (repo) => {
      await installClassificationFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);
      const baselineBefore = readFileSync(repo.path(BASELINE_PATH), 'utf8');
      const receiptBefore = readFileSync(repo.path(RECORD_PATH), 'utf8');

      const again = await runCli(repo, ['adopt']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('already adopted');
      expect(again.stdout).toContain('1 classification-blocked resource(s) in the receipt');
      expect(readFileSync(repo.path(BASELINE_PATH), 'utf8')).toBe(baselineBefore);
      expect(readFileSync(repo.path(RECORD_PATH), 'utf8')).toBe(receiptBefore);
    });
  });

  it('the adopted classification set is shrink-only via `baseline update --classification-blocked`', async () => {
    await withTempRepo({}, async (repo) => {
      await installClassificationFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);

      // Growth is refused (GF-07 mirrored): an id not in the adopted set.
      const growth = await runCli(repo, [
        'baseline',
        'update',
        '--classification-blocked',
        'name:legacy',
        '--classification-blocked',
        'name:orphos',
      ]);
      expect(growth.code).toBe(2);
      expect(growth.stderr).toContain('strict subset');

      // Re-listing the whole set (no removal) is refused (GF-08 inverse).
      const noOp = await runCli(repo, ['baseline', 'update', '--classification-blocked', 'name:legacy']);
      expect(noOp.code).toBe(2);
      expect(noOp.stderr).toContain('strict subset');

      // The shrink itself: keep none (the explicit empty value) — the
      // shape used when every adopted resource has gained a real
      // classification and left the set.
      const shrink = await runCli(repo, ['baseline', 'update', '--classification-blocked=']);
      expect(shrink.code).toBe(0);
      expect(shrink.stdout).toContain('classification set updated: 0 resource(s) remain adopted (was 1)');
      expect(receipt(repo)).toMatchObject({ classificationBlocked: [] });

      // Growth after the shrink is refused the same way.
      const reAdd = await runCli(repo, ['baseline', 'update', '--classification-blocked', 'name:legacy']);
      expect(reAdd.code).toBe(2);
      expect(reAdd.stderr).toContain('strict subset');

      // And a repo with NO adoption record has nothing to shrink.
      rmSync(repo.path(RECORD_PATH));
      const bare = await runCli(repo, ['baseline', 'update', '--classification-blocked=']);
      expect(bare.code).toBe(2);
      expect(bare.stderr).toContain('no adoption record');
    });
  });
});
