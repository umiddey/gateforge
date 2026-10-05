import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { OWNER_ANSWERS_PATH } from '@gate-forge/core';
import { planesConfigFromSection, type PlaneConfigRule } from '@gate-forge/pack-sqlalchemy';
import { CLASSIFICATION_POLICY_YML, installFixture, runCli, withTempRepo } from './helpers.js';
import { classificationPolicyTemplate } from '../src/commands/init.js';

/**
 * The fixture answers document plus a `planes:` section (0.11.0: the plane
 * rules are a SECTION of the one owner-answers file, not a side file).
 */
function withPlanesSection(rules: readonly unknown[]): string {
  return `${CLASSIFICATION_POLICY_YML}planes:\n  rules: ${JSON.stringify(rules)}\n`;
}

/**
 * The `planes:` rules a repository's answers document currently declares,
 * read back through the runtime's OWN strict parser: a fixture that
 * asserted on raw YAML would accept a section the run refuses.
 */
function planeRulesOf(repo: { path: (relative: string) => string }): readonly PlaneConfigRule[] {
  const document = parseYaml(readFileSync(repo.path(OWNER_ANSWERS_PATH), 'utf8'));
  const section =
    typeof document === 'object' && document !== null && 'planes' in document
      ? document.planes
      : undefined;
  return planesConfigFromSection(section, `${OWNER_ANSWERS_PATH} planes:`).rules;
}

describe('automatic classification commands', () => {
  it('classify emits deterministic effective decisions and a derived snapshot', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const first = await runCli(repo, ['classify', '--json', '--write-snapshot', '.gateforge/effective.yml']);
      const second = await runCli(repo, ['classify', '--json']);
      expect(first.code).toBe(0);
      expect(first.stdout.replace(/snapshot written[^\n]*\n?$/, '')).toBe(second.stdout);
      expect(existsSync(repo.path('.gateforge/effective.yml'))).toBe(true);
      expect(readFileSync(repo.path('.gateforge/effective.yml'), 'utf8')).toContain('tenant.accounts');
    });
  });

  it('previews and explicitly appends a reviewed plane rule without replacing existing rules', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const existing = { match: 'src/accounts.txt', plane: 'tenant', reason: 'Existing reviewed rule.' };
      const args = [
        'classify',
        'plane',
        'src/new-route.js',
        'master',
        '--reason',
        'This route serves operator-managed records.',
      ];
      repo.writeFiles({
        [OWNER_ANSWERS_PATH]: withPlanesSection([existing]),
      });

      const preview = await runCli(repo, args);
      expect(preview.code).toBe(0);
      expect(preview.stdout).toContain('match: src/new-route.js');
      expect(preview.stdout).toContain('owner-reviewed classification input');
      expect(preview.stdout).toContain('approved policy pin is in use');
      expect(preview.stdout).toContain('rerun this command with --confirm');
      expect(planeRulesOf(repo)).toEqual([existing]);

      const confirmed = await runCli(repo, [...args, '--confirm']);
      expect(confirmed.code).toBe(0);
      expect(planeRulesOf(repo)).toEqual([
        existing,
        {
          match: 'src/new-route.js',
          plane: 'master',
          reason: 'This route serves operator-managed records.',
        },
      ]);
    });
  });

  it('classifies a whole FOLDER with one rule, and refuses anything outside the repo', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'backend/api/v1/accounts.py': '# router fixture\n',
        'backend/api/v1/orders.py': '# router fixture\n',
        [OWNER_ANSWERS_PATH]: withPlanesSection([]),
      });
      const args = [
        'classify',
        'plane',
        'backend/api/v1',
        'tenant',
        '--reason',
        'Every router in this folder is tenant-scoped.',
      ];

      // The preview shows the folder rule and writes nothing.
      const preview = await runCli(repo, args);
      expect(preview.code).toBe(0);
      expect(preview.stdout).toContain('match: backend/api/v1/**');
      expect(preview.stdout).toContain('rerun this command with --confirm');
      expect(planeRulesOf(repo)).toEqual([]);

      const confirmed = await runCli(repo, [...args, '--confirm']);
      expect(confirmed.code).toBe(0);
      expect(planeRulesOf(repo)).toEqual([
        {
          match: 'backend/api/v1/**',
          plane: 'tenant',
          reason: 'Every router in this folder is tenant-scoped.',
        },
      ]);

      // A source that escapes the repository is refused: a rule must never
      // point at bytes the gate does not read.
      for (const outside of ['../secrets', '/etc/gateforge', 'backend/../../etc', 'backend\\api']) {
        const refused = await runCli(repo, [
          'classify',
          'plane',
          outside,
          'tenant',
          '--reason',
          'outside the repo',
          '--confirm',
        ]);
        expect([outside, refused.code]).toEqual([outside, 2]);
        expect(refused.stderr).toContain('repo-relative');
      }
      expect(planeRulesOf(repo)).toEqual([
        {
          match: 'backend/api/v1/**',
          plane: 'tenant',
          reason: 'Every router in this folder is tenant-scoped.',
        },
      ]);
    });
  });

  it('accepts a glob and refuses to shadow an existing rule that disagrees', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'src/api/accounts.js': '// route fixture\n',
        '.gateforge/classification-policy.yml': withPlanesSection([]),
      });

      const globbed = await runCli(repo, [
        'classify',
        'plane',
        'src/api/**',
        'master',
        '--reason',
        'The whole api folder is operator-managed.',
        '--confirm',
      ]);
      expect(globbed.code).toBe(0);
      expect(planeRulesOf(repo)).toEqual([
        { match: 'src/api/**', plane: 'master', reason: 'The whole api folder is operator-managed.' },
      ]);

      // A narrower, disagreeing rule already covers files inside the new
      // glob's surface: the owner edits that rule instead of stacking a
      // second one over it.
      repo.writeFiles({
        '.gateforge/classification-policy.yml': withPlanesSection([
          { match: 'src/api/**', plane: 'master', reason: 'folder rule' },
          { match: 'src/api/public.js', plane: 'global', reason: 'public ingress' },
        ]),
      });
      const shadowed = await runCli(repo, [
        'classify',
        'plane',
        'src/api',
        'tenant',
        '--reason',
        'tenant folder',
        '--confirm',
      ]);
      expect(shadowed.code).toBe(2);
      expect(shadowed.stderr).toContain('will not add a conflicting rule');
      expect(shadowed.stderr).toContain("match 'src/api/**'");
    });
  });

  it('refuses to add a planes: section the owner never wrote', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const before = readFileSync(repo.path(OWNER_ANSWERS_PATH), 'utf8');
      const result = await runCli(repo, [
        'classify',
        'plane',
        'src/new-route.js',
        'master',
        '--reason',
        'Owner-confirmed isolation boundary.',
        '--confirm',
      ]);
      expect(result.code).toBe(2);
      // Since 0.11.0 there is no second plane document to create: the
      // answers document must already declare the reviewed `planes:`
      // section, and the command refuses to invent one.
      expect(result.stderr).toContain(OWNER_ANSWERS_PATH);
      expect(result.stderr).toContain("'planes:' section of '.gateforge/classification-policy.yml'");
      expect(readFileSync(repo.path(OWNER_ANSWERS_PATH), 'utf8')).toBe(before);
    });
  });

  it('refuses a plane rule that conflicts with an existing matching declaration', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const existing = { match: 'src/**', plane: 'tenant', reason: 'Owner-reviewed tenant data.' };
      repo.writeFiles({
        [OWNER_ANSWERS_PATH]: withPlanesSection([existing]),
      });
      const result = await runCli(repo, [
        'classify',
        'plane',
        'src/new-route.js',
        'master',
        '--reason',
        'Owner-reviewed operator data.',
        '--confirm',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('will not add a conflicting rule');
      expect(planeRulesOf(repo)).toEqual([existing]);
    });
  });

  it('names the conflicting rule and the key to change when it refuses', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const existing = { match: 'src/**', plane: 'tenant', reason: 'Owner-reviewed tenant data.' };
      repo.writeFiles({
        [OWNER_ANSWERS_PATH]: withPlanesSection([existing]),
      });
      const result = await runCli(repo, [
        'classify',
        'plane',
        'src/new-route.js',
        'master',
        '--reason',
        'Owner-reviewed operator data.',
        '--confirm',
      ]);
      expect(result.code).toBe(2);
      // The refusal named the FILE but not the rule, so the owner had to
      // go hunting through the document to undo a wrong answer the
      // product itself offered no way back from.
      expect(result.stderr).toContain("match 'src/**'");
      expect(result.stderr).toContain('`plane`');
      expect(result.stderr).toContain('master');
      // Nothing is written and the exit code is unchanged.
      expect(planeRulesOf(repo)).toEqual([existing]);
    });
  });

  it('previews an owner delete-semantics rule and writes it only with --confirm', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const policyPath = '.gateforge/classification-policy.yml';
      repo.writeFiles({
        [policyPath]: `# Owner-reviewed policy: comments must survive every rewrite.\n${CLASSIFICATION_POLICY_YML}`,
      });
      const before = readFileSync(repo.path(policyPath), 'utf8');
      const args = ['classify', 'delete', 'src', 'hard', '--reason', 'Rows in this model tree are removed permanently.'];

      const preview = await runCli(repo, args);
      expect(preview.code).toBe(0);
      expect(preview.stdout).toContain('src/**');
      expect(preview.stdout).toContain('semantics: hard');
      expect(preview.stdout).toContain('rerun this command with --confirm');
      // A preview writes nothing at all.
      expect(readFileSync(repo.path(policyPath), 'utf8')).toBe(before);

      const confirmed = await runCli(repo, [...args, '--confirm']);
      expect(confirmed.code).toBe(0);
      const written = readFileSync(repo.path(policyPath), 'utf8');
      expect(written).toContain('Owner-reviewed policy: comments must survive every rewrite.');
      expect(parseYaml(written).deleteRules).toEqual([
        {
          match: 'src/**',
          semantics: 'hard',
          reason: 'Rows in this model tree are removed permanently.',
        },
      ]);
    });
  });

  it('refuses archive without an owner archive field, then writes the declared fields', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const policyPath = '.gateforge/classification-policy.yml';
      const before = readFileSync(repo.path(policyPath), 'utf8');

      const refused = await runCli(repo, [
        'classify',
        'delete',
        'src/accounts.txt',
        'archive',
        '--reason',
        'Account rows are archived, never removed.',
      ]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('--archive-field');
      expect(readFileSync(repo.path(policyPath), 'utf8')).toBe(before);

      const confirmed = await runCli(repo, [
        'classify',
        'delete',
        'src/accounts.txt',
        'archive',
        '--archive-field',
        'status=archived',
        '--archive-field',
        'archived_by=system',
        '--reason',
        'Account rows are archived, never removed.',
        '--confirm',
      ]);
      expect(confirmed.code).toBe(0);
      expect(parseYaml(readFileSync(repo.path(policyPath), 'utf8')).deleteRules).toEqual([
        {
          match: 'src/accounts.txt',
          semantics: 'archive',
          archiveFields: { status: 'archived', archived_by: 'system' },
          reason: 'Account rows are archived, never removed.',
        },
      ]);
    });
  });

  it('appends the rule as TEXT: the owner-reviewed bytes never change', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const policyPath = '.gateforge/classification-policy.yml';
      // The EXACT document `gateforge init` writes, loaded from the template
      // itself: re-serializing it reflowed `patterns: [...]` and moved the
      // comment block, which is a change the owner never made.
      const original = classificationPolicyTemplate(
        ['python'],
        ['gateforge.pack-fastapi', 'gateforge.pack-sqlalchemy'],
      );
      repo.writeFiles({ [policyPath]: original });
      const args = ['classify', 'delete', 'src', 'hard', '--reason', 'Rows in this model tree are removed permanently.'];

      const preview = await runCli(repo, args);
      expect(preview.code).toBe(0);
      const added = preview.stdout.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
      const removed = preview.stdout.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
      expect(added).toHaveLength(4);
      expect(removed).toEqual([]);
      expect(readFileSync(repo.path(policyPath), 'utf8')).toBe(original);

      const confirmed = await runCli(repo, [...args, '--confirm']);
      expect(confirmed.code).toBe(0);
      const afterFirst = readFileSync(repo.path(policyPath), 'utf8');
      expect(afterFirst.startsWith(original)).toBe(true);
      expect(afterFirst).toContain("patterns: ['**/workers/**', '**/jobs/**']");

      const second = await runCli(repo, [
        'classify',
        'delete',
        'src/accounts.txt',
        'archive',
        '--archive-field',
        'status=archived',
        '--reason',
        'Account rows are archived, never removed.',
        '--confirm',
      ]);
      expect(second.code).toBe(0);
      const afterSecond = readFileSync(repo.path(policyPath), 'utf8');
      expect(afterSecond.startsWith(original)).toBe(true);
      expect(afterSecond.match(/^deleteRules:/gm)).toHaveLength(1);
      expect(parseYaml(afterSecond).deleteRules).toEqual([
        {
          match: 'src/**',
          semantics: 'hard',
          reason: 'Rows in this model tree are removed permanently.',
        },
        {
          match: 'src/accounts.txt',
          semantics: 'archive',
          archiveFields: { status: 'archived' },
          reason: 'Account rows are archived, never removed.',
        },
      ]);
    });
  });

  it('explain exposes the decision trace and generated obligation', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['explain', 'tenant.accounts']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('decisionFingerprint:');
      expect(result.stdout).toContain('rules:');
      expect(result.stdout).toContain('tenant.accounts:persistence:read');
    });
  });
});
