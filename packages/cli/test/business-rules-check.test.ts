/**
 * §7 acceptance items 1-4 and 10 for the business-rule GATE: what `check`
 * reports for an owner-declared rule (plan 2026-10-05 §7).
 *
 * Every arm asserts the CHANNEL, not just the presence of a cause: a
 * blocking rule fails the run (exit 1), an advisory one is reported and
 * exits 0, and a rule naming a subject the inventory cannot see is a
 * configuration error (exit 2). Item 1 asserts the stronger property the
 * release is built on — a repository with no `rules:` section is
 * byte-identical to one that never heard of the feature.
 *
 * `example-e2e` class: CLI process behavior over a real project tree.
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { answersYml, businessRule, installFixture, runCli } from './helpers.js';

/** The gateforge monorepo root (for playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The consumer's playwright config (ESM; project pinned to chromium). */
const PW_CONFIG = "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n";

const INVOICES_SPEC = [
  "import { test } from 'playwright/test';",
  'test.describe("Invoices", () => {',
  "  test('cancels an unpaid invoice', async ({ page }) => {",
  '    await page.goto("/invoices");',
  '  });',
  "  test('refuses to cancel a paid invoice', async ({ page }) => {",
  '    await page.goto("/invoices");',
  '  });',
  '});',
  '',
].join('\n');

const PAID_KEY = 'playwright:chromium:e2e/invoices.spec.js:Invoices>refuses to cancel a paid invoice';

/** The two-case invoice rule every arm below declares unless it says otherwise. */
const INVOICE_RULE = businessRule({
  id: 'invoice-cancel-only-unpaid',
  title: 'An invoice can only be cancelled while it is unpaid',
  cases: [
    { id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds and it shows as cancelled' },
    { id: 'paid-cannot-cancel', describe: 'Cancelling a paid invoice is refused and it stays paid' },
  ],
});

/** One entry of a rendered report's `blocking` channel. */
interface ReportEntry {
  cause: string | null;
  name: string | null;
  detail: string;
  nextAction: string;
}

/** The rendered JSON report's two channels. */
interface Report {
  blocking: ReportEntry[];
  advisories?: ReportEntry[];
}

/**
 * Installs the standard fixture PLUS a real playwright project whose
 * runner resolves through node_modules links (`--list` needs no browser).
 *
 * The baseline is kept QUIET so a rule finding is the only thing that can
 * move the exit code:
 * - the one policy matches only `sqlalchemy.table` resources, and this
 *   fixture's resources are `fixture.table` — so it compiles to zero
 *   obligations and no unproven-obligation verdict competes with the
 *   rule's own findings (the document schema requires at least one
 *   policy, so "none" is expressed as a policy that matches nothing);
 * - the specs stay OUT of the scan roots — the fixture plugin reads every
 *   scanned line as a resource, and a playwright spec's lines would only
 *   manufacture stale-signal noise; the playwright pack still discovers
 *   the specs through its own config's `testDir`;
 * - `src/invoices.txt` gives the inventory a real `invoices` resource, so
 *   a rule naming `subject: invoices` is gradeable.
 */
function installConsumer(repo: TempRepo, rules?: readonly unknown[]): void {
  installFixture(repo);
  repo.writeFiles({
    '.gateforge/policies.yml': [
      'schemaVersion: 1',
      'policies:',
      '  - id: tables-owe-persistence-read',
      '    when:',
      '      kind: sqlalchemy.table',
      '    require:',
      '      - persistence:read',
      '',
    ].join('\n'),
    '.gateforge/adapters/invoices.mjs': 'export default {};\n',
    'src/invoices.txt': 'invoices fixture.table\n',
    'playwright.config.js': PW_CONFIG,
    'e2e/invoices.spec.js': INVOICES_SPEC,
    '.gitignore': 'node_modules\n',
    ...(rules === undefined ? {} : { '.gateforge/classification-policy.yml': answersYml(rules) }),
  });
  const nm = join(repo.root, 'node_modules');
  mkdirSync(nm, { recursive: true });
  for (const name of ['playwright', 'playwright-core']) {
    const target = join(nm, name);
    if (!existsSync(target)) symlinkSync(join(ROOT, 'node_modules', name), target, 'dir');
  }
}

/** The rule-caused entries of one report channel, in report order. */
function ruleEntries(entries: readonly ReportEntry[] | undefined): ReportEntry[] {
  return (entries ?? []).filter((entry) =>
    (entry.cause ?? '').startsWith('BUSINESS_RULE_TEST_'),
  );
}

/** `tests mark --rule` argv for one rule case. */
function markRuleArgv(ruleRef: string, testKey: string, kind = 'browser-e2e'): string[] {
  return [
    'tests', 'mark',
    '--test', testKey,
    '--kind', kind,
    '--rule', ruleRef,
    '--reason', 'The journey asserts this business rule case in the real app.',
  ];
}

describe('§7.1 no rules section: byte-identical to a release without the feature', () => {
  it('moves not one byte of the report beyond the digest the section itself changes', async () => {
    await withTempRepo({}, async (repo) => {
      // The release WITHOUT the feature is this fixture as installed: the
      // owner-answers document carries no `rules:` key at all, and the
      // pipeline reads `policyDoc.rules ?? []` — so the feature is off
      // and nothing in it knows a rule exists.
      installConsumer(repo);
      const before = await runCli(repo, ['check', '--format', 'json']);
      const beforeReport = JSON.parse(before.stdout) as Report;
      // An explicit EMPTY `rules:` list is the nearest thing to "the
      // feature is on and declares nothing". It changes exactly one byte
      // of the input tree — the answers document — and therefore one
      // digest. Everything the feature does NOT touch stays put.
      repo.writeFiles({ '.gateforge/classification-policy.yml': answersYml([]) });
      const after = await runCli(repo, ['check', '--format', 'json']);
      const afterReport = JSON.parse(after.stdout) as Report;
      // The two channels carry no rule findings either way: a rule list
      // with no entries grades no case.
      expect(ruleEntries(beforeReport.blocking)).toEqual([]);
      expect(ruleEntries(beforeReport.advisories)).toEqual([]);
      expect(ruleEntries(afterReport.blocking)).toEqual([]);
      expect(ruleEntries(afterReport.advisories)).toEqual([]);
      // Strip the fields a second invocation may legally move:
      // - `runId` is a fresh random UUID every run, feature or not (even
      //   two runs of the IDENTICAL tree differ in it);
      // - `inputDigest` is the one digest the changed answers document is
      //   REQUIRED to move (plan invariant 2: the section is owner-pinned);
      // - `cache` hit/miss counts are warmed by the first run.
      // Everything else — every finding, every channel, every summary —
      // must be byte-identical.
      const withoutVolatile = (key: string, value: unknown): unknown =>
        key === 'runId' || key === 'inputDigest' || key === 'hits' || key === 'misses'
          ? undefined
          : value;
      expect(JSON.stringify(afterReport, withoutVolatile)).toBe(
        JSON.stringify(beforeReport, withoutVolatile),
      );
    });
  }, 180_000);
});

describe('§7.2 a declared rule with no mappings blocks with one finding per case', () => {
  it('exits 1 and names the rule, the case and the accepted type', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as Report;
      const blocking = ruleEntries(report.blocking);
      expect(blocking).toHaveLength(2);
      // Sorted by rule id then case id (invariant 9), so the order here is
      // the declared one rather than an accident of discovery.
      expect(blocking.map((entry) => entry.cause)).toEqual([
        'BUSINESS_RULE_TEST_MISSING',
        'BUSINESS_RULE_TEST_MISSING',
      ]);
      for (const entry of blocking) {
        expect(entry.name).toBe('invoice-cancel-only-unpaid');
        expect(entry.detail).toContain("business rule 'invoice-cancel-only-unpaid' case");
        // The type the rule needs, by name.
        expect(entry.detail).toContain('browser-e2e or observed-e2e');
        expect(entry.nextAction).toContain('tests mark --rule');
      }
      // Sorted by claim id, not by the rule's `cases:` order: a
      // `business-rule:` id sorts as a string, so
      // `business-rule:invoice-cancel-only-unpaid/paid-cannot-cancel`
      // precedes `.../unpaid-can-cancel` (invariant 9).
      expect(blocking[0]?.detail).toContain("case 'paid-cannot-cancel'");
      expect(blocking[1]?.detail).toContain("case 'unpaid-can-cancel'");
      // The additive `businessRules` section lists EVERY graded case with
      // its status (invariant 6): here both, unmapped, in claim-id order.
      const sections = (report as Report & { businessRules?: Array<{ ruleId: string; caseId: string; status: string; channel: string | null; enforcement: string; finding: { cause: string } | null }> }).businessRules;
      expect(sections?.map((entry) => [entry.ruleId, entry.caseId, entry.status])).toEqual([
        ['invoice-cancel-only-unpaid', 'paid-cannot-cancel', 'unmapped'],
        ['invoice-cancel-only-unpaid', 'unpaid-can-cancel', 'unmapped'],
      ]);
      expect(sections?.every((entry) => entry.channel === null && entry.enforcement === 'block')).toBe(true);
      expect(sections?.every((entry) => entry.finding?.cause === 'BUSINESS_RULE_TEST_MISSING')).toBe(true);
      // A missing test is a blocking rule finding, never advisory.
      expect(ruleEntries(report.advisories)).toEqual([]);
    });
  }, 180_000);

  it('still blocks when the repository ships no test-map sidecar at all', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, { include: "['src/**/*.txt', 'e2e/**/*.spec.js']" });
      repo.writeFiles({
        '.gitignore': 'node_modules\n',
        '.gateforge/classification-policy.yml': answersYml([
          businessRule({ id: 'single-rule', title: 'A rule with no cases and no tests' }),
        ]),
      });
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as Report;
      // A rule with no `cases:` has ONE implicit case, so exactly one
      // finding — and its id is the documented `default`.
      const blocking = ruleEntries(report.blocking);
      expect(blocking).toHaveLength(1);
      expect(blocking[0]?.detail).toContain("case 'default'");
    });
  }, 180_000);
});

describe('§7.3 an advisory rule is reported and never blocks', () => {
  it('exits 0 and carries both cases in the advisory channel', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [
        businessRule({
          id: 'invoice-cancel-only-unpaid',
          title: 'An invoice can only be cancelled while it is unpaid',
          enforcement: 'advisory',
          advisoryReason: 'The migration to the new cancel API is still in flight.',
          cases: [
            { id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds' },
            { id: 'paid-cannot-cancel', describe: 'Cancelling a paid invoice is refused' },
          ],
        }),
      ]);
      const result = await runCli(repo, ['check', '--format', 'json']);
      // Nothing else in this fixture blocks, so the advisory rule alone
      // decides the exit code.
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as Report;
      expect(ruleEntries(report.blocking)).toEqual([]);
      // Invariant 7: advisory never hides — printed and serialized, just
      // not in `blocking`.
      const advisories = ruleEntries(report.advisories);
      expect(advisories).toHaveLength(2);
      expect(advisories.every((entry) => entry.cause === 'BUSINESS_RULE_TEST_MISSING')).toBe(true);
      // The same typed codes as the blocking channel, so a reader tells
      // them apart by WHERE they are, never by a new severity.
      expect(result.stdout).toContain('BUSINESS_RULE_TEST_MISSING');
    });
  }, 180_000);

  it('refuses an advisory rule that declares no advisoryReason (exit 2)', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [
        businessRule({
          id: 'invoice-cancel-only-unpaid',
          title: 'An invoice can only be cancelled while it is unpaid',
          enforcement: 'advisory',
          cases: [{ id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds' }],
        }),
      ]);
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('advisoryReason');
    });
  }, 180_000);
});

describe('§7.4 a mapped test outside the rule type never satisfies it', () => {
  it('reports wrong-type naming the accepted kinds and runner, and exits 1', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      // The journey is marked while the rule says e2e: browser-e2e is
      // exactly what the catalog infers and the type accepts, so the
      // mark succeeds. (The plan's literal "mapped to api-e2e while the
      // rule says e2e" is refused by `tests mark --rule` itself — D6
      // will not write a declaration the type table already rejects —
      // so the evaluator's wrong-type row is exercised from the state a
      // real repository CAN reach: the owner retargets the rule.)
      const marked = await runCli(
        repo,
        markRuleArgv('invoice-cancel-only-unpaid/paid-cannot-cancel', PAID_KEY),
      );
      expect(marked.code).toBe(0);
      // The owner retargets the rule to the witnessed pytest suite. The
      // sidecar lags: its browser-e2e binding is now outside the type's
      // accepted kinds AND its runner.
      repo.writeFiles({
        '.gateforge/classification-policy.yml': answersYml([
          businessRule({
            id: 'invoice-cancel-only-unpaid',
            title: 'An invoice can only be cancelled while it is unpaid',
            test: 'pytest',
            cases: [
              { id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds and it shows as cancelled' },
              { id: 'paid-cannot-cancel', describe: 'Cancelling a paid invoice is refused and it stays paid' },
            ],
          }),
        ]),
      });
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as Report;
      const mismatch = ruleEntries(report.blocking).filter(
        (entry) => entry.cause === 'BUSINESS_RULE_TEST_TYPE_MISMATCH',
      );
      expect(mismatch).toHaveLength(1);
      // The finding names the mapped kind it refuses, the accepted kinds
      // AND the runner, so the owner knows what to map instead of guessing.
      expect(mismatch[0]?.detail).toContain('browser-e2e');
      expect(mismatch[0]?.detail).toContain('unit or integration or server-e2e');
      expect(mismatch[0]?.detail).toContain("runner 'pytest'");
      // The other case, still unmapped, keeps its own cause.
      expect(
        ruleEntries(report.blocking).some((entry) => entry.cause === 'BUSINESS_RULE_TEST_MISSING'),
      ).toBe(true);
    });
  }, 180_000);
});

describe('§7.10 an unknown rule subject is a configuration error', () => {
  it('grades normally when the subject IS in the inventory', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [
        businessRule({
          id: 'invoice-cancel-only-unpaid',
          title: 'An invoice can only be cancelled while it is unpaid',
          subject: 'invoices',
          cases: [{ id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds' }],
        }),
      ]);
      const result = await runCli(repo, ['check', '--format', 'json']);
      // A subject the inventory can see is graded, not refused: the case
      // is unmapped, so the run blocks like any other missing proof.
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as Report;
      expect(ruleEntries(report.blocking)).toHaveLength(1);
    });
  }, 180_000);

  it('exits 2 naming the unknown subject', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [
        businessRule({
          id: 'invoice-cancel-only-unpaid',
          title: 'An invoice can only be cancelled while it is unpaid',
          subject: 'no-such-resource',
          cases: [{ id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds' }],
        }),
      ]);
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('no-such-resource');
      expect(result.stderr).toContain('invoice-cancel-only-unpaid');
    });
  }, 180_000);
});