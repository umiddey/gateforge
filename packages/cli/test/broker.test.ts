/**
 * Managed-mode commit broker (plan 2026-09-13 Phase 5 item 6, ADR 0005
 * D1): `gateforge broker commit` verifies an immutable workspace tree
 * against a REAL authenticated gate receipt and creates the commit with
 * compare-and-swap ref protection. Every rejection is typed and leaves
 * the authoritative ref untouched. Real git; receipts minted with the
 * trusted issuance machinery (see gate-receipts.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';
import { BrokerRejection } from '../src/broker.js';

/** The broker's receipt-signing verifier key for this suite. */
const VERIFIER_KEY = 'broker-suite-verifier-key';

/** Workspace: a real fixture repository, fully committed. */
async function inFixtureWorkspace(body: (workspace: TempRepo) => void | Promise<void>): Promise<void> {
  await withTempRepo({ prefix: 'gateforge-broker-ws-' }, async (workspace) => {
    installFixture(workspace);
    workspace.stage();
    workspace.commit('workspace base');
    await body(workspace);
  });
}

/** Authority: a real repository whose refs the broker updates. */
async function inAuthorityRepo(body: (authority: TempRepo) => void | Promise<void>): Promise<void> {
  await withTempRepo({ prefix: 'gateforge-broker-auth-' }, async (authority) => {
    authority.commitFiles({ 'README.md': '# authority\n' }, 'authority base');
    authority.commitFiles({ 'CHANGELOG.md': '# log\n' }, 'authority head');
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

describe('broker commit (the happy path authorizes exactly the verified bytes)', () => {
  it('valid receipt + matching parent → commit created on the authoritative ref', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        const headBefore = authority.headSha();
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'managed commit',
          receipt: minted.receiptPath,
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('broker: committed');
        expect(result.stdout).toContain(`receipt ${minted.receiptId}`);

        // The authoritative ref moved by exactly one CAS-checked commit…
        const head = authority.git(['rev-parse', 'HEAD']).stdout.trim();
        expect(head).not.toBe(headBefore);
        expect(authority.git(['rev-parse', 'HEAD^']).stdout.trim()).toBe(headBefore);
        expect(authority.git(['log', '-1', '--format=%s']).stdout.trim()).toBe('managed commit');
        // …carrying the workspace bytes.
        expect(authority.git(['show', 'HEAD:src/accounts.txt']).stdout).toBe('accounts fixture.table\n');
      });
    });
  });
});

describe('broker commit (typed rejections never touch the authoritative ref)', () => {
  it('missing receipt → RUN_INCOMPLETE rejection, no commit', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const headBefore = authority.headSha();
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'unverified',
          receipt: join(workspace.root, '.gateforge', 'test-gates', 'absent.json'),
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('no gate receipt');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('receipt for DIFFERENT bytes (stale) → EVIDENCE_STALE rejection, no commit', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        // The candidate moves after the gate sealed: different bytes.
        workspace.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\n# tampered\n' });
        const headBefore = authority.headSha();
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'stale bytes',
          receipt: minted.receiptPath,
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('candidate tree id does not match');
        expect(result.stderr).toContain('rerun the gate for the exact candidate');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('receipt sealed against a different parent → compare-and-swap rejection, no commit', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        // Receipt bound to the authority's FIRST commit; the ref is past it.
        const commits = authority.git(['rev-list', 'HEAD']).stdout.trim().split('\n');
        const olderParent = commits[commits.length - 1] ?? '';
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: olderParent,
        });
        const headBefore = authority.headSha();
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'stale base',
          receipt: minted.receiptPath,
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('compare-and-swap');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('forged/tampered receipt → ENFORCEMENT_UNTRUSTED rejection, no commit', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        // Flip a MAC-covered field: the signature then fails.
        const forged = JSON.parse(readFileSync(minted.receiptPath, 'utf8')) as Record<string, unknown>;
        forged['receiptId'] = '00000000-0000-4000-8000-000000000000';
        const forgedPath = join(workspace.root, '.gateforge', 'test-gates', 'forged.json');
        workspace.writeFiles({ '.gateforge/test-gates/forged.json': `${JSON.stringify(forged)}\n` });
        const headBefore = authority.headSha();
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'forged',
          receipt: forgedPath,
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('forged or tampered');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('no verifier key in the broker environment → ENFORCEMENT_UNTRUSTED, no commit', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        const headBefore = authority.headSha();
        const result = await brokerCommit(
          authority,
          { workspace: workspace.root, message: 'no key', receipt: minted.receiptPath },
          { GATEFORGE_WITNESS_VERIFIER_KEY: undefined },
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('verifier key');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('a NUL byte in the message → BROKER_UNSAFE_MESSAGE before any git call', async () => {
    await inAuthorityRepo(async (authority) => {
      await inFixtureWorkspace(async (workspace) => {
        const headBefore = authority.headSha();
        const result = await brokerCommit(authority, {
          workspace: workspace.root,
          message: 'evil\u0000message',
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('NUL');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('the rejection type is a typed UsageError subclass carrying a cause code', () => {
    const rejection = new BrokerRejection('BROKER_CAS_MISMATCH', 'detail');
    expect(rejection.causeCode).toBe('BROKER_CAS_MISMATCH');
    expect(rejection.name).toBe('BrokerRejection');
  });
});
