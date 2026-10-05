/**
 * WP2 acceptance for the business-rule claim namespace on the CLI
 * surface: `tests mark --rule` and the `tests explain` rule rows
 * (plan 2026-10-05 §5 D3/D6).
 *
 * Every refusal is asserted as exit 2 with NOTHING written, because the
 * failure this feature must not have is a sidecar holding a declaration
 * the gate can only report back as `wrong-type` or `stale`.
 *
 * `example-e2e` class: CLI process behavior over a real project tree.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  answersYml,
  businessRule,
  configYml,
  installFixture,
  runCli,
} from './helpers.js';

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

const UNPAID_KEY = 'playwright:chromium:e2e/invoices.spec.js:Invoices>cancels an unpaid invoice';
const PAID_KEY = 'playwright:chromium:e2e/invoices.spec.js:Invoices>refuses to cancel a paid invoice';
const CLAIM_UNPAID = 'business-rule:invoice-cancel-only-unpaid/unpaid-can-cancel';
const CLAIM_PAID = 'business-rule:invoice-cancel-only-unpaid/paid-cannot-cancel';

/** The two-case invoice rule every arm below declares unless it says otherwise. */
const INVOICE_RULE = businessRule({
  id: 'invoice-cancel-only-unpaid',
  title: 'An invoice can only be cancelled while it is unpaid',
  cases: [
    { id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds and it shows as cancelled' },
    { id: 'paid-cannot-cancel', describe: 'Cancelling a paid invoice is refused and it stays paid' },
  ],
});

/**
 * Installs the standard fixture PLUS a real playwright project whose
 * runner resolves through node_modules links (`--list` needs no browser).
 */
function installConsumer(repo: TempRepo, rules?: readonly unknown[]): void {
  installFixture(repo, { include: "['src/**/*.txt', 'e2e/**/*.spec.js']" });
  repo.writeFiles({
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

describe('tests mark --rule (business-rule claim namespace)', () => {
  it('writes the sidecar under the business-rule claim, atomically and idempotently', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      const first = await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid/paid-cannot-cancel', PAID_KEY));
      expect(first.code).toBe(0);
      expect(first.stderr).toBe('');
      expect(first.stdout).toContain('mark: wrote .gateforge/test-map.yml');
      const sidecarPath = join(repo.root, '.gateforge/test-map.yml');
      const afterFirst = readFileSync(sidecarPath, 'utf8');
      // The claim id is the namespace + `<ruleId>/<caseId>`, which is
      // exactly the shape the sidecar schema already validated.
      expect(afterFirst).toContain(`- ${CLAIM_PAID}`);
      expect(afterFirst).toContain(`key: ${PAID_KEY}`);
      expect(afterFirst).toContain('reason: The journey asserts this business rule case in the real app.');

      // Re-running the identical mark changes NOTHING — not even the
      // file's bytes (the existing idempotency contract).
      const second = await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid/paid-cannot-cancel', PAID_KEY));
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('mark: no changes');
      expect(readFileSync(sidecarPath, 'utf8')).toBe(afterFirst);
    });
  }, 120_000);

  it('declares both cases of one rule against two different tests', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      expect((await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid/paid-cannot-cancel', PAID_KEY))).code).toBe(0);
      expect((await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid/unpaid-can-cancel', UNPAID_KEY))).code).toBe(0);
      const sidecar = readFileSync(join(repo.root, '.gateforge/test-map.yml'), 'utf8');
      expect(sidecar).toContain(`- ${CLAIM_PAID}`);
      expect(sidecar).toContain(`- ${CLAIM_UNPAID}`);
      expect(sidecar).toContain(`key: ${UNPAID_KEY}`);
    });
  }, 180_000);

  it('refuses an unknown rule id (exit 2) naming the rules section, writing nothing', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      const result = await runCli(repo, markRuleArgv('deleted-rule/paid-cannot-cancel', PAID_KEY));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("unknown business rule 'deleted-rule'");
      expect(result.stderr).toContain('rules: section');
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);
    });
  }, 120_000);

  it('refuses an unknown case of a known rule (exit 2), writing nothing', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      const result = await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid/no-such-case', PAID_KEY));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("business rule 'invoice-cancel-only-unpaid' declares no case 'no-such-case'");
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);
    });
  }, 120_000);

  it('refuses a kind the declared test type excludes, naming the accepted kinds', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [
        businessRule({
          id: 'invoice-cancel-only-unpaid',
          title: 'An invoice can only be cancelled while it is unpaid',
          // A pytest rule: its type row accepts unit/integration/server-e2e
          // under runner pytest, so a browser journey cannot prove it.
          test: 'pytest',
          cases: [{ id: 'paid-cannot-cancel', describe: 'Cancelling a paid invoice is refused' }],
        }),
      ]);
      const result = await runCli(
        repo,
        markRuleArgv('invoice-cancel-only-unpaid/paid-cannot-cancel', PAID_KEY),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("cannot mark");
      expect(result.stderr).toContain("as 'browser-e2e'");
      expect(result.stderr).toContain('the rule declares test: pytest');
      expect(result.stderr).toContain('a weaker kind never satisfies a stronger type');
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);
    });
  }, 120_000);

  it('refuses a malformed --rule value (exit 2) instead of guessing a case', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      const result = await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid', PAID_KEY));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--rule expects <ruleId>/<caseId>');
    });
  }, 120_000);

  it('refuses a rule claim when the repository declares no rules at all', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      const result = await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid/paid-cannot-cancel', PAID_KEY));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("unknown business rule 'invoice-cancel-only-unpaid'");
    });
  }, 120_000);

  it('keeps an obligation claim and a rule claim on ONE sidecar entry', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      const result = await runCli(repo, [
        'tests', 'mark',
        '--test', PAID_KEY,
        '--kind', 'browser-e2e',
        '--obligation', 'tenant.accounts:persistence:read',
        '--rule', 'invoice-cancel-only-unpaid/paid-cannot-cancel',
        '--reason', 'The journey both persists an account and refuses a paid cancellation.',
      ]);
      expect(result.code).toBe(0);
      const sidecar = readFileSync(join(repo.root, '.gateforge/test-map.yml'), 'utf8');
      expect(sidecar).toContain('- business-rule:invoice-cancel-only-unpaid/paid-cannot-cancel');
      expect(sidecar).toContain('- tenant.accounts:persistence:read');
      // One entry, not two: many-to-many is the declared model.
      expect(sidecar.match(/^  - key:/gm) ?? []).toHaveLength(1);
    });
  }, 120_000);
});

describe('tests explain — business rule rows', () => {
  it('shows a rule row naming the rule, the case and what the mapping is', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      expect((await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid/paid-cannot-cancel', PAID_KEY))).code).toBe(0);
      const explained = await runCli(repo, ['tests', 'explain', '--test', PAID_KEY, '--json']);
      expect(explained.code).toBe(0);
      const report = JSON.parse(explained.stdout) as {
        blocks: Array<{ requirement: string; mapping: string; nextAction: string }>;
      };
      const row = report.blocks.find((block) => block.requirement.includes('business rule invoice-cancel-only-unpaid'));
      expect(row).toBeDefined();
      expect(row?.requirement).toContain('case paid-cannot-cancel');
      expect(row?.requirement).toContain('An invoice can only be cancelled while it is unpaid');
      expect(row?.requirement).toContain('Cancelling a paid invoice is refused and it stays paid');
      expect(row?.mapping).toContain('test-map.yml');
      // The honest limit, stated in the row itself: a declaration is intent.
      expect(row?.mapping).toContain('never proof');
      expect(row?.nextAction).toContain('test-gates');
      // A rule case is NOT an obligation row.
      expect(report.blocks.some((block) => block.requirement.includes('business-rule:'))).toBe(false);
    });
  }, 180_000);

  it('marks a claim whose rule was deleted from the answers document as not declared', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      expect((await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid/paid-cannot-cancel', PAID_KEY))).code).toBe(0);
      // The owner renamed or removed the rule; the sidecar entry survives
      // (it is their file) and must be REPORTED, never silently dropped.
      repo.writeFiles({ '.gateforge/classification-policy.yml': answersYml([]) });
      const explained = await runCli(repo, ['tests', 'explain', '--test', PAID_KEY, '--json']);
      expect(explained.code).toBe(0);
      const report = JSON.parse(explained.stdout) as {
        blocks: Array<{ requirement: string; mapping: string }>;
      };
      const row = report.blocks.find((block) => block.requirement.includes('case paid-cannot-cancel'));
      expect(row).toBeDefined();
      expect(row?.requirement).toContain('(not declared in rules:)');
      expect(row?.requirement).not.toContain('An invoice can only be cancelled');
      // Still reported as declared in the sidecar — the honest statement
      // is "you declared it, and the rule no longer exists", not "mapped".
      expect(row?.mapping).toContain('test-map.yml');
    });
  }, 180_000);

  it('shows only the rows of THIS test, never another test\'s rule case', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      expect((await runCli(repo, markRuleArgv('invoice-cancel-only-unpaid/paid-cannot-cancel', PAID_KEY))).code).toBe(0);
      const other = await runCli(repo, ['tests', 'explain', '--test', UNPAID_KEY, '--json']);
      expect(other.code).toBe(0);
      const report = JSON.parse(other.stdout) as { blocks: Array<{ requirement: string }> };
      // The paid-cancel case was declared against the OTHER journey, so
      // this test's report must not claim it — otherwise a reader would
      // believe one green journey proves both sides of the rule.
      expect(report.blocks.some((block) => block.requirement.includes('case paid-cannot-cancel'))).toBe(false);
    });
  }, 180_000);
});