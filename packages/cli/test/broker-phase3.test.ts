/**
 * Phase 3 authority probes (plan 2026-09-19 §4.10, Phase 3 verification):
 * candidate code can never execute in the broker; candidate Git
 * machinery (filters/hooks) never runs during ingestion; v1 receipts are
 * rejected with a fresh-run instruction; every tampered v2 binding is
 * rejected; a protected authority refuses locally sealed receipts.
 * Real git; receipts minted with the trusted issuance machinery.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';
import { resolveStateDir } from '../src/state.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';

/** The broker's receipt-signing verifier key for this suite. */
const VERIFIER_KEY = 'broker-phase3-verifier-key';

/** Workspace: a real fixture repository, fully committed. */
async function inFixtureWorkspace(body: (workspace: TempRepo) => void | Promise<void>): Promise<void> {
  await withTempRepo({ prefix: 'gateforge-broker3-ws-' }, async (workspace) => {
    installFixture(workspace);
    workspace.stage();
    workspace.commit('workspace base');
    await body(workspace);
  });
}

/** Authority: a real repository whose refs the broker updates. */
async function inAuthorityRepo(body: (authority: TempRepo) => void | Promise<void>): Promise<void> {
  await withTempRepo({ prefix: 'gateforge-broker3-auth-' }, async (authority) => {
    authority.commitFiles({ 'README.md': '# authority\n' }, 'authority base');
    await body(authority);
  });
}

/** Runs `broker commit` in-process against the authority repo. */
async function brokerCommit(
  authority: TempRepo,
  args: Record<string, string | undefined>,
  env: Record<string, string | undefined> = { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = ['broker', 'commit'];
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    argv.push(`--${name}`, value);
  }
  return runCli(authority, argv, env);
}

describe('broker authority isolation (no candidate code execution)', () => {
  it('a hostile in-process plugin side effect never fires in the broker', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const marker = join(resolveStateDir(workspace.root), 'broker-pwned.txt');
        mkdirSync(resolveStateDir(workspace.root), { recursive: true });
        // Hostile top-level side effect in the candidate-selected plugin.
        // Still a valid plugin (discover preserved) so the gate path stays green.
        const hostile = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'pwned\\n');\n`;
        const original = readFileSync(join(workspace.root, 'plugin.mjs'), 'utf8');
        workspace.writeFiles({ 'plugin.mjs': `${hostile}${original}` });
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        // Positive control: the controller-side pipeline DID import the
        // candidate plugin (the probe is live — it would catch execution).
        expect(existsSync(marker)).toBe(true);
        // Clear its marker so the broker assertion below isolates the
        // AUTHORITY process only.
        rmSync(marker, { force: true });
        const headBefore = authority.headSha();
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'hostile plugin commit',
          receipt: minted.receiptPath,
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('broker: committed');
        // The broker never imported the candidate plugin.
        expect(existsSync(marker)).toBe(false);
        expect(authority.headSha()).not.toBe(headBefore);
      });
    });
  });

  it('a candidate clean filter never runs during broker ingestion', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const marker = join(workspace.root, 'filter-pwned.txt');
        workspace.writeFiles({ '.gitattributes': '*.txt filter=pwn\n' });
        workspace.git(['config', 'filter.pwn.clean', `touch ${JSON.stringify(marker)} && cat`]);
        workspace.git(['config', 'filter.pwn.smudge', 'cat']);
        workspace.writeFiles({ 'src/trigger.txt': 'clean me\n' });
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'filter commit',
          receipt: minted.receiptPath,
        });
        expect(result.code).toBe(0);
        // No `git add` ran in the authority process: the filter never fired.
        expect(existsSync(marker)).toBe(false);
        // Positive control: a real `git add` fires the candidate filter.
        workspace.git(['add', '-A']);
        expect(existsSync(marker)).toBe(true);
      });
    });
  });
});

describe('broker receipt v2 enforcement', () => {
  it('a v1 receipt is rejected with a fresh-run instruction, never re-signed', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        const v1 = JSON.parse(readFileSync(minted.receiptPath, 'utf8')) as Record<string, unknown>;
        v1['receiptVersion'] = 1;
        const v1Path = join(workspace.root, '.gateforge', 'test-gates', 'v1.json');
        workspace.writeFiles({ '.gateforge/test-gates/v1.json': `${JSON.stringify(v1)}\n` });
        const headBefore = authority.headSha();
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'v1 receipt',
          receipt: v1Path,
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('no longer accepted');
        expect(result.stderr).toContain('fresh');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('a tampered candidateTreeId binding is mac-fail, no commit', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        const tampered = JSON.parse(readFileSync(minted.receiptPath, 'utf8')) as Record<string, unknown>;
        tampered['candidateTreeId'] = 'a'.repeat(40);
        const tamperedPath = join(workspace.root, '.gateforge', 'test-gates', 'tampered-tree.json');
        workspace.writeFiles({ '.gateforge/test-gates/tampered-tree.json': `${JSON.stringify(tampered)}\n` });
        const headBefore = authority.headSha();
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'tampered tree',
          receipt: tamperedPath,
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('forged or tampered');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('a protected authority refuses a locally sealed receipt (boundary mismatch)', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        const headBefore = authority.headSha();
        const result = await brokerCommit(
          authority,
          { workspace: workspace.root, message: 'protected', receipt: minted.receiptPath },
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
            GATEFORGE_AUTHORITY_BOUNDARY: 'managed-authoritative',
          },
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('managed-authoritative');
        expect(result.stderr).toContain('cannot authorize');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('a managed receipt matches the normalized protected authority profile', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
          executionBoundaryProfile: 'podman-rootless',
        });
        const result = await brokerCommit(
          authority,
          { workspace: workspace.root, message: 'managed', receipt: minted.receiptPath },
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
            GATEFORGE_AUTHORITY_BOUNDARY: 'managed-authoritative',
          },
        );
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('managed-authoritative');
        expect(result.stdout).toContain('podman-rootless');
      });
    });
  });
});
