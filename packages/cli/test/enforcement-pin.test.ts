/**
 * `gateforge enforcement pin` (plan 2026-10-04 W2): re-pinning made
 * explicit. The pin approves the revision the COMMIT GATE digests — the
 * staged bytes — and it must live outside the candidate: a file the
 * candidate controls cannot approve its own policy revision. The tests
 * pin the three refusals that property depends on (in-repo env file,
 * not-fully-staged policy inputs, missing `--pin-file`), the write
 * itself (0600, exactly one digest line, no other line ever printed),
 * and the equality with the digest the REAL `check --staged` gate
 * accepts — asserted through that gate, not by re-running the digest
 * function here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';

/** The shipped bin: argv as NODE sees it, not as the CLI parses it. */
const REAL_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/gateforge.js');

/**
 * Runs the CLI the way an owner runs it — `node packages/cli/bin/gateforge.js …`
 * — because Node parses its OWN options out of argv before the script ever
 * sees them: `--env-file <path>` anywhere in argv makes Node READ that file
 * (exit 9, `node: <path>: not found`) and `--env-file-if-exists` silently
 * swallows the pair. A flag Node owns can never be the pin's target.
 */
function runRealBin(cwd: string, argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [REAL_BIN, ...argv], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Temp roots OUTSIDE every fixture repository (the pin may never live in one). */
const outsideRoots: string[] = [];

/** A fresh directory outside any candidate, removed after the suite. */
function outsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-pin-'));
  outsideRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (outsideRoots.length > 0) {
    rmSync(outsideRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('gateforge enforcement pin', () => {

  it('reaches the CLI through the real bin: Node never eats the pin flag', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('policy inputs');
      // A path that does not exist. With a Node-owned flag name this run
      // never reaches the CLI at all (Node reads the file and exits 9);
      // with `--pin-file` the CLI previews and writes nothing.
      const missingFile = join(outsideDir(), 'never-written.env');
      const result = runRealBin(repo.root, ['enforcement', 'pin', '--pin-file', missingFile]);
      expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('GATEFORGE_APPROVED_POLICY_DIGEST=');
      expect(result.stdout).toContain('nothing written');
      expect(existsSync(missingFile)).toBe(false);
    });
  }, 120_000);

  it('previews without writing and refuses an in-repo env file, an unstaged policy input and a missing flag', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('policy inputs');
      const envFile = join(outsideDir(), 'repo.gateforge.env');

      // Preview by default: the line is shown, nothing is written.
      const preview = await runCli(repo, ['enforcement', 'pin', '--pin-file', envFile]);
      expect(preview.code, preview.stderr).toBe(0);
      expect(preview.stdout).toContain('GATEFORGE_APPROVED_POLICY_DIGEST=');
      expect(preview.stdout).toContain('nothing written');
      expect(existsSync(envFile)).toBe(false);

      // An env file INSIDE the candidate is refused: the pin is the
      // trust boundary, so it may not live where the candidate can edit it.
      const inside = await runCli(repo, ['enforcement', 'pin', '--pin-file', '.gateforge.env', '--confirm']);
      expect(inside.code).toBe(2);
      expect(inside.stderr).toContain('is inside the repository');
      expect(inside.stderr).toContain('OUTSIDE the candidate');
      expect(existsSync(repo.path('.gateforge.env'))).toBe(false);
      const insideSubdir = await runCli(repo, ['enforcement', 'pin', '--pin-file', '.gateforge/pin.env', '--confirm']);
      expect(insideSubdir.code).toBe(2);
      expect(insideSubdir.stderr).toContain('is inside the repository');
      expect(existsSync(repo.path('.gateforge/pin.env'))).toBe(false);

      // A policy input that is not fully staged would pin a revision the
      // commit gate never digests: refuse and NAME the file.
      repo.writeFiles({
        '.gateforge/policies.yml': `${readFileSync(repo.path('.gateforge/policies.yml'), 'utf8')}\n`,
      });
      const unstaged = await runCli(repo, ['enforcement', 'pin', '--pin-file', envFile, '--confirm']);
      expect(unstaged.code).toBe(2);
      expect(unstaged.stderr).toContain('policy inputs differ between the staged index and the working tree');
      expect(unstaged.stderr).toContain('.gateforge/policies.yml');
      expect(unstaged.stderr).toContain('stage them (git add)');
      expect(existsSync(envFile)).toBe(false);

      // No target at all is a usage error, not a silent no-op.
      const missing = await runCli(repo, ['enforcement', 'pin', '--confirm']);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain('--pin-file <path> is required');
    });
  });

  it('writes 0600, replaces only the digest line, and writes the digest check --staged accepts', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('policy inputs');
      const envFile = join(outsideDir(), 'repo.gateforge.env');
      // An existing env file with other content and a stale pin, mode 0644.
      writeFileSync(
        envFile,
        `# owner pin\nGATEFORGE_WITNESS_VERIFIER_KEY=keep-me\nGATEFORGE_APPROVED_POLICY_DIGEST=${'0'.repeat(64)}\n`,
        { mode: 0o644 },
      );

      const pinned = await runCli(repo, ['enforcement', 'pin', '--pin-file', envFile, '--confirm']);
      expect(pinned.code, pinned.stderr).toBe(0);
      const body = readFileSync(envFile, 'utf8');
      const digest = body.match(/GATEFORGE_APPROVED_POLICY_DIGEST=([0-9a-f]{64})\n/)?.[1];
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      // Exactly the digest line changed; every other line survives verbatim.
      expect(body).toBe(`# owner pin\nGATEFORGE_WITNESS_VERIFIER_KEY=keep-me\nGATEFORGE_APPROVED_POLICY_DIGEST=${digest ?? ''}\n`);
      // The pin is never world-readable, not even when the file existed.
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      // No other line of the env file is ever printed.
      expect(pinned.stdout).not.toContain('GATEFORGE_WITNESS_VERIFIER_KEY');
      expect(pinned.stdout).toContain(`GATEFORGE_APPROVED_POLICY_DIGEST=${digest ?? ''}`);

      // THE equality that matters, asserted through the real gate: the
      // written digest passes the staged commit gate, a stale one is
      // blocked by it.
      const accepted = await runCli(repo, ['check', '--staged'], {
        GATEFORGE_APPROVED_POLICY_DIGEST: digest ?? '',
      });
      expect(accepted.stdout).not.toContain('cause: ENFORCEMENT_UNTRUSTED');
      const stale = await runCli(repo, ['check', '--staged'], {
        GATEFORGE_APPROVED_POLICY_DIGEST: '0'.repeat(64),
      });
      expect(stale.code).toBe(1);
      expect(stale.stdout).toContain('staged-candidate gate: BLOCKED');
      expect(stale.stdout).toContain('cause: ENFORCEMENT_UNTRUSTED');
      expect(stale.stdout).toContain('repin the revision');

      // Re-pinning replaces the line instead of appending a second one.
      const again = await runCli(repo, ['enforcement', 'pin', '--pin-file', envFile, '--confirm']);
      expect(again.code, again.stderr).toBe(0);
      const second = readFileSync(envFile, 'utf8');
      expect(second.split('\n').filter((line) => line.startsWith('GATEFORGE_APPROVED_POLICY_DIGEST='))).toHaveLength(1);
      expect(second).toBe(body);
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
    });
  });

  it('pins the digest of a policy edit that is staged but not yet committed', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('policy inputs');
      const previewBefore = await runCli(repo, ['enforcement', 'pin', '--pin-file', join(outsideDir(), 'a.env')]);
      const digestBefore = previewBefore.stdout.match(/staged policy digest: ([0-9a-f]{64})/)?.[1] ?? '';
      expect(digestBefore).toMatch(/^[0-9a-f]{64}$/);
      // The pin-LAST flow: edit a policy input, stage it, then pin.
      repo.writeFiles({
        '.gateforge/classification-policy.yml': `${readFileSync(repo.path('.gateforge/classification-policy.yml'), 'utf8')}\n`,
      });
      repo.stage();
      const envFile = join(outsideDir(), 'repo.gateforge.env');
      const pinned = await runCli(repo, ['enforcement', 'pin', '--pin-file', envFile, '--confirm']);
      expect(pinned.code, pinned.stderr).toBe(0);
      const pinnedLine = readFileSync(envFile, 'utf8').trim();
      expect(pinnedLine).toMatch(/^GATEFORGE_APPROVED_POLICY_DIGEST=[0-9a-f]{64}$/);
      // The staged edit moved the digest: the pin is a NEW revision, not the committed one.
      const pinnedHex = pinnedLine.slice('GATEFORGE_APPROVED_POLICY_DIGEST='.length);
      expect(pinnedHex).not.toBe(digestBefore);
      // And that pin is the one the gate over the same index accepts.
      const accepted = await runCli(repo, ['check', '--staged'], {
        GATEFORGE_APPROVED_POLICY_DIGEST: pinnedHex,
      });
      expect(accepted.stdout).not.toContain('cause: ENFORCEMENT_UNTRUSTED');
    });
  });
});