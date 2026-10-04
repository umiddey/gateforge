/**
 * `gateforge enforcement doctor` (plan 2026-09-13 Phase 5 item 7, ADR
 * 0005 D1): one honest diagnostic surface. The assertions pin the two
 * honesty rules that matter most: a hook is NEVER reported as managed
 * protection, and a managed mode whose authoritative `.git` is
 * agent-writable is reported as NOT active. Exit is 0 whenever the
 * doctor runs (diagnostic), `--json` is deterministic.
 */
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';
import { installCommitHook } from '../src/git-hooks.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt } from '../src/commands/common.js';

/** Sanitized env for direct module calls. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

interface DoctorJson {
  mode: 'standard' | 'managed';
  level: number;
  strictE2E: boolean;
  ready: boolean;
  checks: Array<{ id: string; status: 'ok' | 'warn' | 'fail'; detail: string }>;
  engine: { version: string; source: string; unpublished: boolean };
}

/** Parses the doctor's deterministic JSON output. */
function parseDoctor(stdout: string): DoctorJson {
  return JSON.parse(stdout) as DoctorJson;
}

function checkById(report: DoctorJson, id: string): { status: string; detail: string } {
  const found = report.checks.find((entry) => entry.id === id);
  expect(found, `check '${id}' present`).toBeTruthy();
  return found as { status: string; detail: string };
}

describe('enforcement doctor (standard mode reports honestly)', () => {
  it('reports mode/boundary honestly: a missing hook is never managed protection', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0); // the doctor always runs (diagnostic)
      const report = parseDoctor(result.stdout);
      expect(report.mode).toBe('standard');
      expect(report.engine.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report.engine.source).toMatch(/^(registry|local path )/);
      expect(typeof report.engine.unpublished).toBe('boolean');
      expect(report.strictE2E).toBe(false);
      expect(report.checks.map((entry) => entry.id)).toEqual([
        'adapters',
        'approved-digest',
        'behavior-profile',
        'ci',
        'config',
        'enforcement-mode',
        'engine-browser',
        'hook',
        'hook-mutation',
        'managed-guarantee',
        'observer',
        'playwright-projects',
        'policy-inputs-staged',
        'policy-inputs-vs-HEAD',
        'runner',
        'server-protection',
        'snapshot',
        'strictness-mode',
        'trusted-binary-policy',
        'verifier-key-location',
      ]);
      expect(checkById(report, 'config').status).toBe('ok');
      // Behavior profile not configured: ok (basic behavior only).
      const behavior = checkById(report, 'behavior-profile');
      expect(behavior.status).toBe('ok');
      expect(behavior.detail).toContain('not configured');
      // No hook installed: a warning, precisely.
      const hook = checkById(report, 'hook');
      expect(hook.status).toBe('warn');
      expect(hook.detail).toContain('no pre-commit hook');
      // THE honesty rule: standard mode never claims managed protection.
      const managed = checkById(report, 'managed-guarantee');
      expect(managed.status).toBe('warn');
      expect(managed.detail).toContain('managed guarantees NOT active');
      expect(managed.detail).toContain('ADR 0005 D1');
      // Runner readiness is a real probe (no node_modules above the tmp repo).
      expect(checkById(report, 'runner').status).toBe('fail');
      expect(checkById(report, 'snapshot').status).toBe('ok');
      expect(report.ready).toBe(false);
    });
  });

  it('detects file mutations from repeated pre-commit hook runs and recommends gate ordering', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.pre-commit-config.yaml': [
          'repos:',
          '  - repo: local',
          '    hooks:',
          '      - id: formatter',
          '        name: formatter',
          '        entry: ./tools/formatter',
          '        language: system',
          '      - id: gateforge-check',
          '        name: gateforge-check',
          '        entry: gateforge check --require-e2e',
          '        language: system',
          '',
        ].join('\n'),
        'mockbin/pre-commit': '#!/bin/sh\nprintf x >> mutation-marker.txt\n',
        'mutation-marker.txt': 'start\n',
      });
      chmodSync(repo.path('mockbin/pre-commit'), 0o755);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        PATH: `${repo.path('mockbin')}:${process.env['PATH'] ?? ''}`,
      });
      const report = parseDoctor(result.stdout);
      const mutation = checkById(report, 'hook-mutation');
      expect(result.code).toBe(0);
      expect(mutation.status).toBe('warn');
      expect(mutation.detail).toContain('mutation-marker.txt');
      // The advice has to be actionable in the ORDER the owner meets
      // it: the hook does not exist yet, so it must name the command
      // that installs it and the position to give it.
      expect(mutation.detail).toContain('gateforge init --blocking');
      expect(mutation.detail).toContain('FIRST in .pre-commit-config.yaml');
      expect(mutation.detail).not.toContain('put gateforge-check first');
    });
  });

  it('ignores hook writes to git-ignored cache files because they never enter the input snapshot', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.pre-commit-config.yaml': ['repos:', '  - repo: local', '    hooks:', '      - id: lint', '        name: lint', '        entry: true', '        language: system', ''].join('\n'),
        'mockbin/pre-commit': '#!/bin/sh\nmkdir -p .lint_cache && printf "*\\n" > .lint_cache/.gitignore && date +%N >> .lint_cache/state\n',
      });
      chmodSync(repo.path('mockbin/pre-commit'), 0o755);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        PATH: `${repo.path('mockbin')}:${process.env['PATH'] ?? ''}`,
      });
      const mutation = checkById(parseDoctor(result.stdout), 'hook-mutation');
      expect(mutation.status).toBe('ok');
    });
  });

  it('lists at most five changed files and counts the rest', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.pre-commit-config.yaml': ['repos:', '  - repo: local', '    hooks:', '      - id: lint', '        name: lint', '        entry: true', '        language: system', ''].join('\n'),
        'mockbin/pre-commit': '#!/bin/sh\nfor i in 1 2 3 4 5 6 7 8; do date +%N >> "generated-$i.txt"; done\n',
      });
      chmodSync(repo.path('mockbin/pre-commit'), 0o755);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        PATH: `${repo.path('mockbin')}:${process.env['PATH'] ?? ''}`,
      });
      const mutation = checkById(parseDoctor(result.stdout), 'hook-mutation');
      expect(mutation.status).toBe('warn');
      expect(mutation.detail).toContain('generated-1.txt');
      expect(mutation.detail).toContain('and 3 more');
      expect(mutation.detail).not.toContain('generated-8.txt');
    });
  });

  it('runs hooks with the invoking user home so installed interpreters and hook caches are found', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const home = repo.path('fake-home');
      const dataHome = repo.path('fake-home/.local/share');
      mkdirSync(dataHome, { recursive: true });
      repo.writeFiles({
        '.pre-commit-config.yaml': ['repos:', '  - repo: local', '    hooks:', '      - id: lint', '        name: lint', '        entry: true', '        language: system', ''].join('\n'),
        'mockbin/pre-commit': [
          '#!/bin/sh',
          `[ "$HOME" = "${home}" ] && [ "$XDG_DATA_HOME" = "${dataHome}" ] && exit 0`,
          'i=0; while [ $i -lt 40 ]; do echo "noise line $i: interpreter not found"; i=$((i+1)); done >&2',
          'exit 1',
          '',
        ].join('\n'),
      });
      chmodSync(repo.path('mockbin/pre-commit'), 0o755);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        PATH: `${repo.path('mockbin')}:${process.env['PATH'] ?? ''}`,
        HOME: home,
        XDG_DATA_HOME: dataHome,
      });
      const mutation = checkById(parseDoctor(result.stdout), 'hook-mutation');
      expect(result.code).toBe(0);
      expect(mutation.status).toBe('ok');
    });
  });

  it('summarizes failing hook runs in a few lines instead of the full log', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.pre-commit-config.yaml': ['repos:', '  - repo: local', '    hooks:', '      - id: lint', '        name: lint', '        entry: true', '        language: system', ''].join('\n'),
        'mockbin/pre-commit': '#!/bin/sh\ni=0; while [ $i -lt 40 ]; do echo "noise line $i"; i=$((i+1)); done >&2\nexit 1\n',
      });
      chmodSync(repo.path('mockbin/pre-commit'), 0o755);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        PATH: `${repo.path('mockbin')}:${process.env['PATH'] ?? ''}`,
      });
      const mutation = checkById(parseDoctor(result.stdout), 'hook-mutation');
      expect(mutation.status).toBe('warn');
      expect(mutation.detail).toContain('noise line 39');
      expect(mutation.detail).not.toContain('noise line 10');
      expect(mutation.detail).toContain('pre-commit run --all-files');
    });
  });

  it('warns when the active verifier key is present in repository state without exposing it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const secret = 'doctor-active-verifier-key';
      const exposed = repo.path('.gateforge/verifier.key');
      writeFileSync(exposed, secret, { mode: 0o600 });
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        GATEFORGE_WITNESS_VERIFIER_KEY: secret,
      });
      const report = parseDoctor(result.stdout);
      const check = checkById(report, 'verifier-key-location');
      expect(check.status).toBe('warn');
      expect(check.detail).toContain('.gateforge/verifier.key');
      expect(result.stdout).not.toContain(secret);
    });
  });
  it('recognizes a wired CI template as level 2 without claiming server protection', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/ci/gitlab-gateforge.yml': 'gateforge:e2e-gate:\n  script:\n    - check --candidate-commit "$CI_COMMIT_SHA"\n',
        '.gitlab-ci.yml': "include:\n  - local: '.gateforge/ci/gitlab-gateforge.yml'\n",
      });
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      const report = parseDoctor(result.stdout);
      expect(result.code).toBe(0);
      expect(report.level).toBe(2);
      expect(checkById(report, 'server-protection').status).toBe('warn');
    });
  });
  it('verifies GitHub protection only when the API reports the required gateforge check', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.github/workflows/gateforge.yml': '# Generated by Gateforge\n',
        'mockbin/gh': '#!/bin/sh\nprintf \'{"required_status_checks":{"contexts":["gateforge"]}}\\n\'\n',
      });
      const ghPath = repo.path('mockbin/gh');
      chmodSync(ghPath, 0o755);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'owner/project',
        GITHUB_BASE_REF: 'main',
        PATH: `${repo.path('mockbin')}:${process.env.PATH ?? ''}`,
      });
      const report = parseDoctor(result.stdout);
      expect(result.code).toBe(0);
      expect(report.level).toBe(3);
      expect(checkById(report, 'server-protection')).toMatchObject({
        status: 'ok',
        detail: expect.stringContaining("required status check 'gateforge'"),
      });
    });
  });
  it('verifies GitLab protection and pipeline requirements from read-only API responses', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/ci/gitlab-gateforge.yml': 'gateforge:e2e-gate:\n',
        '.gitlab-ci.yml': "include:\n  - local: '.gateforge/ci/gitlab-gateforge.yml'\n",
        'mockbin/glab':
          '#!/bin/sh\ncase "$2" in\n' +
          '  projects/123) printf \'{"only_allow_merge_if_pipeline_succeeds":true}\\n\' ;;\n' +
          '  projects/123/protected_branches/main) printf \'{"name":"main","allow_force_push":false}\\n\' ;;\n' +
          '  *) exit 1 ;;\nesac\n',
      });
      const glabPath = repo.path('mockbin/glab');
      chmodSync(glabPath, 0o755);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        GITLAB_TOKEN: 'test-token',
        CI_PROJECT_ID: '123',
        CI_DEFAULT_BRANCH: 'main',
        PATH: `${repo.path('mockbin')}:${process.env.PATH ?? ''}`,
      });
      const report = parseDoctor(result.stdout);
      expect(result.code).toBe(0);
      expect(report.level).toBe(3);
      expect(checkById(report, 'server-protection').status).toBe('ok');
    });
  });

  it('even an ACTIVE hook stays standard: the boundary warning remains', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      expect(installCommitHook(repo.root, gitEnv()).status).toBe('installed');
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0);
      const report = parseDoctor(result.stdout);
      const hook = checkById(report, 'hook');
      expect(hook.status).toBe('ok');
      expect(hook.detail).toContain('installed and active');
      // Still honest: the hook alone is not managed protection.
      expect(checkById(report, 'managed-guarantee').detail).toContain('managed guarantees NOT active');
    });
  });

  it('prints the FULL trusted policy digest plus the owner pin action when no pin is provisioned', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const digest = trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root));
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      const json = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        GATEFORGE_APPROVED_POLICY_DIGEST: undefined,
      });
      expect(json.code).toBe(0);
      const policy = checkById(parseDoctor(json.stdout), 'trusted-binary-policy');
      expect(policy.status).toBe('ok');
      // The full 64-hex digest — never a prefix — in the JSON
      // report, with the exact owner action for the absent pin.
      expect(policy.detail).toContain(digest);
      expect(policy.detail).toContain(
        `owner: pin this revision with GATEFORGE_APPROVED_POLICY_DIGEST=${digest}`,
      );
      expect(policy.detail).toContain('GATEFORGE_TRUSTED_CONFIG outside the repo');
      // The text surface carries the same full digest and action.
      const text = await runCli(repo, ['enforcement', 'doctor'], {
        GATEFORGE_APPROVED_POLICY_DIGEST: undefined,
      });
      expect(text.code).toBe(0);
      expect(text.stdout).toContain(digest);
      expect(text.stdout).toContain(
        `owner: pin this revision with GATEFORGE_APPROVED_POLICY_DIGEST=${digest}`,
      );
    });
  });

  it('prints the full digest without a pin action once the provisioned pin matches', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const digest = trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root));
      const json = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        GATEFORGE_APPROVED_POLICY_DIGEST: digest,
      });
      const policy = checkById(parseDoctor(json.stdout), 'trusted-binary-policy');
      expect(policy.detail).toContain(digest);
      expect(policy.detail).toContain('matches the candidate policy revision');
      expect(policy.detail).not.toContain('owner: pin this revision');
    });
  });

  it('warns when a policy input differs between the staged index and the working tree', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      // An unstaged edit to a policy input: the commit gate
      // digests the STAGED bytes while the digest doctor prints
      // above is computed from the WORKING TREE — pinning it would
      // pin the wrong revision.
      repo.writeFiles({
        '.gateforge.yml': `${readFileSync(repo.path('.gateforge.yml'), 'utf8')}# unstaged policy edit\n`,
      });
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0);
      const policy = checkById(parseDoctor(result.stdout), 'policy-inputs-staged');
      expect(policy.status).toBe('warn');
      expect(policy.detail).toContain('policy inputs differ between the staged index and the working tree');
      expect(policy.detail).toContain('.gateforge.yml');
      expect(policy.detail).toContain('the commit gate digests the STAGED bytes');
      expect(policy.detail).toContain('stage them (git add) before pinning the digest printed here');
    });
  });

  it('reports policy inputs fully staged when the index matches the working tree', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0);
      const policy = checkById(parseDoctor(result.stdout), 'policy-inputs-staged');
      expect(policy.status).toBe('ok');
      expect(policy.detail).toContain('policy inputs are fully staged');
    });
  });

  it('names exactly the trusted policy inputs the staged index changes since HEAD', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('policy inputs');
      // The digest the commit gate will compute over the STAGED bytes,
      // captured for the committed revision before the edit.
      const committed = trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root));
      // A whitespace-only edit to ONE policy input still moves the
      // digest, so it must be named (and named alone).
      repo.writeFiles({
        '.gateforge/policies.yml': `${readFileSync(repo.path('.gateforge/policies.yml'), 'utf8')}\n`,
      });
      repo.stage();
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        GATEFORGE_APPROVED_POLICY_DIGEST: committed,
      });
      expect(result.code).toBe(0);
      const report = parseDoctor(result.stdout);
      const drift = checkById(report, 'policy-inputs-vs-HEAD');
      expect(drift.status).toBe('warn');
      expect(drift.detail).toContain('policy inputs changed since HEAD: .gateforge/policies.yml');
      expect(drift.detail).not.toContain('classification-policy.yml');
      // The provisioned pin for the committed revision no longer matches
      // what the commit gate digests — and the row says which input moved.
      const approved = checkById(report, 'approved-digest');
      expect(approved.status).toBe('warn');
      expect(approved.detail).toContain(
        'approved policy digest: does NOT match staged (changed inputs: .gateforge/policies.yml)',
      );
    });
  });

  it('reports the approved digest against the STAGED bytes: match, absent, stale', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('policy inputs');
      const digest = trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root));
      // Nothing staged differs from HEAD.
      const clean = checkById(parseDoctor((await runCli(repo, ['enforcement', 'doctor', '--json'])).stdout), 'policy-inputs-vs-HEAD');
      expect(clean.status).toBe('ok');
      expect(clean.detail).toContain('no trusted policy input changed since HEAD');
      const matched = checkById(
        parseDoctor((await runCli(repo, ['enforcement', 'doctor', '--json'], { GATEFORGE_APPROVED_POLICY_DIGEST: digest })).stdout),
        'approved-digest',
      );
      expect(matched.status).toBe('ok');
      expect(matched.detail).toContain(`approved policy digest: matches staged (${digest})`);
      const absent = checkById(
        parseDoctor((await runCli(repo, ['enforcement', 'doctor', '--json'], { GATEFORGE_APPROVED_POLICY_DIGEST: undefined })).stdout),
        'approved-digest',
      );
      expect(absent.status).toBe('warn');
      expect(absent.detail).toContain('approved policy digest: absent');
      const stale = checkById(
        parseDoctor((await runCli(repo, ['enforcement', 'doctor', '--json'], { GATEFORGE_APPROVED_POLICY_DIGEST: 'f'.repeat(64) })).stdout),
        'approved-digest',
      );
      expect(stale.status).toBe('warn');
      expect(stale.detail).toContain('approved policy digest: does NOT match staged');
      expect(stale.detail).toContain('no policy input changed in the staged index');
    });
  });
});

describe('enforcement doctor (managed mode with an agent-writable .git)', () => {
  it('reports managed guarantees NOT active when the authoritative repo is agent-writable', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Switch the fixture config to managed mode (schema-valid section).
      const configPath = repo.path('.gateforge.yml');
      repo.writeFiles({
        '.gateforge.yml': `${readFileSync(configPath, 'utf8')}\nenforcement:\n  mode: managed\n`,
      });
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0); // diagnostic: per-check statuses, not an exit gate
      const report = parseDoctor(result.stdout);
      expect(report.mode).toBe('managed');
      const managed = checkById(report, 'managed-guarantee');
      expect(managed.status).toBe('fail');
      expect(managed.detail).toContain('managed guarantees NOT active: authoritative repository is agent-writable');
      expect(managed.detail).toContain('broker commit');
      expect(report.ready).toBe(false);
    });
  });
});

describe('enforcement doctor (determinism + text surface)', () => {
  it('--json is byte-identical across runs; text mode lists per-check statuses', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const first = await runCli(repo, ['enforcement', 'doctor', '--json']);
      const second = await runCli(repo, ['enforcement', 'doctor', '--json']);
      // The host-load advisory reports the machine's live load average and
      // free disk, which move between two runs; every other byte is a
      // function of the repository and must not move.
      const withoutLiveHostFacts = (stdout: string): string =>
        JSON.stringify(JSON.parse(stdout), (_key, value: unknown) =>
          typeof value === 'object' && value !== null && (value as { id?: unknown }).id === 'host-load'
            ? { id: 'host-load', live: true }
            : value,
        );
      expect(withoutLiveHostFacts(first.stdout)).toContain('"id":"host-load","live":true');
      expect(withoutLiveHostFacts(first.stdout)).toBe(withoutLiveHostFacts(second.stdout));
      const text = await runCli(repo, ['enforcement', 'doctor']);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain('gateforge enforcement doctor');
      expect(text.stdout).toContain('[OK] config');
      expect(text.stdout).toContain('diagnostic only; exit 0 either way');
    });
  });
});

describe('enforcement doctor (playwright project naming)', () => {
  /** The gateforge monorepo root (playwright module resolution). */
  const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

  /** The consumer's playwright config (ESM; project pinned to chromium). */
  const PW_CONFIG =
    "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n";
  /** A config with NO projects array — the runner's implicit project is unnamed. */
  const PW_CONFIG_UNNAMED = "export default { testDir: 'e2e' };\n";

  const ACCOUNTS_SPEC = [
    "import { test } from 'playwright/test';",
    'test.describe("Accounts", () => {',
    "  test('creates an account', async ({ page }) => {",
    '    await page.goto("/accounts");',
    '  });',
    '});',
    '',
  ].join('\n');

  /**
   * Links the engine's pinned playwright into the fixture repo so
   * the enumeration resolves the consumer runner (no network, no npx).
   */
  function linkPlaywright(repo: TempRepo): void {
    const nm = join(repo.root, 'node_modules');
    mkdirSync(nm, { recursive: true });
    for (const name of ['playwright', 'playwright-core']) {
      symlinkSync(join(ROOT, 'node_modules', name), join(nm, name), 'dir');
    }
  }

  /** A playwright-configured fixture repo with the given config. */
  function installPlaywrightRepo(
    repo: TempRepo,
    playwrightConfig: string,
  ): void {
    installFixture(repo);
    repo.writeFiles({
      'package.json': '{ "type": "module", "private": true }\n',
      'playwright.config.js': playwrightConfig,
      'e2e/accounts.spec.js': ACCOUNTS_SPEC,
    });
    linkPlaywright(repo);
  }

  it('fails the playwright-projects row when the config declares no named project', async () => {
    await withTempRepo({}, async (repo) => {
      installPlaywrightRepo(repo, PW_CONFIG_UNNAMED);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      const report = parseDoctor(result.stdout);
      const check = checkById(report, 'playwright-projects');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain(
        "playwright config playwright.config.js declares no named project",
      );
      expect(check.detail).toContain(
        "add projects: [{ name: 'chromium' }] (behaviour-neutral)",
      );
      expect(report.ready).toBe(false);
      // The text surface shows the same failing row.
      const text = await runCli(repo, ['enforcement', 'doctor']);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain('[FAIL] playwright-projects:');
      expect(text.stdout).toContain('declares no named project');
    });
  });

  it('reports the named projects when the config declares them', async () => {
    await withTempRepo({}, async (repo) => {
      installPlaywrightRepo(repo, PW_CONFIG);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0);
      const report = parseDoctor(result.stdout);
      const check = checkById(report, 'playwright-projects');
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('chromium');
      expect(check.detail).not.toContain('declares no named project');
    });
  });

  it('reports ok when no playwright config exists (non-playwright repos)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0);
      const check = checkById(parseDoctor(result.stdout), 'playwright-projects');
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('no playwright config');
    });
  });
});
