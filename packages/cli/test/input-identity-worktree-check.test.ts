/**
 * ONE INPUT IDENTITY, worktree run ↔ worktree check (0.10.2 defect).
 *
 * `test-gates` seals a receipt over the WORKTREE and binds the declared
 * `prepare.reuse` roots in its gate context. A standalone
 * `gateforge check --require-e2e` on that same unchanged worktree handed
 * `computeInputSnapshot` no reuse digest at all, so it recomputed an
 * identity WITHOUT the field the run had sealed — and the pair every
 * consumer is told to run (`gateforge run` then `gateforge check`) failed
 * closed with `evidence-context: durable attestation inputDigest does not
 * match the current input snapshot` on a worktree nobody touched.
 *
 * The rule is resolved in ONE place now, and `computeInputSnapshot`
 * applies it itself, so a caller that hands it no digest cannot forget the
 * declared roots. What must keep working is the fail-closed half: one
 * changed byte inside a declared reuse root still moves the identity.
 */
import { stubPlaywrightFiles } from './helpers.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  CLASSIFICATION_POLICY_YML,
  PLUGIN_SOURCE,
  POLICIES_YML,
  configYml,
  currentInputDigest,
  runCli,
} from './helpers.js';
import {
  VERIFIER_KEY,
  evidenceAdapter,
  evidenceSpecs,
  evidenceStubCli,
  evidenceTestMap,
  startEvidenceApp,
} from './reseal-e2e-fixture.js';
import type { InputSnapshot } from '../src/input-snapshot.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';

/** The two resources whose specs this repository proves. */
const NAMES = ['accounts', 'orders'] as const;

/** The dependency root the run executes against and must bind. */
const REUSE_ROOT = 'node_modules';

/** The staged-runtime document: reuse the dependency root, nothing else. */

/** The product source the candidate slice changes. */
const PRODUCT_SOURCE = 'src/accounts.txt';
const RUNTIME_YML = ['schemaVersion: 1', 'prepare:', '  reuse:', `    - ${REUSE_ROOT}`, ''].join('\n');

/** The owner's ignore rules: engine state, the dependency root, run output. */
const GITIGNORE = ['.gateforge/test-gates/', `${REUSE_ROOT}/`, 'blob-report/', ''].join('\n');

/**
 * The fixture config: `mode: changed` so only the candidate's own slice is
 * judged, `strictE2E` so the owner pin is enforced (an enforced pin is
 * what approves the declared reuse roots), and the staged-runtime document
 * this repository declares.
 */
function fixtureConfig(): string {
  return `mode: changed\nenforcement:\n  strictE2E: true\n${configYml()}runtime: .gateforge/runtime.yml\n`;
}

/** The environment the worktree run and the worktree check share. */
function gateEnv(repo: TempRepo): Record<string, string> {
  return {
    GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
    GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml'))),
  };
}

/**
 * A gated repository whose worktree declares a reuse root it executes
 * against: the dependency directory is ignored, never committed, and its
 * bytes are the ones the run binds.
 */
function installGated(repo: TempRepo, appUrl: string): void {
  repo.writeFiles({
    '.gitignore': GITIGNORE,
    '.gateforge.yml': fixtureConfig(),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/runtime.yml': RUNTIME_YML,
    'plugin.mjs': PLUGIN_SOURCE,
    'package.json': `${JSON.stringify({ name: 'fixture', private: true, devDependencies: { '@playwright/test': '1.0.0' } }, null, 2)}\n`,
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    ...evidenceSpecs(NAMES, true),
    '.gateforge/test-map.yml': evidenceTestMap(NAMES),
    ...Object.fromEntries(NAMES.map((name) => [`src/${name}.txt`, `${name} fixture.table\n`])),
    ...Object.fromEntries(NAMES.map((name) => [`.gateforge/adapters/${name}.mjs`, evidenceAdapter(appUrl)])),
    // The declared dependency root: ignored, never committed, executed in
    // place — so its bytes belong in the run's input identity.
    ...stubPlaywrightFiles(evidenceStubCli(NAMES), REUSE_ROOT),
  });
  repo.stage();
  repo.commit('a gated repository that declares a dependency root');
  // The slice the scoped run seals over: one changed product source, with
  // the worktree exactly as the commit would leave it.
  repo.writeFiles({ [PRODUCT_SOURCE]: 'accounts fixture.table\n# changed by the candidate\n' });
  repo.stage();
}

/**
 * Seals the authoritative receipt for the current worktree — full scope,
 * exactly what the R1 acceptance sequence seals before its `check`.
 */
async function sealReceipt(repo: TempRepo, env: Record<string, string>): Promise<void> {
  const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
}

/** The standalone worktree check — NOT `--staged`, no digest handed to it. */
function runWorktreeCheck(repo: TempRepo, env: Record<string, string>) {
  return runCli(repo, ['check', '--require-e2e', '--format', 'json'], env);
}

/** The identity the worktree run sealed, as written beside its receipt. */
function sealedSnapshot(repo: TempRepo): InputSnapshot {
  return JSON.parse(readFileSync(repo.path('.gateforge/test-gates/input-snapshot.json'), 'utf8')) as InputSnapshot;
}

describe('one input identity for the worktree run and the worktree check', () => {
  it('a standalone check on an unchanged worktree accepts the receipt the run sealed', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installGated(repo, app.url);
        const env = gateEnv(repo);
        await sealReceipt(repo, env);

        const sealed = sealedSnapshot(repo);
        expect(
          sealed.gateContext.runtimeReuseDigest,
          'the sealed worktree identity does not bind the declared reuse root',
        ).toBeTypeOf('string');

        const run = await runWorktreeCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;

        expect(output).not.toContain('inputDigest does not match the current input snapshot');
        expect(run.code, output).toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('an identity computed without an explicit digest IS the sealed one', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installGated(repo, app.url);
        const env = gateEnv(repo);
        await sealReceipt(repo, env);

        const sealed = sealedSnapshot(repo);
        // The computation `check`, `next` and `tests` perform: a
        // `computeInputSnapshot` call with NO reuse digest of its own. It
        // has to land on the digest the run sealed.
        expect(await currentInputDigest(repo)).toBe(sealed.evidenceInputDigest);
        expect(sealed.gateContext.runtimeReuseDigest).toBeTypeOf('string');
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('one changed byte inside a declared reuse root still refuses', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installGated(repo, app.url);
        const env = gateEnv(repo);
        await sealReceipt(repo, env);

        // The dependency bytes the run executed against changed AFTER it
        // sealed: the receipt then proves a run against bytes that no
        // longer exist, so the identity must move.
        repo.writeFiles({ [`${REUSE_ROOT}/playwright/dependency.txt`]: 'a different dependency byte\n' });

        const run = await runWorktreeCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;

        expect(output).toContain('inputDigest does not match the current input snapshot');
        expect(run.code, output).not.toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});