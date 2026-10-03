/**
 * `init` on a repository that already has something (0.9.0): the ways the
 * first run used to mislead, each with the regression that fails on the
 * old code and passes on the new one.
 *
 * 1.  one line per file — `created: .gateforge.yml` followed by
 *     `exists, leaving untouched: .gateforge.yml` about the SAME file
 *     (the behavior step re-attempted the config);
 * 2.  a complete `undo:` — files created AND files changed in place;
 * 3.  no contradictory CI lines — `updated …` and `kept … this run
 *     created none` about the same `.gitlab-ci.yml`;
 * 4.  server-setup instructions for the detected provider only;
 * 5.  recommendation evidence prefers application code, and the
 *     default excludes cover hidden dot-folders (except `.gateforge`);
 * 11. `init` names `gateforge adopt` on a repository that has debt;
 * 23. the engine's own run state is gitignored, idempotently.
 *
 * Plus `--docs-exclude-file`, the one-folder-per-line alternative to the
 * comma list.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import { writeServerProtectionInstructions } from '../src/commands/blocking.js';
import { CaptureStream, type Io } from '../src/io.js';

/** How many times a rule appears in a `.gitignore`. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A minimal io for a direct module call. */
function captureIo(cwd: string): { io: Io; text: () => string } {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  return { io: { cwd, env: {}, stdout, stderr }, text: () => stdout.text() };
}

describe('init gitignores the engine-owned run state (23)', () => {
  it('creates .gitignore when absent and names the rule it wrote', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/main.py': 'VALUE = 1\n' });
      const { code, stdout, stderr } = await runCli(repo, ['init', '--no-scan', '--preset', 'light']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const text = readFileSync(repo.path('.gitignore'), 'utf8');
      expect(text).toContain('.gateforge/test-gates/');
      expect(occurrences(text, '.gateforge/test-gates/')).toBe(1);
      // The run NAMES the file it created for the engine's own state.
      expect(stdout).toContain('gateforge engine state ignored: .gateforge/test-gates/');
      // And the undo line carries it, because this run created it.
      const remove = stdout.split('\n').find((line) => line.startsWith('undo: rm -rf')) ?? '';
      expect(remove).toContain('.gitignore');
    });
  });

  it('appends to an existing .gitignore without touching the owner lines', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/main.py': 'VALUE = 1\n', '.gitignore': 'node_modules/\n*.log\n' });
      const { code, stdout, stderr } = await runCli(repo, ['init', '--no-scan', '--preset', 'light']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const text = readFileSync(repo.path('.gitignore'), 'utf8');
      expect(text).toContain('node_modules/');
      expect(text).toContain('*.log');
      expect(occurrences(text, '.gateforge/test-gates/')).toBe(1);
      // Appended in place, so the undo is a restore, never a delete.
      expect(stdout).toContain('undo: git restore -- .gitignore');
    });
  });

  it('is idempotent: a second run appends nothing and reports the rule already there', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/main.py': 'VALUE = 1\n' });
      const first = await runCli(repo, ['init', '--no-scan', '--preset', 'light']);
      expect(first.code, first.stderr).toBe(0);
      const afterFirst = readFileSync(repo.path('.gitignore'), 'utf8');

      const second = await runCli(repo, ['init', '--no-scan', '--preset', 'light']);
      expect(second.code, second.stderr).toBe(0);
      expect(second.stdout).toContain('gateforge engine state already ignored');
      expect(readFileSync(repo.path('.gitignore'), 'utf8')).toBe(afterFirst);
      expect(occurrences(afterFirst, '.gateforge/test-gates/')).toBe(1);
    });
  });
});

describe('init reports every file it created AND every file it changed (2, 3)', () => {
  it('names the files it appended to under a git restore undo line', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'app/main.py': 'VALUE = 1\n',
        '.gitlab-ci.yml': 'stages:\n  - test\n',
        '.pre-commit-config.yaml': 'repos: []\n',
        // All three exist BEFORE this run, so init only APPENDS to them:
        // each must land in the `git restore` undo line, never the `rm`.
        '.gitignore': 'node_modules/\n',
      });
      const { code, stdout, stderr } = await runCli(repo, ['init', '--no-scan', '--preset', 'normal']);
      expect(code, stderr).toBe(0);
      const restore = stdout.split('\n').find((line) => line.startsWith('undo: git restore --'));
      expect(restore, 'a run that appended to existing files must name them').toBeDefined();
      // Every in-place change this run made is named, and none of them
      // is offered for deletion.
      expect(restore).toContain('.gitlab-ci.yml');
      expect(restore).toContain('.pre-commit-config.yaml');
      expect(restore).toContain('.gitignore');
      const remove = stdout.split('\n').find((line) => line.startsWith('undo: rm -rf')) ?? '';
      expect(remove).not.toContain('.gitlab-ci.yml');
      expect(remove).not.toContain('.pre-commit-config.yaml');
      // Nothing named for undo was created by this run, and the files it
      // did create are all in the list.
      expect(remove).toContain('.gateforge.yml');
    });
  });

  it('never says "kept … this run created none" about a file it just appended to', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'app/main.py': 'VALUE = 1\n',
        '.gitlab-ci.yml': 'stages:\n  - test\n',
      });
      const { code, stdout, stderr } = await runCli(repo, ['init', '--no-scan', '--preset', 'normal']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toMatch(/updated: .*\.gitlab-ci\.yml/);
      expect(stdout).not.toContain('kept the .gitlab-ci.yml already in place (this run created none)');
      // The owner's own lines are still there: the run appended, it did
      // not rewrite.
      const ci = readFileSync(repo.path('.gitlab-ci.yml'), 'utf8');
      expect(ci).toContain('stages:');
      expect(ci).toContain('gitlab-gateforge.yml');
    });
  });
});

describe('init writes each scaffold file exactly once (1)', () => {
  it('does not print "created" and "exists, leaving untouched" for the same config', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/main.py': 'VALUE = 1\n' });
      const { code, stdout, stderr } = await runCli(repo, [
        'init',
        '--no-scan',
        '--preset',
        'light',
        '--behavior',
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const config = repo.path('.gateforge.yml');
      const created = stdout.split('\n').filter((line) => line === `created: ${config}`);
      const untouched = stdout.split('\n').filter((line) => line === `exists, leaving untouched: ${config}`);
      expect(created).toHaveLength(1);
      expect(untouched).toHaveLength(0);
      // The richer content the second step wanted is what actually landed.
      expect(readFileSync(config, 'utf8')).toContain('behaviorPolicy: .gateforge/behavior.yml');
    });
  });
});

describe('init prints server setup for the detected provider only (4)', () => {
  it('never hands GitHub branch-protection commands to a GitLab repository', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/main.py': 'VALUE = 1\n', '.gitlab-ci.yml': 'stages:\n  - test\n' });
      const { code, stdout, stderr } = await runCli(repo, ['init', '--no-scan', '--preset', 'normal']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain('detected CI provider: gitlab');
      expect(stdout).not.toContain('GitHub: gh api');
      expect(stdout).toContain('GitLab: glab api');
    });
  });

  it('shows GitHub-only instructions for a GitHub repository', async () => {
    await withTempRepo({}, async (repo) => {
      const { io, text } = captureIo(repo.root);
      writeServerProtectionInstructions(io, 'github');
      expect(text()).toContain('detected CI provider: github');
      expect(text()).toContain('GitHub: gh api');
      expect(text()).not.toContain('GitLab: glab api');
    });
  });

  it('shows both only when no provider could be detected, and says so', async () => {
    await withTempRepo({}, async (repo) => {
      const { io, text } = captureIo(repo.root);
      writeServerProtectionInstructions(io, null);
      expect(text()).toContain('no CI provider was detected');
      expect(text()).toContain('GitHub: gh api');
      expect(text()).toContain('GitLab: glab api');
    });
  });

  it('probes the repository when the caller names no provider', async () => {
    await withTempRepo({}, async (repo) => {
      writeFileSync(repo.path('.gitlab-ci.yml'), 'stages:\n  - test\n');
      const { io, text } = captureIo(repo.root);
      writeServerProtectionInstructions(io);
      expect(text()).toContain('detected CI provider: gitlab');
      expect(text()).not.toContain('GitHub: gh api');
    });
  });
});

describe('init recommends from application code, not tooling or leftovers (5)', () => {
  it('never reads a signal out of a hidden dot-folder', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ '.claude/skills/webhook/helper.py': 'from fastapi import FastAPI\n' });
      const { code, stdout, stderr } = await runCli(repo, ['init', '--preset', 'light']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain('signals: (none)');
      expect(stdout).not.toContain('FastAPI imported');
    });
  });

  it('quotes application code when a leftover folder carries the same signal', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'app/api.py': 'from fastapi import FastAPI\n',
        'archive/old_api.py': 'from fastapi import FastAPI\n',
      });
      const { code, stdout, stderr } = await runCli(repo, ['init', '--preset', 'light']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toMatch(/in app\/api\.py/);
      expect(stdout).not.toMatch(/in archive\/old_api\.py/);
    });
  });

  it('still reports a signal that ONLY a leftover carries, naming that file', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'archive/old_api.py': 'from fastapi import FastAPI\n' });
      const { code, stdout, stderr } = await runCli(repo, ['init', '--preset', 'light']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      // Detection is never weakened by the preference — only the quote.
      expect(stdout).toMatch(/in archive\/old_api\.py/);
    });
  });

  it('writes default excludes that cover hidden folders but keep .gateforge out of them', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/main.py': 'VALUE = 1\n' });
      const { code, stderr } = await runCli(repo, ['init', '--no-scan', '--preset', 'light']);
      expect(code, stderr).toBe(0);
      const configText = readFileSync(repo.path('.gateforge.yml'), 'utf8');
      expect(configText).toContain('**/.(!(gateforge))/**');
      expect(configText).toContain("'.!(gateforge)/**'");
    });
  });
});

describe('init names the adoption path on a repository that has debt (11)', () => {
  it('tells the owner what `gateforge adopt` does before the first commit', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/models.py': '__tablename__ = "orders"\n' });
      const { code, stdout, stderr } = await runCli(repo, ['init']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain('gateforge adopt');
      expect(stdout).toContain('shrink-only');
      expect(stdout).toContain('ENFORCEMENT_UNTRUSTED');
    });
  });

  it('says nothing about adopting on a repository with no code yet', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout, stderr } = await runCli(repo, ['init']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).not.toContain('already had code');
      expect(stdout).not.toContain('gateforge adopt');
    });
  });
});

describe('--docs-exclude-file is the comma list, one folder per line', () => {
  it('writes the owner declaration named by the file', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'docs/guide.md': '# Guide\n',
        'handbook/index.md': '# Handbook\n',
        'docs-folders.txt': '# documentation-only folders\ndocs\n\nhandbook\n',
      });
      const { code, stdout, stderr } = await runCli(repo, [
        'init',
        '--no-scan',
        '--docs-exclude-file',
        'docs-folders.txt',
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const declaration = readFileSync(repo.path('.gateforge/docs-exclusions.yml'), 'utf8');
      expect(declaration).toContain('schemaVersion: 1');
      expect(declaration).toContain('docs');
      expect(declaration).toContain('handbook');
      // The comment line in the list file is not a folder.
      expect(declaration).not.toContain('documentation-only');
    });
  });

  it('combines with the inline comma list into one declaration', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'docs/guide.md': '# Guide\n',
        'handbook/index.md': '# Handbook\n',
        'docs-folders.txt': 'handbook\n',
      });
      const { code, stdout, stderr } = await runCli(repo, [
        'init',
        '--no-scan',
        '--docs-exclude',
        'docs',
        '--docs-exclude-file',
        'docs-folders.txt',
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const declaration = readFileSync(repo.path('.gateforge/docs-exclusions.yml'), 'utf8');
      expect(declaration).toContain('docs');
      expect(declaration).toContain('handbook');
    });
  });

  it('refuses a list file it cannot read, naming the flag', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, [
        'init',
        '--no-scan',
        '--docs-exclude-file',
        'missing.txt',
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain('--docs-exclude-file');
      expect(stderr).toContain('missing.txt');
    });
  });

  it('mentions the flag in the usage line', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--help']);
      expect(code).toBe(0);
      expect(stdout).toContain('--docs-exclude-file <path>');
    });
  });
});
