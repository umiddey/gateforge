/**
 * ONE INPUT IDENTITY (0.10.2 input-identity defect).
 *
 * `test-gates` seals a receipt over the WORKSPACE it ran in; `check
 * --staged` recomputes that identity over the MATERIALIZED INDEX. A
 * candidate whose tracked bytes are fully staged must land on the same
 * digest from both sides, or the first adoption commit can never pass the
 * generated hook — while a real difference (an unstaged edit to a tracked
 * or declared input) must still refuse.
 *
 * Two shapes are covered, and both were measured on the real consumer
 * copy:
 *
 *   1. a TRACKED path the repository's own `.gitignore` also matches
 *      (`.vscode/launch.json` under `.vscode/*` + `!.vscode/extensions.json`).
 *      Re-adding the materialized checkout with a plain `git add -A`
 *      re-applied those rules and dropped the file from the candidate's
 *      inventory, so the staged identity was missing a tracked byte the
 *      worktree identity kept;
 *   2. a declared dependency root (`prepare.reuse`). The staged checkout
 *      mounts it and binds its bytes in the gate context; a run made in
 *      the worktree used the very same directory and bound nothing, so the
 *      two identities differed by one field.
 *
 * Ignored run output (`blob-report/`, `playwright/.auth/`) is in both
 * fixtures deliberately: it must enter NEITHER identity.
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  CLASSIFICATION_POLICY_YML,
  PLUGIN_SOURCE,
  POLICIES_YML,
  configYml,
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
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { freezeStagedCandidate, materializeStagedCandidate } from '../src/staged-candidate.js';
import { digestRuntimeReuseMounts } from '../src/runtime-reuse.js';
import { loadRuntimeConfigAt, runtimeReuseDigest } from '../src/runtime.js';

/** The two resources whose specs this repository proves. */
const NAMES = ['accounts', 'orders'] as const;

/** The product source the staged candidate changes. */
const PRODUCT_SOURCE = 'src/accounts.txt';

/** The tracked path the ignore rules also match — the file that went missing. */
const TRACKED_BUT_IGNORED = '.vscode/launch.json';

/** The dependency root the staged checkout cannot contain. */
const REUSE_ROOT = 'node_modules';

/**
 * The owner's ignore rules: engine state, the dependency root, the run
 * output a suite writes into its own worktree, the storage state, and a
 * `.vscode` block that ignores everything except one file.
 */
const GITIGNORE = [
  '.gateforge/test-gates/',
  `${REUSE_ROOT}/`,
  'blob-report/',
  'playwright/.auth/',
  '.vscode/*',
  '!.vscode/extensions.json',
  '',
].join('\n');

/** The staged-runtime document: reuse the dependency root, nothing else. */
const RUNTIME_YML = ['schemaVersion: 1', 'prepare:', '  reuse:', `    - ${REUSE_ROOT}`, ''].join('\n');

/**
 * The fixture config: `mode: changed` so only the candidate's own slice is
 * judged, `strictE2E` so the owner pin is enforced (an enforced pin is
 * what approves the reuse roots the staged candidate asks for), and the
 * staged-runtime document this repository declares.
 */
function fixtureConfig(): string {
  return `mode: changed\nenforcement:\n  strictE2E: true\n${configYml()}runtime: .gateforge/runtime.yml\n`;
}

/** The environment a scoped run and the staged check share. */
function gateEnv(repo: TempRepo): Record<string, string> {
  return {
    GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
    GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml'))),
  };
}

/**
 * A gated repository whose worktree holds everything the staged checkout
 * cannot: the dependency root (ignored, declared as a reuse root), run
 * output (ignored, never an input) and one tracked file the ignore rules
 * also match.
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
    // The dependency root: ignored, never committed, mounted into the
    // staged checkout by the runtime document.
    [`${REUSE_ROOT}/playwright/cli.js`]: evidenceStubCli(NAMES),
    // Run output the suite writes into its own worktree.
    'blob-report/index.html': '<html>run output</html>\n',
    'playwright/.auth/user.json': '{"cookies":[]}\n',
    [TRACKED_BUT_IGNORED]: '{}\n',
    '.vscode/extensions.json': '{}\n',
  });
  // Tracked before the ignore rules could apply — the everyday way a
  // tracked file ends up matching an ignore pattern.
  repo.git(['add', '-f', TRACKED_BUT_IGNORED]);
  repo.stage();
  repo.commit('a gated repository with its dependency root and run output');
  // The candidate: one changed product source, staged, with the worktree
  // exactly as the commit leaves it.
  repo.writeFiles({ [PRODUCT_SOURCE]: 'accounts fixture.table\n# changed by the candidate\n' });
  repo.stage();
}

/** Seals the authoritative changed-slice receipt for the current worktree. */
async function sealScopedReceipt(repo: TempRepo, env: Record<string, string>): Promise<void> {
  const run = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
}

/** Runs the command the generated commit hook runs. */
function runStagedCheck(repo: TempRepo, env: Record<string, string>) {
  return runCli(repo, ['check', '--staged', '--require-e2e', '--format', 'json'], env);
}

describe('the materialized candidate keeps every tracked byte', () => {
  it('a tracked path its own .gitignore also matches stays in the candidate inventory', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        '.gitignore': GITIGNORE,
        '.vscode/extensions.json': '{}\n',
        [TRACKED_BUT_IGNORED]: '{}\n',
      });
      repo.git(['add', '-f', TRACKED_BUT_IGNORED]);
      repo.stage();

      const frozen = freezeStagedCandidate(repo.root, {});
      const checkout = materializeStagedCandidate(repo.root, {}, frozen);
      const tracked = spawnSync('git', ['ls-files', '--stage'], { cwd: checkout, encoding: 'utf8' }).stdout;

      expect(tracked, 'the staged candidate lost a tracked file its own ignore rules match').toContain(TRACKED_BUT_IGNORED);
      // The reuse root is IGNORED, so it must NOT join the candidate's
      // tracked set — the staged index is copied in, not widened.
      expect(tracked).not.toContain(`${REUSE_ROOT}/`);
    });
  });
});

describe('one reuse identity for the worktree and the mounted candidate', () => {
  it('the declared dependency root binds the same digest from both roots', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ '.gateforge/runtime.yml': RUNTIME_YML, [`${REUSE_ROOT}/playwright/cli.js`]: 'stub\n' });
      const runtime = loadRuntimeConfigAt(repo.root, '.gateforge/runtime.yml');
      if (runtime === null) throw new Error('the fixture runtime document did not load');
      // The staged candidate shape: a checkout whose reuse root is a
      // SYMLINK to the owner's dependency directory.
      const checkout = mkdtempSync(join(tmpdir(), 'gateforge-reuse-checkout-'));
      try {
        symlinkSync(repo.path(REUSE_ROOT), join(checkout, REUSE_ROOT));
        // The worktree reads the dependency in place; the staged checkout
        // mounts the SAME directory. Both identities are computed from the
        // owner's bytes through their own function, and they must be one
        // value.
        expect(runtimeReuseDigest(repo.root, runtime)).toBe(
          digestRuntimeReuseMounts([
            {
              path: REUSE_ROOT,
              checkoutRoot: checkout,
              ownerRoot: repo.root,
              sourceRoot: repo.path(REUSE_ROOT),
            },
          ]),
        );
      } finally {
        rmSync(checkout, { recursive: true, force: true });
      }
    });
  });

  it('a run in a worktree that declares a reuse root seals that root in its identity', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installGated(repo, app.url);
        const env = gateEnv(repo);
        await sealScopedReceipt(repo, env);

        const snapshot = JSON.parse(
          readFileSync(repo.path('.gateforge/test-gates/input-snapshot.json'), 'utf8'),
        ) as { gateContext: { runtimeReuseDigest?: string } };
        // The receipt names the bytes it executed against: the same
        // digest the staged candidate will mount.
        expect(
          snapshot.gateContext.runtimeReuseDigest,
          'the sealed worktree identity does not bind the declared reuse root',
        ).toBe(
          runtimeReuseDigest(
            repo.root,
            loadRuntimeConfigAt(repo.root, '.gateforge/runtime.yml') ?? { schemaVersion: 1, prepare: { reuse: [REUSE_ROOT] } },
          ),
        );
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('a fully staged candidate seals and checks as ONE identity', () => {
  it('accepts the worktree receipt: no ignored run output, a tracked-but-ignored file, a mounted reuse root', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installGated(repo, app.url);
        const env = gateEnv(repo);
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;

        expect(output).not.toContain('inputDigest does not match the current input snapshot');
        expect(output).toContain('receipt-verified');
        expect(run.code, output).toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('still refuses when a tracked input changed in the worktree and was never staged', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installGated(repo, app.url);
        // An unstaged edit to a TRACKED file: the run executes these
        // bytes, the index still carries the previous ones. The receipt
        // therefore proves a candidate that is NOT the one being
        // committed, and the identity must keep mismatching.
        repo.writeFiles({ [PRODUCT_SOURCE]: 'accounts fixture.table\n# edited, never staged\n' });
        const env = gateEnv(repo);
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;

        expect(output).toContain('inputDigest does not match the current input snapshot');
        expect(run.code, output).not.toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});