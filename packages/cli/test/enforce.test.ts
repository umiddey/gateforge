/**
 * `gateforge enforce`: retroactive blocking wiring for already-initialized
 * repos — idempotent, and refuses to run without a gateforge config.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import { VERSION } from '../src/commands/common.js';
import { renderGithubActionsTemplate } from '../src/commands/blocking.js';

describe('gateforge enforce', () => {
  it('shares the install contract and current version with init --blocking', async () => {
    let initTemplate = '';
    await withTempRepo({}, async (repo) => {
      const initialized = await runCli(repo, ['init', '--blocking']);
      expect(initialized.code).toBe(0);
      initTemplate = readFileSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'), 'utf8');
    });
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      const enforced = await runCli(repo, ['enforce']);
      expect(enforced.code).toBe(0);
      const enforceTemplate = readFileSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'), 'utf8');
      expect(enforceTemplate).toContain(`GATEFORGE_VERSION: "${VERSION}"`);
      expect(initTemplate).toContain(`GATEFORGE_VERSION: "${VERSION}"`);
      expect(enforceTemplate).toContain('GATEFORGE_CI_NESTED_PACKAGE_DIRS');
      expect(enforceTemplate).toContain('npm ci --prefix "$package_dir"');
      expect(enforceTemplate).toContain('npm install --prefix "$package_dir"');
      expect(enforceTemplate).toContain('corepack pnpm');
      expect(enforceTemplate).toContain('corepack yarn');
      const installStart = '      install_node_package() {';
      const installEnd = '      echo "Gateforge CI: using pinned Gateforge $actual_version"';
      const initStart = initTemplate.indexOf(installStart);
      const enforceStart = enforceTemplate.indexOf(installStart);
      expect(initStart).toBeGreaterThanOrEqual(0);
      expect(enforceStart).toBeGreaterThanOrEqual(0);
      expect(initTemplate.slice(initStart, initTemplate.indexOf(installEnd))).toBe(
        enforceTemplate.slice(enforceStart, enforceTemplate.indexOf(installEnd)),
      );
      const strictCi = parseYaml(initTemplate) as {
        'gateforge:e2e-gate': {
          rules: Array<{ if: string }>;
          artifacts: { paths: string[] };
          script: string[];
        };
      };
      expect(strictCi['gateforge:e2e-gate'].rules).toEqual([
        { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
        { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' },
      ]);
      expect(strictCi['gateforge:e2e-gate'].artifacts.paths).toContain(
        '.gateforge/test-gates/execution-result.json',
      );
      expect(strictCi['gateforge:e2e-gate'].script.join('\n')).toContain(
        'run_gateforge test-gates --changed --scope changed',
      );
      expect(enforceTemplate).toContain('run_gateforge check --changed');
      expect(initTemplate).toContain('run_gateforge test-gates --changed --scope changed');
      expect(initTemplate).toContain('CI_MERGE_REQUEST_DIFF_BASE_SHA');
      expect(initTemplate).toContain('execution-result.json');
      expect(initTemplate).toContain('CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
      expect(enforceTemplate).not.toContain('summary.satisfied');
    });
  }, 120_000);

  it.skipIf(process.platform === 'win32')('installs root and declared nested packages from lockfiles', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      expect((await runCli(repo, ['enforce'])).code).toBe(0);
      const template = readFileSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'), 'utf8');
      const parsed = parseYaml(template) as {
        'gateforge:check': { script: string[] };
      };
      const installScript = parsed['gateforge:check'].script[0] ?? '';
      writeFileSync(repo.path('package.json'), '{"devDependencies":{"@gate-forge/cli":"0.7.0"}}\n');
      mkdirSync(repo.path('e2e'), { recursive: true });
      writeFileSync(repo.path('package-lock.json'), '{}\n');
      writeFileSync(repo.path('e2e/package.json'), '{"dependencies":{"dotenv":"1.0.0"}}\n');
      writeFileSync(repo.path('e2e/package-lock.json'), '{}\n');

      const fakeBin = repo.path('fake-bin');
      const gateBin = repo.path('node_modules/.bin');
      const installLog = repo.path('install.log');
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(gateBin, { recursive: true });
      writeFileSync(
        join(fakeBin, 'npm'),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GATEFORGE_TEST_INSTALL_LOG"\n',
        { mode: 0o755 },
      );
      writeFileSync(join(gateBin, 'gateforge'), '#!/bin/sh\nprintf "0.7.0\\n"\n', { mode: 0o755 });

      const result = spawnSync('/bin/sh', ['-c', installScript], {
        cwd: repo.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: fakeBin,
          GATEFORGE_VERSION: '0.7.0',
          GATEFORGE_CI_NESTED_PACKAGE_DIRS: 'e2e',
          GATEFORGE_TEST_INSTALL_LOG: installLog,
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(installLog, 'utf8').trim().split('\n')).toEqual([
        'ci --prefix .',
        'ci --prefix e2e',
      ]);
    });
  });

  it.skipIf(process.platform === 'win32')('installs manifest-only root and nested packages', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      expect((await runCli(repo, ['enforce'])).code).toBe(0);
      const template = readFileSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'), 'utf8');
      const parsed = parseYaml(template) as {
        'gateforge:check': { script: string[] };
      };
      const installScript = parsed['gateforge:check'].script[0] ?? '';
      writeFileSync(repo.path('package.json'), '{"devDependencies":{"@gate-forge/cli":"0.7.0"}}\n');
      mkdirSync(repo.path('e2e'), { recursive: true });
      writeFileSync(repo.path('e2e/package.json'), '{"dependencies":{"dotenv":"1.0.0"}}\n');

      const fakeBin = repo.path('fake-bin');
      const gateBin = repo.path('node_modules/.bin');
      const installLog = repo.path('install.log');
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(gateBin, { recursive: true });
      writeFileSync(
        join(fakeBin, 'npm'),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GATEFORGE_TEST_INSTALL_LOG"\n',
        { mode: 0o755 },
      );
      writeFileSync(join(gateBin, 'gateforge'), '#!/bin/sh\nprintf "0.7.0\\n"\n', { mode: 0o755 });

      const result = spawnSync('/bin/sh', ['-c', installScript], {
        cwd: repo.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: fakeBin,
          GATEFORGE_VERSION: '0.7.0',
          GATEFORGE_CI_NESTED_PACKAGE_DIRS: 'e2e',
          GATEFORGE_TEST_INSTALL_LOG: installLog,
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(installLog, 'utf8').trim().split('\n')).toEqual([
        'install --prefix .',
        'install --prefix e2e',
      ]);
    });
  });

  it('wires the blocking gate into an initialized repo, idempotently', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      const first = await runCli(repo, ['enforce']);
      expect(first.code).toBe(0);
      const hook = repo.path('.gateforge/hooks/gateforge-check.mjs');
      expect(existsSync(hook)).toBe(true);
      expect(readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8')).toContain('gateforge-check');
      expect(existsSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'))).toBe(true);
      expect(readFileSync(repo.path('.gitlab-ci.yml'), 'utf8')).toContain('gitlab-gateforge.yml');
      // idempotent: a second enforce must not duplicate the hook entry
      const again = await runCli(repo, ['enforce']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('exists, leaving untouched');
      const count = readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8').split('id: gateforge-check').length - 1;
      expect(count).toBe(1);
    });
  });

  it('preserves legacy pre-commit wiring when an existing config omits receiptStage', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      const configPath = repo.path('.gateforge.yml');
      writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('  receiptStage: pre-push\n', ''));
      const enforced = await runCli(repo, ['enforce']);
      expect(enforced.code).toBe(0);
      expect(existsSync(repo.path('.git/hooks/pre-push'))).toBe(false);
      expect(readFileSync(repo.path('.gateforge/hooks/gateforge-check.mjs'), 'utf8')).toContain(
        'const args = ["check","--changed"]',
      );
    });
  });

  it('announces the pre-commit edit as an action, with the undo command', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      // A repo that already has its own hooks: the wiring EDITS that file.
      const existing = ['repos:', '  - repo: local', '    hooks:', '      - id: lint', '        name: lint', '        entry: true', '        language: system', ''].join('\n');
      writeFileSync(repo.path('.pre-commit-config.yaml'), existing);
      repo.stage(['.pre-commit-config.yaml']);
      repo.commit('repo hooks');
      const enforced = await runCli(repo, ['enforce']);
      expect(enforced.code).toBe(0);
      // ONE plain line: what changed, and the exact command that takes
      // it back — runnable as printed.
      const line = enforced.stdout
        .split('\n')
        .find((entry) => entry.startsWith('updated: ') && entry.includes('.pre-commit-config.yaml'));
      expect(line).toBeDefined();
      expect(line).toContain('gateforge-check hook appended');
      expect(line).toContain('undo: git restore -- .pre-commit-config.yaml');
      const restore = spawnSync('git', ['restore', '--', '.pre-commit-config.yaml'], { cwd: repo.root, encoding: 'utf8' });
      expect(restore.status).toBe(0);
      expect(readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8')).toBe(existing);
    });
  }, 120_000);

  it('never prints an undo command that cannot run (untracked config)', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      writeFileSync(repo.path('.pre-commit-config.yaml'), 'repos: []\n');
      const enforced = await runCli(repo, ['enforce']);
      expect(enforced.code).toBe(0);
      const line = enforced.stdout
        .split('\n')
        .find((entry) => entry.startsWith('updated: ') && entry.includes('.pre-commit-config.yaml'));
      // An untracked file has nothing for `git restore` to restore, so
      // the line must not tell the owner to run it.
      expect(line).not.toContain('git restore');
      expect(line).toContain('undo:');
      expect(line).toContain('not tracked by git');
    });
  }, 120_000);

  it('refuses to run without a gateforge config', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['enforce']);
      expect(code).toBe(2);
      expect(stderr).toContain('gateforge init');
      expect(existsSync(repo.path('.pre-commit-config.yaml'))).toBe(false);
    });
  });
  it('selects the GitHub Actions template explicitly', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      const enforced = await runCli(repo, ['enforce', '--ci', 'github']);
      expect(enforced.code).toBe(0);
      expect(existsSync(repo.path('.github/workflows/gateforge.yml'))).toBe(true);
      expect(readFileSync(repo.path('.github/workflows/gateforge.yml'), 'utf8')).toContain(
        'gateforge check --changed --candidate-commit "$GITHUB_SHA" --require-e2e',
      );
      const workflow = readFileSync(repo.path('.github/workflows/gateforge.yml'), 'utf8');
      expect(parseYaml(workflow)).toBeDefined();
      expect(workflow).toContain('gateforge test-gates --changed --scope changed');
      expect(workflow).toContain('actions/download-artifact@v4');
      expect(workflow).toContain('actions/upload-artifact@v4');
      expect(workflow).toContain('actions: read');
      expect(existsSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'))).toBe(false);
    });
  }, 120_000);

  it('wires the engine install to a declared tarball/directory source', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      const enforced = await runCli(repo, ['enforce', '--ci', 'github'], {
        GATEFORGE_CI_ENGINE_SOURCE: 'vendor/gate-forge-cli-0.7.1.tgz',
      });
      expect(enforced.code).toBe(0);
      const workflow = readFileSync(repo.path('.github/workflows/gateforge.yml'), 'utf8');
      // Still a valid workflow, and the install step is the declared
      // source — a tarball/directory install of an UNPUBLISHED engine.
      expect(parseYaml(workflow)).toBeDefined();
      expect(workflow).toContain('GATEFORGE_CI_ENGINE_SOURCE: "vendor/gate-forge-cli-0.7.1.tgz"');
      expect(workflow).toContain('run: npm install --no-save --package-lock=false "$GATEFORGE_CI_ENGINE_SOURCE"');
      expect(workflow).not.toContain('@gate-forge/cli@');
    });
  }, 120_000);

  it('refuses an engine source that would read as an npm flag', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      const enforced = await runCli(repo, ['enforce', '--ci', 'github'], {
        GATEFORGE_CI_ENGINE_SOURCE: '--registry=https://example.invalid',
      });
      expect(enforced.code).toBe(2);
      expect(existsSync(repo.path('.github/workflows/gateforge.yml'))).toBe(false);
    });
  }, 120_000);

  it('generates the registry workflow byte-identically when no source is declared', () => {
    // Frozen default bytes: the shipped template's every byte, hashed.
    // A release that never declares a source must keep today's output
    // exactly, so the golden digest moves only with a deliberate change.
    expect(createHash('sha256').update(renderGithubActionsTemplate()).digest('hex')).toBe(
      // The digest of the registry-only workflow as shipped before the
      // engine-source variable existed — one byte of drift fails here.
      '3a00711405a80e7246715e1cdce9d53dbc4f8dfd5afd977edcfff6789dd7c957',
    );
    expect(renderGithubActionsTemplate()).toContain(
      '      - name: Install Gateforge\n        run: npm install --no-save --package-lock=false @gate-forge/cli@' +
        VERSION,
    );
    expect(renderGithubActionsTemplate()).not.toContain('GATEFORGE_CI_ENGINE_SOURCE');
  });
});
