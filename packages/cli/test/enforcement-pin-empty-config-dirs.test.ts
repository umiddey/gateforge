/**
 * `gateforge enforcement pin`, `gateforge check --staged` and
 * `gateforge enforcement doctor` must agree on ONE policy digest for the
 * same repository — including the repository `gateforge init` leaves
 * behind: EMPTY, UNTRACKED `.gateforge/adapters/` and
 * `.gateforge/waivers/`.
 *
 * Git cannot carry an empty directory, so `checkout-index` never creates
 * one in the isolated candidate checkout. The trusted-digest entry list
 * still distinguishes an EMPTY optional config directory
 * (`<dir>/(no .mjs adapters)`) from a MISSING one
 * (`<dir>/(missing adapters dir)`), so every surface that digests the
 * staged checkout has to mirror the worktree's directory presence or the
 * three surfaces compute three different digests: pin writes one, doctor
 * compares the pin against the same wrong value and calls it
 * `matches staged`, and `check --staged` — which DOES mirror — blocks
 * `ENFORCEMENT_UNTRUSTED` on a freshly written pin, forever.
 *
 * The assertions go through the real surfaces (pin, the staged gate, the
 * doctor JSON), never through the digest function itself: the property
 * under test is that the OWNER's three commands agree.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  CLASSIFICATION_POLICY_YML,
  configYml,
  PLUGIN_SOURCE,
  POLICIES_YML,
  RESOURCE_FILES,
  runCli,
} from './helpers.js';

/** Temp roots OUTSIDE every fixture repository (the pin may never live in one). */
const outsideRoots: string[] = [];

/** A fresh directory outside any candidate, removed after the suite. */
function outsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-pin-empty-'));
  outsideRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (outsideRoots.length > 0) {
    rmSync(outsideRoots.pop() as string, { recursive: true, force: true });
  }
});

/**
 * The standard fixture WITHOUT any adapter module, plus the two EMPTY
 * optional config directories `gateforge init` creates. Git carries
 * neither an empty directory nor a directory entry at all, so they stay
 * untracked in the worktree and are absent from the staged tree — the
 * state in which the three surfaces disagreed.
 */
function installWithEmptyOptionalDirs(repo: TempRepo): void {
  repo.writeFiles({
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge.yml': configYml(),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    'plugin.mjs': PLUGIN_SOURCE,
    ...RESOURCE_FILES,
  });
  for (const dir of ['.gateforge/adapters', '.gateforge/waivers']) {
    mkdirSync(repo.path(dir), { recursive: true });
  }
}

/** The same fixture with NEITHER optional config directory present. */
function installWithoutOptionalDirs(repo: TempRepo): void {
  repo.writeFiles({
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge.yml': configYml(),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    'plugin.mjs': PLUGIN_SOURCE,
    ...RESOURCE_FILES,
  });
}

/** The `GATEFORGE_APPROVED_POLICY_DIGEST=<hex>` value printed by the pin. */
function previewedDigest(stdout: string): string {
  const digest = stdout.match(/GATEFORGE_APPROVED_POLICY_DIGEST=([0-9a-f]{64})/)?.[1] ?? '';
  expect(digest, `a digest line was printed:\n${stdout}`).toMatch(/^[0-9a-f]{64}$/);
  return digest;
}

/** One row of the doctor's deterministic JSON report. */
function doctorRow(stdout: string, id: string): { status: string; detail: string } {
  const report = JSON.parse(stdout) as { checks: Array<{ id: string; status: string; detail: string }> };
  const found = report.checks.find((entry) => entry.id === id);
  expect(found, `doctor row '${id}' present`).toBeTruthy();
  return found as { status: string; detail: string };
}

/**
 * The property: pin's digest, the staged gate's candidate digest, and the
 * doctor's verdict are ONE digest. A stale digest still blocks (the gate
 * did not stop comparing anything), and the pin is stable across runs
 * (re-pinning used to loop forever on a mismatch it could never resolve).
 */
async function assertOneDigest(repo: TempRepo): Promise<void> {
  const envFile = join(outsideDir(), 'repo.gateforge.env');

  // 1. The previewed digest is a digest, and it is the candidate digest
  //    `check --staged` computes: the gate ACCEPTS it and still rejects a
  //    stale one (so the equality is not "the gate stopped comparing").
  const preview = await runCli(repo, ['enforcement', 'pin', '--pin-file', envFile]);
  expect(preview.code, preview.stderr).toBe(0);
  const digest = previewedDigest(preview.stdout);
  const accepted = await runCli(repo, ['check', '--staged'], {
    GATEFORGE_APPROVED_POLICY_DIGEST: digest,
  });
  expect(accepted.stdout, `check --staged must accept the pinned digest:\n${accepted.stdout}`).not.toContain(
    'cause: ENFORCEMENT_UNTRUSTED',
  );
  const stale = await runCli(repo, ['check', '--staged'], {
    GATEFORGE_APPROVED_POLICY_DIGEST: '0'.repeat(64),
  });
  expect(stale.code).toBe(1);
  expect(stale.stdout).toContain('cause: ENFORCEMENT_UNTRUSTED');

  // 2. `pin --confirm` writes the digest the staged gate accepts over the
  //    SAME index — no re-pin loop.
  const pinned = await runCli(repo, ['enforcement', 'pin', '--pin-file', envFile, '--confirm']);
  expect(pinned.code, pinned.stderr).toBe(0);
  const written = readFileSync(envFile, 'utf8').match(/GATEFORGE_APPROVED_POLICY_DIGEST=([0-9a-f]{64})/)?.[1] ?? '';
  expect(written).toBe(digest);
  const afterPin = await runCli(repo, ['check', '--staged'], {
    GATEFORGE_APPROVED_POLICY_DIGEST: written,
  });
  expect(afterPin.stdout, `check --staged must accept the WRITTEN digest:\n${afterPin.stdout}`).not.toContain(
    'cause: ENFORCEMENT_UNTRUSTED',
  );

  // 3. The doctor compares the pin against the staged digest and agrees,
  //    naming the very same value — and the gate agrees with the doctor.
  const doctor = await runCli(repo, ['enforcement', 'doctor', '--json'], {
    GATEFORGE_APPROVED_POLICY_DIGEST: written,
  });
  expect(doctor.code, doctor.stderr).toBe(0);
  const row = doctorRow(doctor.stdout, 'approved-digest');
  expect(row.status, `approved-digest row: ${row.detail}`).toBe('ok');
  expect(row.detail).toContain(`matches staged (${written})`);

  // 4. Re-pinning is a no-op on the digest: an owner who re-pins after a
  //    block ends up with the same revision instead of chasing a moving
  //    digest forever.
  const again = await runCli(repo, ['enforcement', 'pin', '--pin-file', envFile, '--confirm']);
  expect(again.code, again.stderr).toBe(0);
  expect(previewedDigest(again.stdout)).toBe(digest);
}

describe('staged policy digest: pin, check --staged and doctor agree', () => {
  it('agree when the optional config directories are EMPTY and untracked', async () => {
    await withTempRepo({}, async (repo) => {
      installWithEmptyOptionalDirs(repo);
      repo.stage();
      repo.commit('policy inputs');
      await assertOneDigest(repo);
    });
  }, 180_000);

  it('agree when the optional config directories are ABSENT', async () => {
    await withTempRepo({}, async (repo) => {
      installWithoutOptionalDirs(repo);
      repo.stage();
      repo.commit('policy inputs');
      await assertOneDigest(repo);
    });
  }, 180_000);
});