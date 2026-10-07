/**
 * `gateforge init`: generation, idempotence, and the no-overwrite rule
 * (automatic classification contract).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { OWNER_ANSWERS_PATH, withTempRepo, loadConfig } from '@gate-forge/core';
import { VERSION } from '../src/commands/common.js';
import { planesConfigFromSection, type PlaneConfigRule } from '@gate-forge/pack-sqlalchemy';
import { runCli } from './helpers.js';

/** The pack-playwright package root (its packed layout is the fixture's home). */
function packPlaywrightRoot(): string {
  return fileURLToPath(new URL('../../pack-playwright', import.meta.url));
}

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
      expect(existsSync(repo.path('.gateforge/docs-exclusions.yml'))).toBe(false);
      // The generated config must be loadable by the pinned schema.
      expect(() => loadConfig(join(repo.root, '.gateforge.yml'))).not.toThrow();
    });
  });

  it('names the pack install once at the CLI version, and stays silent when the packs are declared', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/api/v1/accounts.py': 'from fastapi import FastAPI\n',
        'backend/models/account.py': 'from sqlalchemy.orm import DeclarativeBase\n\n\nclass Base(DeclarativeBase):\n    pass\n',
      });
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      // Exactly ONE line, naming every recommended pack at the CLI's own
      // version — the guide tells the owner to add them as direct
      // dependencies, and init used to write the config without saying so.
      const lines = stdout.split('\n').filter((line) => line.includes('npm i -D @gate-forge/'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`@gate-forge/pack-fastapi@${VERSION}`);
      expect(lines[0]).toContain(`@gate-forge/pack-sqlalchemy@${VERSION}`);
    });

    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/api/v1/accounts.py': 'from fastapi import FastAPI\n',
        'package.json': `${JSON.stringify(
          {
            name: 'fixture-app',
            private: true,
            devDependencies: {
              '@gate-forge/pack-fastapi': '^0.9.0',
              '@gate-forge/pack-sqlalchemy': '^0.9.0',
            },
          },
          null,
          2,
        )}\n`,
      });
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      // Already declared (at any version): nothing to install, nothing said.
      expect(stdout).not.toContain('npm i -D @gate-forge/');
    });
  });

  it('records explicit owner docs exclusions and keeps the declaration idempotent', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'docs/guide.md': '# Owner-only assertion\n' });
      const first = await runCli(repo, ['init', '--no-scan', '--docs-exclude', 'docs']);
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
      const approval = readFileSync(repo.path('.gateforge.yml'), 'utf8');
      expect(approval).toContain('evidence:');
      expect(approval).toContain('- "docs"');
      expect(first.stdout).toContain('owner-declared documentation folders: docs');
      expect(first.stdout).toContain('app/test read can make old evidence look valid');
      expect(first.stdout).toMatch(/candidate policy digest to approve outside the repository: [0-9a-f]{64}/);
      expect(first.stdout).toContain('GATEFORGE_APPROVED_POLICY_DIGEST');

      const second = await runCli(repo, ['init', '--no-scan']);
      expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toBe(approval);
      expect(second.stdout).toContain('owner-declared documentation folders: docs');
      expect(second.stdout).not.toContain(`${repo.path('.gateforge.yml')} (evidence.exclude)`);
    });
  });
  it('records exact Python bytecode exclusions and requires confirmation to change them', async () => {
    await withTempRepo({}, async (repo) => {
      const firstFile = 'src/__pycache__/accounts.cpython-313.pyc';
      const secondFile = 'src/__pycache__/orders.cpython-313.pyc';
      repo.writeFiles({ [firstFile]: 'generated bytecode\n', [secondFile]: 'generated bytecode\n' });

      const first = await runCli(repo, ['init', '--no-scan', '--cache-exclude', firstFile]);
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
      const declaration = readFileSync(repo.path('.gateforge.yml'), 'utf8');
      expect(declaration).toContain('cache:');
      expect(declaration).toContain(`- "${firstFile}"`);
      expect(first.stdout).toContain(`owner-declared Python bytecode files: ${firstFile}`);
      expect(first.stdout).toContain('candidate policy digest to approve outside the repository:');
      expect(first.stdout).toContain('GATEFORGE_APPROVED_POLICY_DIGEST');

      const refused = await runCli(repo, ['init', '--no-scan', '--cache-exclude', `${firstFile},${secondFile}`]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('needs explicit owner review');
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toBe(declaration);

      const approved = await runCli(repo, [
        'init',
        '--no-scan',
        '--cache-exclude',
        `${firstFile},${secondFile}`,
        '--confirm-cache-exclusions',
      ]);
      expect(approved.code, `${approved.stdout}\n${approved.stderr}`).toBe(0);
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toContain(`- "${secondFile}"`);
      expect(approved.stdout).toContain('updated:');
    });
  });

  it('accepts markdown documentation names that contain lock', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'docs/notes/signature_lock.md': '# Signature guidance\n',
        'docs/unlock-guide.md': '# Unlock guide\n',
        'docs/blocklist.md': '# Blocklist reference\n',
        'docs/memory/20260908_1700_employee_bericht_coworker_time_tracking_and_signature_lock.md':
          '# Employee report\n',
      });

      const result = await runCli(repo, [
        'init',
        '--no-scan',
        '--docs-exclude',
        'docs',
        '--confirm-doc-exclusions',
      ]);

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toContain('- "docs"');
    });
  });

  it.each([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'poetry.lock',
    'Cargo.lock',
    'composer.lock',
    'npm-shrinkwrap.json',
    'fixture-lock.json',
    'fixture-lock.yaml',
    'fixture.lock.json',
  ])('rejects lockfile %s from docs exclusions', async (lockfile) => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ [`docs/${lockfile}`]: '{}\n' });

      const result = await runCli(repo, ['init', '--no-scan', '--docs-exclude', 'docs']);

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stderr).toContain(`cannot exclude executable or gate input 'docs/${lockfile}'`);
    });
  });

  it('accepts markdown documentation filenames that describe config files', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'docs/config-guide.config.md': '# Configuration guide\n' });

      const result = await runCli(repo, ['init', '--no-scan', '--docs-exclude', 'docs']);

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    });
  });



  it('requires an explicit confirmation before it changes an existing docs approval', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'docs/guide.md': '# Guide\n', 'handbook/index.md': '# Handbook\n' });
      const first = await runCli(repo, ['init', '--no-scan', '--docs-exclude', 'docs']);
      expect(first.code).toBe(0);
      const original = readFileSync(repo.path('.gateforge.yml'), 'utf8');

      const refused = await runCli(repo, ['init', '--no-scan', '--docs-exclude', 'docs,handbook']);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('needs explicit owner review');
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toBe(original);

      const approved = await runCli(repo, [
        'init',
        '--no-scan',
        '--docs-exclude',
        'docs,handbook',
        '--confirm-doc-exclusions',
      ]);
      expect(approved.code, `${approved.stdout}\n${approved.stderr}`).toBe(0);
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toContain('- "handbook"');
      expect(approved.stdout).toContain('updated:');
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

  it('--blocking places gateforge-check FIRST in an existing block-style repos: list', async () => {
    await withTempRepo({}, async (repo) => {
      const existing = [
        'repos:',
        '  - repo: local',
        '    hooks:',
        '      - id: lint',
        '        name: lint',
        '        entry: true',
        '        language: system',
        '  - repo: https://github.com/pre-commit/pre-commit-hooks',
        '    hooks:',
        '      - id: trailing-whitespace',
        '',
      ].join('\n');
      writeFileSync(repo.path('.pre-commit-config.yaml'), existing);
      const result = await runCli(repo, ['init', '--blocking']);
      expect(result.code).toBe(0);
      const precommit = readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8');
      // The gateforge-check entry precedes the repo's own first
      // item, so a file-mutating hook can never run before the gate.
      expect(precommit.indexOf('id: gateforge-check')).toBeLessThan(precommit.indexOf('id: lint'));
      expect(result.stdout).toContain('gateforge-check hook added as the first hook');
      // is the FIRST repo entry with every original item kept in order.
      const parsed = parseYaml(precommit) as {
        repos: { repo: string; hooks: { id: string }[] }[];
      };
      expect(parsed.repos[0]?.hooks[0]?.id).toBe('gateforge-check');
      expect(parsed.repos[1]?.hooks[0]?.id).toBe('lint');
      expect(parsed.repos[2]?.hooks[0]?.id).toBe('trailing-whitespace');
    });
  });

  it('--blocking places gateforge-check FIRST when existing items sit at indent 0', async () => {
    await withTempRepo({}, async (repo) => {
      const existing = [
        'repos:',
        '- repo: local',
        '  hooks:',
        '    - id: lint',
        '      entry: true',
        '      language: system',
        '',
      ].join('\n');
      writeFileSync(repo.path('.pre-commit-config.yaml'), existing);
      const result = await runCli(repo, ['init', '--blocking']);
      expect(result.code).toBe(0);
      const precommit = readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8');
      // The re-indented block must keep the config loadable — a
      // mis-indented insert bricks every commit in the consumer repo.
      expect(() => parseYaml(precommit)).not.toThrow();
      const parsed = parseYaml(precommit) as { repos: { hooks: { id: string }[] }[] };
      expect(parsed.repos[0]?.hooks[0]?.id).toBe('gateforge-check');
      expect(parsed.repos[1]?.hooks[0]?.id).toBe('lint');
    });
  });

  it('--blocking leaves top-level keys before repos: untouched', async () => {
    await withTempRepo({}, async (repo) => {
      const existing = [
        'default_stages: [commit]',
        'exclude: ^vendor/',
        'repos:',
        '  - repo: local',
        '    hooks:',
        '      - id: lint',
        '        name: lint',
        '        entry: true',
        '        language: system',
        '',
      ].join('\n');
      writeFileSync(repo.path('.pre-commit-config.yaml'), existing);
      const result = await runCli(repo, ['init', '--blocking']);
      expect(result.code).toBe(0);
      const precommit = readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8');
      const parsed = parseYaml(precommit) as {
        default_stages: string[];
        exclude: string;
        repos: { hooks: { id: string }[] }[];
      };
      expect(parsed.default_stages).toEqual(['commit']);
      expect(parsed.exclude).toBe('^vendor/');
      expect(parsed.repos[0]?.hooks[0]?.id).toBe('gateforge-check');
      // The original top-level lines keep their exact text and position.
      const lines = precommit.split('\n');
      expect(lines[0]).toBe('default_stages: [commit]');
      expect(lines[1]).toBe('exclude: ^vendor/');
    });
  });

  it('--blocking appends with a note when the config has no block-style repos: list', async () => {
    await withTempRepo({}, async (repo) => {
      writeFileSync(repo.path('.pre-commit-config.yaml'), 'repos: []\n');
      const result = await runCli(repo, ['init', '--blocking']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('gateforge-check hook appended');
      expect(result.stdout).toContain(
        'note: could not place gateforge-check first in .pre-commit-config.yaml — move its entry to the top of repos: yourself',
      );
      expect(readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8')).toContain('gateforge-check');
    });
  });

  it('--blocking selects the repository-pinned CLI before an unrelated global CLI', async () => {
    await withTempRepo({}, async (repo) => {
      const result = await runCli(repo, ['init', '--blocking']);
      expect(result.code).toBe(0);
      const hook = readFileSync(repo.path('.gateforge/hooks/gateforge-check.mjs'), 'utf8');
      const pinnedCli = hook.indexOf('node_modules/@gate-forge/cli/bin/gateforge.js');
      const pathCli = hook.indexOf("spawnSync('gateforge', args");
      expect(pinnedCli).toBeGreaterThanOrEqual(0);
      expect(pathCli).toBeGreaterThanOrEqual(0);
      expect(pinnedCli).toBeLessThan(pathCli);

      const localCli = repo.path('node_modules/@gate-forge/cli/bin/gateforge.js');
      const globalDir = repo.path('fake-global-bin');
      const localMarker = repo.path('selected-local.txt');
      const globalMarker = repo.path('selected-global.txt');
      mkdirSync(join(repo.root, 'node_modules/@gate-forge/cli/bin'), { recursive: true });
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(
        localCli,
        "require('node:fs').writeFileSync(process.env.GATEFORGE_TEST_MARKER, 'local');\n",
      );
      writeFileSync(
        join(globalDir, 'gateforge'),
        "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.GATEFORGE_GLOBAL_MARKER, 'global');\n",
        { mode: 0o755 },
      );
      const hookEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${globalDir}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        GATEFORGE_TEST_MARKER: localMarker,
        GATEFORGE_GLOBAL_MARKER: globalMarker,
      };
      delete hookEnv.GATEFORGE_DEV_ENGINE;
      delete hookEnv.GATEFORGE_CLI;
      const execution = spawnSync(process.execPath, [repo.path('.gateforge/hooks/gateforge-check.mjs')], {
        cwd: repo.root,
        encoding: 'utf8',
        env: hookEnv,
      });
      expect(execution.status, `${execution.stdout}\n${execution.stderr}`).toBe(0);
      expect(readFileSync(localMarker, 'utf8')).toBe('local');
      expect(existsSync(globalMarker)).toBe(false);
    });
  });

  it('--blocking wires the pre-commit hook, check script, and CI template', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init', '--blocking']);
      expect(first.stdout).toContain('Server setup (review and run explicitly');
      expect(first.stdout).toContain('gh api --method PUT');
      expect(first.stdout).toContain('glab api --method');
      expect(first.code).toBe(0);
      const hook = repo.path('.gateforge/hooks/gateforge-check.mjs');
      expect(existsSync(hook)).toBe(true);
      const preCommitHook = readFileSync(repo.path('.git/hooks/pre-commit'), 'utf8');
      const prePushHook = readFileSync(repo.path('.git/hooks/pre-push'), 'utf8');
      expect(preCommitHook).toContain('check --staged');
      expect(preCommitHook).not.toContain('--require-e2e');
      expect(prePushHook).toContain('--candidate-commit');
      expect(prePushHook).toContain('--require-e2e');
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toContain('receiptStage: pre-push');
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
      expect(ciTemplate).toContain('gateforge check --changed --candidate-commit "$CI_COMMIT_SHA" --require-e2e');
      expect(ciTemplate).toContain('.gateforge/test-gates/report.json');
      expect(ciTemplate).toContain('.gateforge/test-gates/receipt.json');
      expect(ciTemplate).not.toContain('summary.satisfied');
      // Pinned engine install (lockfile-based), with a version assertion.
      expect(ciTemplate).toContain('npm ci');
      expect(ciTemplate).toContain('GATEFORGE_VERSION');
      expect(ciTemplate).toContain(`GATEFORGE_VERSION: "${VERSION}"`);
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
      expect(gateJob['rules']).toEqual([
        { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
        { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' },
      ]);
      // idempotent: second run must not duplicate the hook entry
      const again = await runCli(repo, ['init', '--blocking']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('exists, leaving untouched');
      const count = readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8').split('id: gateforge-check').length - 1;
      expect(count).toBe(1);
    });
  });

  it('without a preset or --blocking it writes no enforcement files and prints the tip', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      expect(existsSync(repo.path('.gateforge/hooks/gateforge-check.mjs'))).toBe(false);
      expect(existsSync(repo.path('.pre-commit-config.yaml'))).toBe(false);
      // The tip now names the goal edit, not the legacy --blocking
      // flag or a --preset re-run (which exits 2 on the config
      // this run just wrote).
      expect(stdout).toContain('a human must choose the goal');
      expect(stdout).toContain('edit `mode:` in .gateforge.yml');
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

  it('--plugins adds detectors to an initialized config, additively (F10)', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init', '--plugins', 'gateforge.pack-fastapi']);
      expect(first.code).toBe(0);
      expect(loadConfig(join(repo.root, '.gateforge.yml')).plugins.map((plugin) => plugin.id)).toEqual([
        'gateforge.pack-fastapi',
      ]);
      // Owner edits the merge must not clobber: a comment and a
      // hand-set `runner:` key.
      const edited = readFileSync(repo.path('.gateforge.yml'), 'utf8')
        .replace('# gateforge project configuration (schemaVersion 1)', '# owner note: keep me')
        .replace('policies: .gateforge/policies.yml', 'policies: .gateforge/policies.yml\nrunner: vitest');
      repo.writeFiles({ '.gateforge.yml': edited });

      const second = await runCli(repo, ['init', '--plugins', 'gateforge.pack-sqlalchemy']);
      expect(second.code, second.stdout).toBe(0);
      // The documented tip now works: the detector is really added...
      expect(loadConfig(join(repo.root, '.gateforge.yml')).plugins.map((plugin) => plugin.id).sort()).toEqual([
        'gateforge.pack-fastapi',
        'gateforge.pack-sqlalchemy',
      ]);
      // ...the owner's own edits survive, and the run says what it added.
      const merged = readFileSync(repo.path('.gateforge.yml'), 'utf8');
      expect(merged).toContain('# owner note: keep me');
      expect(merged).toContain('runner: vitest');
      expect(second.stdout).toMatch(/gateforge\.pack-sqlalchemy/);
      expect(second.stdout).toMatch(/added/);
    });
  });

  it('--plugins never removes a detector the owner already configured', async () => {
    await withTempRepo({}, async (repo) => {
      await runCli(repo, ['init', '--plugins', 'gateforge.pack-fastapi,gateforge.pack-sqlalchemy']);
      const second = await runCli(repo, ['init', '--plugins', 'gateforge.pack-fastapi']);
      expect(second.code).toBe(0);
      expect(loadConfig(join(repo.root, '.gateforge.yml')).plugins.map((plugin) => plugin.id).sort()).toEqual([
        'gateforge.pack-fastapi',
        'gateforge.pack-sqlalchemy',
      ]);
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
      expect(stdout).toContain('transport-only HTTP on consumed endpoints');
      expect(stdout).toContain('not provable yet: no independent browser channel');
      expect(stdout.match(/http:frontend-request-observed/g) ?? []).toHaveLength(1);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toEqual([
        'gateforge.pack-fastapi',
        'gateforge.pack-sqlalchemy',
      ]);
      // The starter selects only gradable persistence and transport evidence.
      const policies = readFileSync(repo.path('.gateforge/policies.yml'), 'utf8');
      expect(policies).toContain('user-facing-persistence');
      expect(policies).toContain('frontend-consumed-endpoints-transport-only');
      expect(policies).toContain('- http:request-observed');
      expect(policies).toContain('- http:response-status-ok');
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

  it('a SQLModel + FastAPI + generated-client repo recommends all three packs, each with a reason (F4)', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/app/main.py': ['from fastapi import FastAPI', '', 'app = FastAPI()', ''].join('\n'),
        'backend/app/models.py': [
          'from sqlmodel import Field, SQLModel',
          '',
          '',
          'class User(SQLModel, table=True):',
          '    email: str = Field(unique=True)',
          '',
        ].join('\n'),
        'frontend/package.json': '{ "name": "frontend", "private": true }\n',
        'frontend/src/client/index.ts': [
          '// This file was auto-generated by @hey-api/openapi-ts.',
          'export const getItems = () => fetch("/api/items");',
          '',
        ].join('\n'),
      });
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('signals: sqlalchemy, fastapi, http-clients');
      expect(stdout).toContain('gateforge.pack-fastapi, gateforge.pack-sqlalchemy, gateforge.pack-http');
      // One reason per recommended pack, each naming the concrete evidence.
      expect(stdout).toMatch(/gateforge\.pack-sqlalchemy .*table=True.*backend\/app\/models\.py/);
      expect(stdout).toMatch(/gateforge\.pack-fastapi .*from fastapi.*backend\/app\/main\.py/);
      expect(stdout).toMatch(/gateforge\.pack-http .*frontend\/src\/client\/index\.ts/);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toEqual([
        'gateforge.pack-fastapi',
        'gateforge.pack-sqlalchemy',
        'gateforge.pack-http',
      ]);
    });
  });

  it('a client-shaped directory name alone is not evidence for pack-http (F4)', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'frontend/package.json': '{ "name": "frontend", "private": true }\n',
        'frontend/src/client/index.ts': 'export const helper = () => 1;\n',
      });
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('signals: (none)');
      // The name alone justifies nothing: the pack is listed only as the
      // typescript language default, with no evidence behind it.
      expect(stdout).toMatch(/gateforge\.pack-http — no .*signal/);
      expect(stdout).not.toContain('frontend/src/client/index.ts');
    });
  });

  it('a nested frontend declaring react-router-dom recommends the React Router pack (fresh-clone snag 6)', async () => {
    await withTempRepo({}, async (repo) => {
      // Exactly the fresh-clone shape: the manifest lives in the nested
      // frontend workspace, not at the root.
      repo.writeFiles({
        'frontend/package.json':
          '{ "name": "frontend", "private": true, "dependencies": { "react-router-dom": "^7.18.2" } }\n',
      });
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('signals: react-router');
      // One reason, naming the concrete evidence file.
      expect(stdout).toMatch(
        /gateforge\.pack-react-router — .*'react-router-dom'.*frontend\/package\.json/,
      );
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toEqual(['gateforge.pack-react-router']);
    });
  });

  it('react-router in devDependencies recommends the pack too (fresh-clone snag 6)', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'package.json':
          '{ "name": "root", "private": true, "devDependencies": { "react-router": "^7.18.2" } }\n',
      });
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('signals: react-router');
      expect(stdout).toMatch(/gateforge\.pack-react-router — .*'react-router'.*package\.json/);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toEqual(['gateforge.pack-react-router']);
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
      expect(skill).toContain('node_modules/@gate-forge/cli/guides/TEST-ENVIRONMENT.md');
      expect(skill).toContain('node_modules/@gate-forge/cli/guides/QUICKSTART.md');
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

  it('the fixture shape init points at is really inside the installed pack (F13)', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init', '--no-scan']);
      expect(first.code, first.stdout).toBe(0);
      const overlay = readFileSync(repo.path('tests/e2e/gateforge/README.md'), 'utf8');
      const named = overlay.match(/node_modules\/@gate-forge\/pack-playwright\/[\w./-]+/);
      expect(named?.[0], `the scaffold names no file inside the installed pack: ${overlay}`).toBeDefined();
      // No monorepo path: nothing a consumer install can have.
      expect(overlay).not.toContain('example/e2e/accounts-crud-journey.spec.js');
      // The named file ships: it is in the pack's packed tarball.
      const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: packPlaywrightRoot(),
        encoding: 'utf8',
      });
      expect(packed.status, packed.stderr).toBe(0);
      const files = (JSON.parse(packed.stdout)[0].files as { path: string }[]).map((file) => file.path);
      expect(files).toContain(named![0].replace('node_modules/@gate-forge/pack-playwright/', ''));
      // The two guides GATEFORGE.md names are in the CLI package's own
      // tarball, at the path the scaffold tells the reader.
      const skill = readFileSync(repo.path('GATEFORGE.md'), 'utf8');
      const guides = [...skill.matchAll(/node_modules\/@gate-forge\/cli\/[\w./-]+/g)].map((m) => m[0]);
      expect(guides).toHaveLength(2);
      const packedCli = spawnSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
      });
      expect(packedCli.status, packedCli.stderr).toBe(0);
      const cliFiles = (JSON.parse(packedCli.stdout)[0].files as { path: string }[]).map((file) => file.path);
      for (const guide of guides) {
        expect(cliFiles).toContain(guide.replace('node_modules/@gate-forge/cli/', ''));
      }
    });
  }, 180_000);

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
    // `scan.coverage` must not name it (fail-closed at runtime). Since
    // 0.11.0 the coverage rules are SCAN settings and live in
    // `.gateforge.yml`, not in the answers document — which must carry
    // no scanner key at all.
    await withTempRepo({}, async (repo) => {
      const { code } = await runCli(repo, [
        'init', '--languages', 'python,typescript', '--plugins', 'gateforge.pack-sqlalchemy,gateforge.pack-fastapi',
      ]);
      expect(code).toBe(0);
      const config = readFileSync(repo.path('.gateforge.yml'), 'utf8');
      expect(config).not.toContain('gateforge.pack-http');
      expect(config).toContain('gateforge.pack-sqlalchemy');
      const policy = readFileSync(repo.path('.gateforge/classification-policy.yml'), 'utf8');
      for (const moved of ['scanRoots', 'coverage', 'declarations', 'volatileFields'])
        expect(policy, moved).not.toContain(`${moved}:`);
    });
    // Opting into pack-http restores its rule.
    await withTempRepo({}, async (repo) => {
      const { code } = await runCli(repo, [
        'init', '--languages', 'python,typescript',
        '--plugins', 'gateforge.pack-sqlalchemy,gateforge.pack-fastapi,gateforge.pack-http',
      ]);
      expect(code).toBe(0);
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toContain('gateforge.pack-http');
    });
  });
});
describe('gateforge init --planes (proposed planes: section from discovered model trees)', () => {
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
      // The proposal is a SECTION of the one answers document, so "nothing
      // proposed" is that document declaring no `planes:` key.
      const document = parseYaml(readFileSync(repo.path(OWNER_ANSWERS_PATH), 'utf8'));
      expect(document).not.toHaveProperty('planes');
      expect(stdout).toContain(`--planes proposes the planes: section of ${OWNER_ANSWERS_PATH}`);
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
      expect(stdout).toContain('created:');
      expect(stdout).toContain('review the reasons');
      // The document round-trips the runtime's own strict parser.
      const rules = proposedPlanes(repo);
      const byMatch = new Map(rules.map((rule) => [rule.match, rule]));
      expect(byMatch.get('backend/admin_platform/**')?.plane).toBe('master');
      expect(byMatch.get('backend/models/**')?.plane).toBe('tenant');
      for (const rule of rules) {
        expect(rule.reason).toContain('inferred from model directory');
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
      const rules = proposedPlanes(repo);
      expect(rules).toHaveLength(1);
      expect(rules[0]?.match).toBe('backend/models/*.py');
      expect(rules[0]?.plane).toBe('tenant');
    });
  });

  it('never overwrites an existing planes: section (idempotent, review artifact)', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/models/account.py': MODEL('accounts', 'Account'),
        [OWNER_ANSWERS_PATH]: `schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
planes:
  rules:
    - match: 'backend/models/**'
      plane: global
      reason: hand-reviewed
`,
      });
      const { code, stdout } = await runCli(repo, ['init', '--planes']);
      expect(code).toBe(0);
      expect(stdout).toContain('exists, leaving untouched');
      const rules = proposedPlanes(repo);
      expect(rules[0]?.plane).toBe('global');
      expect(rules[0]?.reason).toBe('hand-reviewed');
    });
  });
});

/**
 * The `planes:` rules a repository's answers document declares, read back
 * through the runtime's OWN strict parser — a fixture that asserted on raw
 * YAML would accept a section the next run refuses.
 */
function proposedPlanes(repo: { path: (relative: string) => string }): readonly PlaneConfigRule[] {
  const document = parseYaml(readFileSync(repo.path(OWNER_ANSWERS_PATH), 'utf8'));
  const section =
    typeof document === 'object' && document !== null && 'planes' in document
      ? document.planes
      : undefined;
  return planesConfigFromSection(section, `${OWNER_ANSWERS_PATH} planes:`).rules;
}

/**
 * A repository that shows the queue machinery a background worker uses
 * (BullMQ Queue/Worker, `attempts:` bound, idempotency key) but declares
 * NO `queueObserver`.
 */
const QUEUE_SOURCE_NO_OBSERVER = [
  "import { Queue, Worker } from 'bullmq';",
  '',
  "const queue = new Queue('mailer', { connection });",
  "await queue.add('send', { to });",
  "new Worker('mailer', handler, { connection });",
  '',
].join('\n');

/** The same queue machinery, plus the engine-owned `queueObserver` block. */
const QUEUE_OBSERVER_YML = `queueObserver:
  kind: bullmq
  connection:
    urlEnv: GATEFORGE_TEST_REDIS_URL
  queues:
    - name: mailer
      taskResourceId: task.email.send
`;

/**
 * The exact `gateforge init` stdout for a repository that SHOWS queue
 * machinery but declares no `queueObserver`.
 *
 * UPDATED (0.9.0): the surface legitimately moved, and the golden moved
 * with it. This fixture has source files and no `.gitignore`, so the run
 * now (a) creates `.gitignore` with the engine-state rule and names it,
 * (b) says so in the `undo: rm -rf` list, and (c) names `gateforge adopt`
 * — a repository that already has code meets debt on its first commit.
 * The assertion stays byte-exact: a drift in ANY default surface line
 * still fails here.
 *
 * UPDATED (0.9.2, item C): the run now prints ONE line naming the install
 * the written config expects — `npm i -D @gate-forge/pack-http@<cli
 * version>` — directly after the scaffolded files. init decides which
 * packs to enable and the setup guide requires them as direct
 * dependencies, so init is the only place that knows the exact list;
 * the install itself is never run for the owner.
 */
/**
 * The one line a HEADLESS init prints about how unmatched by-id routes are
 * graded (0.9.0, owner decision D7): the non-interactive answer is `warn`
 * plus the exact setting that turns blocking on. It is part of the
 * byte-exact golden below, so a change to it shows up there.
 */
const UNMATCHED_ROUTES_INIT_NOTE =
  "note: routes whose name matches no table will be REPORTED, not blocking. " +
  "set 'endpoints:\n  unmatchedRoutes: block' in .gateforge.yml (or re-run with --unmatched-routes block) to block on them\n";

const QUEUE_REPO_INIT_OUTPUT_WITHOUT_OBSERVER = "no terminal: writing the light preset (report everything, block nothing) — a human must choose the goal: edit `mode:` in .gateforge.yml (light: `mode: warn`, normal: `mode: changed`, strict: `mode: strict`) — in a terminal, `gateforge init` asks\nscan:\n  languages: javascript\n  signals: (none)\nrecommended:\n  plugins: gateforge.pack-http\n  why: gateforge.pack-http — no repository signal — the javascript default set\n  policy: persistence:* on user-facing tables; transport-only HTTP on consumed endpoints\n  proof: overlay (tests/e2e/gateforge/)\nskipped:\n  gateforge.pack-task — no semantic verifier (VERIFIER_UNSUPPORTED)\n  http:frontend-request-observed — not provable yet: no independent browser channel\n  coveragePolicy / strictE2E — owner opt-in\ntip: re-run with --plugins <comma,list> to add detectors (entries already in .gateforge.yml are kept; nothing else in the file changes)\n" +
  UNMATCHED_ROUTES_INIT_NOTE +
  "tip: non-interactive init keeps full evidence identity; use --docs-exclude <folder,...> (or --docs-exclude-file <path>, one folder per line) to opt in\ncreated: <REPO>/.gateforge.yml\ncreated: <REPO>/.gateforge/policies.yml\ncreated: <REPO>/.gateforge/classification-policy.yml\ncreated: <REPO>/.gateforge/baselines/obligations.json\ncreated: <REPO>/GATEFORGE.md\ncreated: <REPO>/tests/e2e/gateforge/README.md\n" +
  `install the enabled packs as direct dependencies (same version as the CLI): npm i -D @gate-forge/pack-http@${VERSION}\n` +
  "created: <REPO>/.gitignore (gateforge engine state ignored: .gateforge/test-gates/ — without this, `git add -A` stages the run cache and the gate blocks on its own files)\nwrote mode: warn (strict — block everything / changed — block only what this change touches / warn — block nothing)\nwrote no hooks: nothing blocks your commits — read the report instead\nundo: rm -rf .gateforge.yml .gateforge/policies.yml .gateforge/classification-policy.yml .gateforge/baselines/obligations.json GATEFORGE.md tests/e2e/gateforge/README.md .gitignore\nthis repository already had code, so `gateforge check` reports what discovery finds today, and today's findings block the first commit:\n  gateforge adopt — records today's blocking findings as forgiven debt, in a baseline plus a dated, count-annotated receipt, then wires the blocking gate.\n  it is shrink-only from here: it never forgives new work. Resolve debt and run `gateforge baseline update` to shrink the recorded set; new unproven work keeps blocking.\n  with strictE2E enabled, an adopted E2E obligation still blocks with ENFORCEMENT_UNTRUSTED as soon as a change touches it — baselined is not proof.\nskeleton ready: .gateforge/adapters, .gateforge/waivers, .gateforge/baselines\n";

describe('gateforge init: the task behavior pack is offered only with a queueObserver', () => {
  it('without a queueObserver, init output is byte-identical to the pre-change output', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'src/mailer.js': QUEUE_SOURCE_NO_OBSERVER });
      const { code, stdout, stderr } = await runCli(repo, ['init']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      // The repository SHOWS a queue (so the task needles are all present)
      // yet nothing is offered: without the engine's own queue read every
      // `task:*` case fails closed, so the pack must not be recommended.
      // This golden is the exact pre-change output of this same fixture.
      expect(stdout.split(repo.root).join('<REPO>')).toBe(QUEUE_REPO_INIT_OUTPUT_WITHOUT_OBSERVER);
      // No offer line for the pack (the pre-existing `skipped:` entry
      // naming `gateforge.pack-task` is the scan block's own text and is
      // part of the golden above).
      expect(stdout).not.toContain('--behavior-packs task');
      expect(stdout).not.toMatch(/^ {2}task — `/m);
    });
  });

  it('with a queueObserver, init offers the task pack the way it offers every other pack', async () => {
    await withTempRepo({}, async (repo) => {
      // An initialized repository whose owner pinned an engine queue
      // observer: the engine can now grade `task:*` from real job state.
      const base = await runCli(repo, ['init', '--no-scan']);
      expect(base.code, `${base.stdout}\n${base.stderr}`).toBe(0);
      repo.writeFiles({
        'src/mailer.js': QUEUE_SOURCE_NO_OBSERVER,
        '.gateforge.yml': readFileSync(repo.path('.gateforge.yml'), 'utf8') + QUEUE_OBSERVER_YML,
      });
      expect(() => loadConfig(join(repo.root, '.gateforge.yml'))).not.toThrow();

      const { code, stdout, stderr } = await runCli(repo, ['init']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      // Named exactly as the other packs are named: the namespace, its
      // evidence, then the flag that enables it.
      expect(stdout).toContain('behavior packs detected in this repository');
      expect(stdout).toMatch(/^ {2}task — `[^`]+` in src\/mailer\.js$/m);
      expect(stdout).toContain('  gateforge init --behavior-packs task');
    });
  });

  it('the task example case is a delivery case, never an HTTP request', async () => {
    await withTempRepo({}, async (repo) => {
      const base = await runCli(repo, ['init', '--no-scan']);
      expect(base.code, `${base.stdout}\n${base.stderr}`).toBe(0);
      repo.writeFiles({
        'src/mailer.js': QUEUE_SOURCE_NO_OBSERVER,
        '.gateforge.yml': readFileSync(repo.path('.gateforge.yml'), 'utf8') + QUEUE_OBSERVER_YML,
      });
      const enabled = await runCli(repo, ['init', '--behavior-packs', 'task']);
      expect(enabled.code, `${enabled.stdout}\n${enabled.stderr}`).toBe(0);
      const document = readFileSync(repo.path('.gateforge/behavior.yml'), 'utf8');
      // A task case is a claim about the delivery queue, so it declares a
      // `deliver` action on the `engine-task` channel and an `attempts`
      // state rule — an HTTP request could never settle a delivery.
      expect(document).toContain('kind: deliver');
      expect(document).toContain('channel: engine-task');
      expect(document).toContain('kind: attempts');
      expect(document).toContain('contract: task:retry-policy-enforced');
      // Declared under `resources:` — a task resource is not a route.
      expect(document).toContain('# resources:');
      expect(document).not.toContain('pathTemplate:');
      // The scaffold still parses as a document with NO declarations.
      const parsed = parseYaml(
        document
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('#'))
          .join('\n'),
      ) as { endpoints: unknown[]; resources: unknown[] };
      expect(parsed.endpoints).toEqual([]);
      expect(parsed.resources).toEqual([]);
    });
  });
});

describe('gateforge init: the install-commit note', () => {
  it('prints the note when the install (package.json) is uncommitted', async () => {
    await withTempRepo({}, async (repo) => {
      repo.commitFiles({ 'README.md': '# repo\n' }, 'base');
      // The install itself is not committed yet.
      repo.writeFiles({ 'package.json': '{"name":"repo"}\n' });
      const { code, stdout } = await runCli(repo, ['init', '--no-scan']);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain(
        'note: commit the Gateforge install (package.json and lockfile) on its own BEFORE committing the setup files',
      );
    });
  });

  it('prints no note when the install is committed', async () => {
    await withTempRepo({}, async (repo) => {
      repo.commitFiles({ 'package.json': '{"name":"repo"}\n' }, 'base');
      const { code, stdout } = await runCli(repo, ['init', '--no-scan']);
      expect(code, stdout).toBe(0);
      expect(stdout).not.toContain('note: commit the Gateforge install');
    });
  });

  it('prints no note in a repository without commits', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'package.json': '{"name":"repo"}\n' });
      const { code, stdout } = await runCli(repo, ['init', '--no-scan']);
      expect(code, stdout).toBe(0);
      expect(stdout).not.toContain('note: commit the Gateforge install');
    });
  });
});
