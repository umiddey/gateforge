/**
 * `gateforge init`: generation, idempotence, and the no-overwrite rule
 * (automatic classification contract).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { withTempRepo, loadConfig } from '@gate-forge/core';
import { readPlanesConfigOrNull } from '@gate-forge/pack-sqlalchemy';
import { runCli } from './helpers.js';

const TARGETS = [
  '.gateforge.yml',
  '.gateforge/policies.yml',
  '.gateforge/classification-policy.yml',
  '.gateforge/baselines/obligations.json',
];

describe('gateforge init', () => {
  it('generates the config, documents, and skeleton dirs', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      for (const target of TARGETS) {
        expect(existsSync(repo.path(target)), `${target} exists`).toBe(true);
        expect(stdout).toContain(`created: ${repo.path(target)}`);
      }
      expect(existsSync(repo.path('.gateforge/adapters'))).toBe(true);
      expect(existsSync(repo.path('.gateforge/waivers'))).toBe(true);
      // The generated config must be loadable by the pinned schema.
      expect(() => loadConfig(join(repo.root, '.gateforge.yml'))).not.toThrow();
    });
  });


  it('init --pre-commit --mode changed --ci wires the debt-friendly gate and the CI include', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init', '--pre-commit', '--mode', 'changed', '--ci']);
      expect(first.code).toBe(0);
      const hook = readFileSync(repo.path('.gateforge/hooks/gateforge-check.mjs'), 'utf8');
      expect(hook).toContain('const args = ["check","--changed"]');
      expect(hook).not.toContain('--staged');
      // CI: template created AND the include wired into .gitlab-ci.yml
      expect(readFileSync(repo.path('.gitlab-ci.yml'), 'utf8')).toContain('.gateforge/ci/gitlab-gateforge.yml');
      expect(existsSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'))).toBe(true);
      // changed mode: no standalone strict staged script
      expect(existsSync(repo.path('.gateforge/hooks/gateforge-staged.sh'))).toBe(false);
      expect(existsSync(repo.path('.gateforge/baselines/obligations.json'))).toBe(true);
    });
  });

  it.each([
    ['staged', 'pre-commit --scope staged'],
    ['full', 'pre-commit --scope full'],
  ] as const)('init --witnessed %s wires fresh evidence collection into both hook paths', async (scope, command) => {
    await withTempRepo({}, async (repo) => {
      const result = await runCli(repo, ['init', '--witnessed', scope]);
      expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(readFileSync(repo.path('.gateforge/hooks/gateforge-check.mjs'), 'utf8')).toContain(
        `const args = ["pre-commit","--scope","${scope}"]`,
      );
      expect(readFileSync(repo.path('.gateforge/hooks/gateforge-staged.sh'), 'utf8')).toContain(command);
      expect(readFileSync(repo.path('.git/hooks/pre-commit'), 'utf8')).toContain(command);
    });
  });

  it('upgrades an existing receipt-only Gateforge hook to witnessed mode', async () => {
    await withTempRepo({}, async (repo) => {
      const receiptOnly = await runCli(repo, ['init', '--pre-commit', '--mode', 'changed']);
      expect(receiptOnly.code).toBe(0);
      expect(readFileSync(repo.path('.gateforge/hooks/gateforge-check.mjs'), 'utf8')).toContain(
        'const args = ["check","--changed"]',
      );

      const witnessed = await runCli(repo, ['init', '--witnessed', 'staged']);
      expect(witnessed.code).toBe(0);
      expect(witnessed.stdout).toContain('updated:');
      expect(readFileSync(repo.path('.gateforge/hooks/gateforge-check.mjs'), 'utf8')).toContain(
        'const args = ["pre-commit","--scope","staged"]',
      );
      expect(readFileSync(repo.path('.gateforge/hooks/gateforge-staged.sh'), 'utf8')).toContain(
        'pre-commit --scope staged',
      );
      expect(readFileSync(repo.path('.git/hooks/pre-commit'), 'utf8')).toContain('pre-commit --scope staged');
    });
  });

  it('rejects conflicting receipt-only and witnessed pre-commit modes', async () => {
    await withTempRepo({}, async (repo) => {
      const result = await runCli(repo, ['init', '--mode', 'staged', '--witnessed', 'full']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('cannot be combined');
    });
  });

  it('--blocking integrates through a framework-managed pre-commit hook without manual chaining', async () => {
    await withTempRepo({}, async (repo) => {
      // A pre-commit-FRAMEWORK-generated .git hook: regenerated from
      // .pre-commit-config.yaml on every install — gateforge must wire
      // through the framework config, never demand chaining into it.
      const hooksDir = repo.path('.git/hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, 'pre-commit'), [
        '#!/usr/bin/env bash',
        '# File generated by pre-commit: https://pre-commit.com',
        '# start templated',
        'ARGS=(hook-impl --config=.pre-commit-config.yaml --hook-type=pre-commit)',
        '# end templated',
        'exec "$INSTALL_PYTHON" -mpre_commit "${ARGS[@]}"',
        '',
      ].join('\n'));
      writeFileSync(repo.path('.pre-commit-config.yaml'), 'repos:\n  - repo: local\n    hooks:\n      - id: existing-hook\n        entry: echo existing\n');

      const first = await runCli(repo, ['init', '--blocking']);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('framework-managed pre-commit hook detected');
      expect(first.stdout).not.toContain('required action');
      // The gateforge hook block is appended to the FRAMEWORK config —
      // the framework then runs it on every commit.
      const precommit = readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8');
      expect(precommit).toContain('gateforge-check');
      // The appended block must be VALID YAML — a text-only append that
      // breaks indentation bricks every commit in the consumer repo.
      expect(() => parseYaml(precommit)).not.toThrow();
      expect(precommit).toContain('existing-hook');
      expect(existsSync(repo.path('.gateforge/hooks/gateforge-check.mjs'))).toBe(true);
      const witnessed = await runCli(repo, ['init', '--witnessed', 'full']);
      expect(witnessed.code).toBe(0);
      expect(readFileSync(repo.path('.gateforge/hooks/gateforge-check.mjs'), 'utf8')).toContain(
        'const args = ["pre-commit","--scope","full"]',
      );
      expect(readFileSync(repo.path('.git/hooks/pre-commit'), 'utf8')).not.toContain('gateforge pre-commit v1');
      expect(readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8').split('id: gateforge-check').length - 1).toBe(1);
      // Idempotent rerun stays green.
      const second = await runCli(repo, ['init', '--blocking']);
      expect(second.code).toBe(0);
      expect(readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8').split('id: gateforge-check').length - 1).toBe(1);
    });
  });

  it('--blocking wires the pre-commit hook, check script, and CI template', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init', '--blocking']);
      expect(first.code).toBe(0);
      const hook = repo.path('.gateforge/hooks/gateforge-check.mjs');
      expect(existsSync(hook)).toBe(true);
      const precommit = readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8');
      expect(precommit).toContain('gateforge-check');
      // The appended block must be VALID YAML — a text-only append that
      // breaks indentation bricks every commit in the consumer repo.
      expect(() => parseYaml(precommit)).not.toThrow();
      expect(existsSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'))).toBe(true);
      expect(readFileSync(repo.path('.gitlab-ci.yml'), 'utf8')).toContain('gitlab-gateforge.yml');
      // The CI template is the strict E2E gate (plan Phase 6): supervised
      // receipt seal + require-e2e check, never an optional/static-only job.
      const ciTemplate = readFileSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'), 'utf8');
      expect(ciTemplate).toContain('gateforge test-gates --changed');
      expect(ciTemplate).toContain('gateforge check --changed --require-e2e');
      // Pinned engine install (lockfile-based), with a version assertion.
      expect(ciTemplate).toContain('npm ci');
      expect(ciTemplate).toContain('GATEFORGE_VERSION');
      // The honest limits are carried in the template comments: the
      // signing material boundary, the approved-policy pin (E17), and
      // the server-side settings act.
      expect(ciTemplate).toContain('GATEFORGE_WITNESS_VERIFIER_KEY');
      expect(ciTemplate).toContain('GATEFORGE_APPROVED_POLICY_DIGEST');
      expect(ciTemplate).toContain('APPROVED POLICY PIN');
      expect(ciTemplate).toContain('ENFORCEMENT_UNTRUSTED');
      expect(ciTemplate).toContain('pipeline execution policy');
      expect(ciTemplate).toContain('Pipelines must succeed');
      expect(ciTemplate).toContain('Protected branches');
      // The template must stay valid, loadable YAML with the gate job —
      // and the job must never be optional (no allow_failure/manual).
      const parsed = parseYaml(ciTemplate) as Record<string, Record<string, unknown>>;
      expect(Object.keys(parsed)).toContain('gateforge:e2e-gate');
      const gateJob = parsed['gateforge:e2e-gate'] ?? {};
      expect(gateJob['allow_failure']).toBeUndefined();
      expect(gateJob['when']).toBeUndefined();
      expect(gateJob['rules']).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
      // idempotent: second run must not duplicate the hook entry
      const again = await runCli(repo, ['init', '--blocking']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('exists, leaving untouched');
      const count = readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8').split('id: gateforge-check').length - 1;
      expect(count).toBe(1);
    });
  });

  it('without --blocking it writes no enforcement files and prints the tip', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      expect(existsSync(repo.path('.gateforge/hooks/gateforge-check.mjs'))).toBe(false);
      expect(existsSync(repo.path('.pre-commit-config.yaml'))).toBe(false);
      expect(stdout).toContain('--blocking');
    });
  });

  it('preconfigures trusted detectors and makes discovery runnable', async () => {
    await withTempRepo({}, async (repo) => {
      const initialized = await runCli(repo, ['init', '--languages', 'python,javascript,typescript']);
      expect(initialized.code).toBe(0);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      // pack-task is opt-in only (no semantic verifier): never defaulted.
      expect(config.plugins.map((plugin) => plugin.id)).toEqual([
        'gateforge.pack-fastapi',
        'gateforge.pack-sqlalchemy',
        'gateforge.pack-http',
      ]);
      expect(config.plugins.every((plugin) => plugin.transport === 'in-process')).toBe(true);
      expect(config.project.paths.include).toEqual([
        '**/*.py',
        '**/*.js',
        '**/*.jsx',
        '**/*.mjs',
        '**/*.cjs',
        '**/*.ts',
        '**/*.tsx',
      ]);
      expect(config.project.paths.exclude).toContain('**/.venv/**');

      const discovered = await runCli(repo, ['discover']);
      expect(discovered.code).toBe(0);
      expect(discovered.stderr).toBe('');
    });
  });

  it('is idempotent and never overwrites user files', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init']);
      expect(first.code).toBe(0);

      // The user edits the generated config; init must leave it alone.
      const configPath = repo.path('.gateforge.yml');
      const userEdit = readFileSync(configPath, 'utf8') + '\n# user customization\nlanguages: [ruby]\n';
      repo.writeFiles({ '.gateforge.yml': userEdit });

      const second = await runCli(repo, ['init']);
      expect(second.code).toBe(0);
      expect(second.stdout).not.toContain('created:');
      expect(second.stdout).toContain('exists, leaving untouched');
      expect(readFileSync(configPath, 'utf8')).toBe(userEdit);
    });
  });

  it('honors --languages and rejects an empty list', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--languages', 'python,node']);
      expect(code).toBe(0);
      const config = readFileSync(repo.path('.gateforge.yml'), 'utf8');
      expect(config).toContain('- python');
      expect(config).toContain('- node');
      expect(stdout).toContain('created:');
    });
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['init', '--languages', ' , ']);
      expect(code).toBe(2);
      expect(stderr).toContain('--languages');
    });
  });

  it('keeps existing skeleton files when the config is regenerated', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init']);
      expect(first.code).toBe(0);
      // A waiver file the user dropped into the skeleton survives init.
      repo.writeFiles({ '.gateforge/waivers/custom.json': '{"user": true}' });
      const second = await runCli(repo, ['init']);
      expect(second.code).toBe(0);
      expect(readFileSync(repo.path('.gateforge/waivers/custom.json'), 'utf8')).toBe(
        '{"user": true}',
      );
    });
  });
});

describe('gateforge init scan-and-choose (Phase 1: scan, recommend, choose)', () => {
  it('empty repo: prints the scan block, recommends fastapi+sqlalchemy, never pack-task', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      expect(stdout).toContain('scan:');
      expect(stdout).toContain('languages: python');
      expect(stdout).toContain('recommended:');
      expect(stdout).toContain('gateforge.pack-fastapi, gateforge.pack-sqlalchemy');
      expect(stdout).toContain('skipped:');
      expect(stdout).toContain('gateforge.pack-task');
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toEqual([
        'gateforge.pack-fastapi',
        'gateforge.pack-sqlalchemy',
      ]);
      // Persistence-only starter policy: no unavailable browser channel.
      const policies = readFileSync(repo.path('.gateforge/policies.yml'), 'utf8');
      expect(policies).toContain('user-facing-persistence');
      expect(policies).not.toContain('- http:frontend-request-observed');
    });
  });

  it('detects sqlalchemy+fastapi signals and recommends exactly those packs', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/models/account.py': [
          'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column',
          'from fastapi import FastAPI',
          '',
          '',
          'class Base(DeclarativeBase):',
          '    pass',
          '',
          '',
          'class Account(Base):',
          '    __tablename__ = "accounts"',
          '    id: Mapped[str] = mapped_column(primary_key=True)',
          '',
        ].join('\n'),
      });
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      expect(stdout).toContain('signals: sqlalchemy, fastapi');
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toEqual([
        'gateforge.pack-fastapi',
        'gateforge.pack-sqlalchemy',
      ]);
    });
  });

  it('creates GATEFORGE.md and the overlay README, never overwriting user edits', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init']);
      expect(first.code).toBe(0);
      const skill = readFileSync(repo.path('GATEFORGE.md'), 'utf8');
      expect(skill).toContain('gateforge next');
      expect(skill).toContain('gateforge next --json');
      expect(skill).toContain('tests/e2e/gateforge/');
      expect(skill).toContain('tests mark');
      expect(skill).toContain('tests/e2e/**');
      expect(skill).toContain('VERIFIER_UNSUPPORTED');
      expect(skill).toContain('coveragePolicy');
      const overlay = readFileSync(repo.path('tests/e2e/gateforge/README.md'), 'utf8');
      expect(overlay).toContain('tests/e2e/gateforge/<resource>.<op>.spec.js');
      // User edits survive a second run.
      repo.writeFiles({ 'GATEFORGE.md': '# mine\n', 'tests/e2e/gateforge/README.md': '# mine\n' });
      const second = await runCli(repo, ['init']);
      expect(second.code).toBe(0);
      expect(readFileSync(repo.path('GATEFORGE.md'), 'utf8')).toBe('# mine\n');
      expect(readFileSync(repo.path('tests/e2e/gateforge/README.md'), 'utf8')).toBe('# mine\n');
    });
  });

  it('--proof observe is accepted: no overlay scaffold, checklist printed', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--proof', 'observe']);
      expect(code).toBe(0);
      expect(stdout).toContain('proof: observe');
      expect(stdout).toContain('observe proof checklist');
      expect(stdout).toContain('observed-e2e');
      expect(existsSync(repo.path('.gateforge.yml'))).toBe(true);
      expect(existsSync(repo.path('GATEFORGE.md'))).toBe(true);
      // The observe path reuses the existing suite: no overlay directory.
      expect(existsSync(repo.path('tests/e2e/gateforge/README.md'))).toBe(false);
    });
  });

  it('--proof bogus exits 2 before any writes', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['init', '--proof', 'bogus']);
      expect(code).toBe(2);
      expect(stderr).toContain(`flag '--proof' must be 'overlay' or 'observe'`);
      expect(existsSync(repo.path('.gateforge.yml'))).toBe(false);
      expect(existsSync(repo.path('GATEFORGE.md'))).toBe(false);
      expect(existsSync(repo.path('.gateforge'))).toBe(false);
    });
  });

  it('unknown --plugins id exits 2 with nothing written', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['init', '--plugins', 'gateforge.pack-nope']);
      expect(code).toBe(2);
      expect(stderr).toContain('unknown plugin');
      expect(existsSync(repo.path('.gateforge.yml'))).toBe(false);
    });
  });

  it('--plugins gateforge.pack-task is the only way task gets installed', async () => {
    await withTempRepo({}, async (repo) => {
      const { code } = await runCli(repo, ['init', '--plugins', 'gateforge.pack-task']);
      expect(code).toBe(0);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toEqual(['gateforge.pack-task']);
    });
  });

  it('--no-scan skips heuristics and uses language defaults without pack-task', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/models/account.py': 'from sqlalchemy.orm import DeclarativeBase\n',
      });
      const { code, stdout } = await runCli(repo, ['init', '--no-scan']);
      expect(code).toBe(0);
      expect(stdout).toContain('signals: (none)');
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toEqual([
        'gateforge.pack-fastapi',
        'gateforge.pack-sqlalchemy',
      ]);
    });
  });
  it('never emits coverage rules for unselected detectors (no dangling references)', async () => {
    // JS/TS in languages but pack-http NOT selected: the generated
    // classification policy must not name it (fail-closed at runtime).
    await withTempRepo({}, async (repo) => {
      const { code } = await runCli(repo, [
        'init', '--languages', 'python,typescript', '--plugins', 'gateforge.pack-sqlalchemy,gateforge.pack-fastapi',
      ]);
      expect(code).toBe(0);
      const policy = readFileSync(repo.path('.gateforge/classification-policy.yml'), 'utf8');
      expect(policy).not.toContain('gateforge.pack-http');
      expect(policy).toContain('gateforge.pack-sqlalchemy');
    });
    // Opting into pack-http restores its rule.
    await withTempRepo({}, async (repo) => {
      const { code } = await runCli(repo, [
        'init', '--languages', 'python,typescript',
        '--plugins', 'gateforge.pack-sqlalchemy,gateforge.pack-fastapi,gateforge.pack-http',
      ]);
      expect(code).toBe(0);
      expect(readFileSync(repo.path('.gateforge/classification-policy.yml'), 'utf8')).toContain(
        'gateforge.pack-http',
      );
    });
  });
});
describe('gateforge init --planes (proposed planes.json from discovered model trees)', () => {
  /** A minimal declarative model the sqlalchemy detector recognizes. */
  const MODEL = (table: string, cls: string): string => `\
"""Fixture model."""

from sqlalchemy import String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Local declarative base."""


class ${cls}(Base):
    __tablename__ = "${table}"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
`;

  it('without --planes (non-TTY) it proposes nothing and prints the tip', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/models/account.py': MODEL('accounts', 'Account'),
      });
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      expect(existsSync(repo.path('.gateforge/planes.json'))).toBe(false);
      expect(stdout).toContain('--planes proposes .gateforge/planes.json');
    });
  });

  it('--planes proposes two-tree rules: admin tree -> master, models tree -> tenant', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/models/account.py': MODEL('accounts', 'Account'),
        'backend/admin_platform/models/user.py': MODEL('platform_users', 'PlatformUser'),
      });
      const { code, stdout } = await runCli(repo, ['init', '--planes']);
      expect(code).toBe(0);
      const planesPath = repo.path('.gateforge/planes.json');
      expect(existsSync(planesPath)).toBe(true);
      expect(stdout).toContain('created:');
      expect(stdout).toContain('review the reasons');
      // The document round-trips the runtime's own strict parser.
      const config = readPlanesConfigOrNull(planesPath);
      const byMatch = new Map(config.rules.map((rule) => [rule.match, rule]));
      expect(byMatch.get('backend/admin_platform/**')?.plane).toBe('master');
      expect(byMatch.get('backend/models/**')?.plane).toBe('tenant');
      for (const rule of config.rules) {
        expect(rule.reason).toContain("inferred from model directory");
        expect(rule.reason).toContain('review');
      }
    });
  });

  it('a single model tree still proposes one rule (absence blocks every table)', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/models/account.py': MODEL('accounts', 'Account'),
      });
      const { code } = await runCli(repo, ['init', '--planes']);
      expect(code).toBe(0);
      const config = readPlanesConfigOrNull(repo.path('.gateforge/planes.json'));
      expect(config.rules).toHaveLength(1);
      expect(config.rules[0]?.match).toBe('backend/models/*.py');
      expect(config.rules[0]?.plane).toBe('tenant');
    });
  });

  it('never overwrites an existing planes.json (idempotent, review artifact)', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/models/account.py': MODEL('accounts', 'Account'),
        '.gateforge/planes.json': JSON.stringify({
          rules: [{ match: 'backend/models/**', plane: 'global', reason: 'hand-reviewed' }],
        }),
      });
      const { code, stdout } = await runCli(repo, ['init', '--planes']);
      expect(code).toBe(0);
      expect(stdout).toContain('exists, leaving untouched');
      const config = readPlanesConfigOrNull(repo.path('.gateforge/planes.json'));
      expect(config.rules[0]?.plane).toBe('global');
      expect(config.rules[0]?.reason).toBe('hand-reviewed');
    });
  });
});
