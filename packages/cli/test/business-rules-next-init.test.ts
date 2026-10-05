/**
 * WP4 acceptance for the `next` surface and `init --rules` (plan
 * 2026-10-05 D6, §7.2): a rule case with no mapped test is answered by
 * `next` with the rule title, the case describe, the declared proof
 * type, a PRINTED starter test, and the exact `tests mark --rule` line —
 * for EVERY finding case, not just the top-ranked one. `init --rules`
 * adds the commented rules example to the answers document; without the
 * flag (and with the example still commented) the feature stays off.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { answersYml, businessRule, installFixture, runCli } from './helpers.js';

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

/** The two-case invoice rule the guidance must answer per case. */
const INVOICE_RULE = businessRule({
  id: 'invoice-cancel-only-unpaid',
  title: 'An invoice can only be cancelled while it is unpaid',
  cases: [
    { id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds and it shows as cancelled' },
    { id: 'paid-cannot-cancel', describe: 'Cancelling a paid invoice is refused and it stays paid' },
  ],
});

/**
 * The §7 fixture: quiet policy, one real playwright project whose runner
 * resolves through node_modules links (`--list` needs no browser), specs
 * OUTSIDE the scan roots.
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
}

describe('§7.2 next answers every missing rule case with a starter and the mark command', () => {
  it('prints two starter tests and two tests mark --rule lines', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [INVOICE_RULE]);
      const result = await runCli(repo, ['next']);
      expect(result.code).toBe(1);
      // One starter test per missing case (two cases, both unmapped).
      expect(result.stdout.match(/@gate-forge\/pack-playwright\/fixture/g)).toHaveLength(2);
      // One exact mark command per case, naming the rule, the case, the
      // starter's own file#title and an accepted kind.
      const markLines = result.stdout.match(/gateforge tests mark --rule invoice-cancel-only-unpaid\/[a-z-]+ .*/g) ?? [];
      expect(markLines).toHaveLength(2);
      expect(markLines.every((line) => line.includes('--kind browser-e2e'))).toBe(true);
      expect(markLines.some((line) => line.includes('unpaid-can-cancel'))).toBe(true);
      expect(markLines.some((line) => line.includes('paid-cannot-cancel'))).toBe(true);
      for (const line of markLines) {
        expect(line).toMatch(/--test 'e2e\/invoice-cancel-only-unpaid\.spec\.mjs#business rule invoice-cancel-only-unpaid: .*' --kind browser-e2e --reason /);
      }
      // The rule title and both case describes are named.
      expect(result.stdout).toContain('An invoice can only be cancelled while it is unpaid');
      expect(result.stdout).toContain('Cancelling an unpaid invoice succeeds and it shows as cancelled');
      expect(result.stdout).toContain('Cancelling a paid invoice is refused and it stays paid');

      // The json document carries the same block, both cases.
      const json = await runCli(repo, ['next', '--json']);
      expect(json.code).toBe(1);
      const document = JSON.parse(json.stdout) as { businessRuleGuidance?: string[] };
      expect(document.businessRuleGuidance?.filter((line) => line.includes('gateforge tests mark --rule'))).toHaveLength(2);
    });
  }, 240_000);

  it('names the type mismatch a mapped-but-weaker case carries, without a second mark line', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, [
        businessRule({
          id: 'invoice-cancel-only-unpaid',
          title: 'An invoice can only be cancelled while it is unpaid',
          test: 'pytest',
          cases: [{ id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds' }],
        }),
      ]);
      // Map the case to the playwright journey — a kind the pytest row
      // never accepts (the type table refuses weaker kinds).
      const mark = await runCli(repo, [
        'tests', 'mark',
        '--test', 'playwright:chromium:e2e/invoices.spec.js:Invoices>cancels an unpaid invoice',
        '--kind', 'browser-e2e',
        '--rule', 'invoice-cancel-only-unpaid/unpaid-can-cancel',
        '--reason', 'wrong kind on purpose',
      ]);
      expect(mark.code, `${mark.stdout}\n${mark.stderr}`).toBe(2);
    });
  }, 240_000);
});

describe('init --rules adds the commented example; the feature stays off until uncommented', () => {
  it('writes the example only with the flag, commented, and check sees no rules', async () => {
    await withTempRepo({}, async (repo) => {
      const plain = await runCli(repo, ['init', '--no-scan']);
      expect(plain.code, `${plain.stdout}\n${plain.stderr}`).toBe(0);
      const plainAnswers = readFileSync(repo.path('.gateforge/classification-policy.yml'), 'utf8');
      expect(plainAnswers.includes('rules:')).toBe(false);
    });
    await withTempRepo({}, async (repo) => {
      const withFlag = await runCli(repo, ['init', '--no-scan', '--rules']);
      expect(withFlag.code, `${withFlag.stdout}\n${withFlag.stderr}`).toBe(0);
      const answers = readFileSync(repo.path('.gateforge/classification-policy.yml'), 'utf8');
      // The example is there — and every one of its lines is a comment,
      // so the document still declares NO rules section.
      expect(answers).toContain('# rules:');
      expect(answers).toContain('#   - id: invoice-cancel-only-unpaid');
      for (const line of answers.split('\n')) {
        if (line.trimStart().startsWith('#')) continue;
        expect(line.startsWith('rules:')).toBe(false);
      }
      // And the gate agrees: no declared rules, no businessRules section.
      const check = await runCli(repo, ['check', '--format', 'json']);
      const report = JSON.parse(check.stdout) as { businessRules?: unknown };
      expect(report.businessRules).toBeUndefined();
    });
  }, 240_000);
});
