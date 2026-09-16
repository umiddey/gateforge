/**
 * Approved-policy-revision authority tests (review 2026-09-13 P1 #5:
 * "candidate policy is treated as trusted"). Pins the new ownership
 * contract end to end:
 *
 * - the pure integration point (`assertApprovedPolicy`) blocks a
 *   weakened candidate with ENFORCEMENT_UNTRUSTED and the precise
 *   owner next action, blocks a missing pin in strict mode with the
 *   provisioning step, and stays opt-in without strictness;
 * - resolution honors only trusted channels (flag, protected env,
 *   trusted config OUTSIDE the candidate) and fails closed on
 *   candidate-declared, malformed, or conflicting pins;
 * - `check --require-e2e` compares the candidate's recomputed policy
 *   digest against the pin, demands the binding on receipts under a
 *   pin, and rejects receipts sealed under a since-revoked revision;
 * - `broker commit` with a mismatched approved digest creates NO commit;
 * - non-strict behavior is unchanged (old receipts without the field
 *   stay verifiable when no pin is provisioned).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo, type GateforgeConfig, type TempRepo } from '@gate-forge/core';
import { installFixture, PLUGIN_SOURCE, runCli, FIXED_AT } from './helpers.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import {
  APPROVED_POLICY_DIGEST_ENV,
  assertApprovedPolicy,
  assertReceiptApprovedPolicy,
  evaluateApprovedPolicy,
  PROVISION_PIN_NEXT_ACTION,
  resolveApprovedPolicyDigest,
  TRUSTED_CONFIG_ENV,
  WEAKENED_POLICY_NEXT_ACTION,
} from '../src/trusted-policy.js';

const VERIFIER_KEY = 'trusted-policy-suite-verifier-key';

/** Candidate-sourced pins are never trusted; tests clear both channels. */
const NO_PIN: Record<string, string | undefined> = {
  [APPROVED_POLICY_DIGEST_ENV]: undefined,
  [TRUSTED_CONFIG_ENV]: undefined,
};

/**
 * Minimal fixture repository (zero obligations — the gate decision is
 * driven entirely by the approved-policy/receipt gates), with an
 * optional extra top-level config section (e.g. `enforcement:`).
 */
function installPinFixture(repo: TempRepo, extraConfigSection = ''): void {
  repo.writeFiles({
    '.gateforge.yml': [
      'schemaVersion: 1',
      'project:',
      '  languages: [python]',
      '  paths:',
      "    include: ['src/**/*.txt']",
      '    exclude: []',
      'plugins:',
      '  - id: fixture.plugin',
      "    version: '1.0.0'",
      '    transport: in-process',
      '    module: ./plugin.mjs',
      'policies: .gateforge/policies.yml',
      'classificationPolicy: .gateforge/classification-policy.yml',
      'adapters: .gateforge/adapters',
      'waivers: .gateforge/waivers',
      'baselines: .gateforge/baselines/obligations.json',
      'changed:',
      '  provider: auto',
      'witness:',
      '  maxDurationSeconds: 5',
      'clock:',
      '  mode: fixed',
      `  fixedAt: '${FIXED_AT}'`,
      ...(extraConfigSection.length > 0 ? ['', extraConfigSection] : []),
      '',
    ].join('\n'),
    '.gateforge/policies.yml':
      'schemaVersion: 1\npolicies:\n  - id: user-facing-crud\n    when:\n      exposure: user-facing\n    require:\n      - persistence:read\n',
    '.gateforge/classification-policy.yml':
      "schemaVersion: 1\nscanRoots: ['src/**/*.txt']\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations:\n  internality: gateforge:internal\nvolatileFields: []\n",
    'plugin.mjs': PLUGIN_SOURCE,
  });
}

/** Recomputes the candidate's trusted policy digest (the real gate input). */
function candidatePolicyDigest(repo: TempRepo): string {
  const config = loadConfig(join(repo.root, '.gateforge.yml'));
  return trustedPolicyDigestForConfig(repo.root, config);
}

/** The candidate WEAKENS its own policy (a byte flip the owner never approved). */
function weakenCandidatePolicy(repo: TempRepo): void {
  const path = join(repo.root, '.gateforge/classification-policy.yml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}# weakened by the candidate\n`, 'utf8');
}

interface CheckReport {
  summary: { blocking: number };
  blocking: Array<{ kind: string; cause?: string; detail?: string; nextAction?: string }>;
}

/** Runs `check --require-e2e --format json` and parses the report. */
async function runRequireE2E(
  repo: TempRepo,
  env: Record<string, string | undefined> = NO_PIN,
  extraArgs: readonly string[] = [],
): Promise<{ code: number; report: CheckReport; stdout: string; stderr: string }> {
  const result = await runCli(repo, ['check', '--require-e2e', '--format', 'json', ...extraArgs], env);
  let report: CheckReport = { summary: { blocking: -1 }, blocking: [] };
  try {
    report = JSON.parse(result.stdout) as CheckReport;
  } catch {
    // Non-JSON output (usage error): keep the raw text for assertions.
  }
  return { code: result.code, report, stdout: result.stdout, stderr: result.stderr };
}

/** A strict (strictE2E) fixture repo handed to the callback. */
async function inStrictRepo(body: (repo: TempRepo) => void | Promise<void>): Promise<void> {
  await withTempRepo({}, async (repo) => {
    installPinFixture(repo, 'enforcement:\n  mode: standard\n  strictE2E: true\n');
    await body(repo);
  });
}

describe('assertApprovedPolicy (the single-call integration point)', () => {
  const candidate = 'a'.repeat(64);

  it('a candidate byte-identical to the approved revision is enforced', () => {
    const result = assertApprovedPolicy(candidate, { approved: candidate, strict: true });
    expect(result).toEqual({ ok: true, enforced: true, approved: candidate });
  });

  it('a weakened candidate is blocked with ENFORCEMENT_UNTRUSTED and the precise owner next action', () => {
    const weakened = 'b'.repeat(64);
    const result = assertApprovedPolicy(weakened, { approved: candidate, strict: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe('ENFORCEMENT_UNTRUSTED');
      expect(result.detail).toContain('does not match the owner-approved revision');
      expect(result.nextAction).toBe(WEAKENED_POLICY_NEXT_ACTION);
      expect(result.nextAction).toContain('classifiers/exclusions/waivers/baselines/coverage');
      expect(result.nextAction).toContain('approve and repin the revision, then rerun');
    }
  });

  it('a missing pin in strict mode fails closed naming exactly what the owner must provision', () => {
    const result = assertApprovedPolicy(candidate, { approved: null, strict: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe('ENFORCEMENT_UNTRUSTED');
      expect(result.detail).toContain('no owner-approved policy digest is provisioned');
      expect(result.nextAction).toBe(PROVISION_PIN_NEXT_ACTION);
      expect(result.nextAction).toContain(APPROVED_POLICY_DIGEST_ENV);
      expect(result.nextAction).toContain('--approved-policy-digest');
      expect(result.nextAction).toContain(TRUSTED_CONFIG_ENV);
    }
  });

  it('a missing pin without strictness stays unenforced (opt-in preserved)', () => {
    expect(assertApprovedPolicy(candidate, { approved: null, strict: false })).toEqual({
      ok: true,
      enforced: false,
    });
  });

  it('a malformed approved digest can never verify (fail closed)', () => {
    const result = assertApprovedPolicy(candidate, { approved: 'not-a-digest', strict: true });
    expect(result.ok).toBe(false);
  });
});

describe('resolveApprovedPolicyDigest (trusted channels only)', () => {
  const DIGEST_A = '1'.repeat(64);
  const DIGEST_B = '2'.repeat(64);

  it('resolves the protected env variable', () => {
    const resolution = resolveApprovedPolicyDigest({
      env: { [APPROVED_POLICY_DIGEST_ENV]: DIGEST_A },
      candidateCwd: '/somewhere/else',
    });
    expect(resolution).toEqual({ status: 'ok', digest: DIGEST_A, origins: ['env'] });
  });

  it('resolves the explicit operator flag', () => {
    const resolution = resolveApprovedPolicyDigest({ flag: DIGEST_A, env: {}, candidateCwd: '/somewhere/else' });
    expect(resolution).toEqual({ status: 'ok', digest: DIGEST_A, origins: ['flag'] });
  });

  it('nothing provisioned resolves to a typed absence (never a guess)', () => {
    expect(resolveApprovedPolicyDigest({ env: {}, candidateCwd: '/somewhere/else' })).toEqual({
      status: 'ok',
      digest: null,
      origins: [],
    });
  });

  it('conflicting channels fail closed (two "approved" revisions = none)', () => {
    const resolution = resolveApprovedPolicyDigest({
      flag: DIGEST_A,
      env: { [APPROVED_POLICY_DIGEST_ENV]: DIGEST_B },
      candidateCwd: '/somewhere/else',
    });
    expect(resolution.status).toBe('invalid');
    if (resolution.status === 'invalid') expect(resolution.detail).toContain('conflicting approved policy digests');
  });

  it('a malformed env digest fails closed', () => {
    const resolution = resolveApprovedPolicyDigest({
      env: { [APPROVED_POLICY_DIGEST_ENV]: 'deadbeef' },
      candidateCwd: '/somewhere/else',
    });
    expect(resolution.status).toBe('invalid');
  });

  it('a candidate config declaring the pin is candidate-controlled, never a source', () => {
    const resolution = resolveApprovedPolicyDigest({
      env: {},
      candidateCwd: '/somewhere/else',
      candidateConfig: {
        enforcement: { mode: 'standard', strictE2E: true, approvedPolicyDigest: DIGEST_A },
      } as unknown as GateforgeConfig,
    });
    expect(resolution.status).toBe('candidate-controlled');
    if (resolution.status === 'candidate-controlled') {
      expect(resolution.detail).toContain('candidate-controlled files cannot approve policy');
    }
  });

  it('a trusted config OUTSIDE the candidate is honored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-pin-config-'));
    try {
      const configPath = join(dir, 'trusted-gateforge.yml');
      writeFileSync(
        configPath,
        minimalTrustedConfig(DIGEST_A),
        'utf8',
      );
      const resolution = resolveApprovedPolicyDigest({
        env: { [TRUSTED_CONFIG_ENV]: configPath },
        candidateCwd: join(tmpdir(), 'gateforge-candidate-not-this-dir'),
      });
      expect(resolution).toEqual({ status: 'ok', digest: DIGEST_A, origins: ['trusted-config'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a trusted config INSIDE the candidate is candidate-controlled (strict block)', () => {
    const resolution = resolveApprovedPolicyDigest({
      env: { [TRUSTED_CONFIG_ENV]: '/candidate/repo/.gateforge/trusted.yml' },
      candidateCwd: '/candidate/repo',
    });
    expect(resolution.status).toBe('candidate-controlled');
    if (resolution.status === 'candidate-controlled') {
      expect(resolution.detail).toContain('inside the candidate repository');
    }
  });

  it('a missing trusted config file fails closed', () => {
    const resolution = resolveApprovedPolicyDigest({
      env: { [TRUSTED_CONFIG_ENV]: join(tmpdir(), 'gateforge-pin-does-not-exist.yml') },
      candidateCwd: '/somewhere/else',
    });
    expect(resolution.status).toBe('invalid');
    if (resolution.status === 'invalid') expect(resolution.detail).toContain('does not exist');
  });
});

/** Minimal full-config document for trusted-config pins (schema-valid). */
function minimalTrustedConfig(enforcementDigest: string): string {
  return [
    'schemaVersion: 1',
    'project:',
    '  languages: [python]',
    '  paths:',
    "    include: ['src/**/*.txt']",
    '    exclude: []',
    'plugins: []',
    'policies: .gateforge/policies.yml',
    'classificationPolicy: .gateforge/classification-policy.yml',
    'adapters: .gateforge/adapters',
    'waivers: .gateforge/waivers',
    'baselines: .gateforge/baselines/obligations.json',
    'changed:',
    '  provider: auto',
    'witness:',
    '  maxDurationSeconds: 5',
    'clock:',
    '  mode: fixed',
    `  fixedAt: '${FIXED_AT}'`,
    'enforcement:',
    '  mode: standard',
    // Quoted: an all-digit 64-hex digest would otherwise parse as a number.
    `  approvedPolicyDigest: '${enforcementDigest}'`,
    '',
  ].join('\n');
}

describe('check --require-e2e binds the approved policy revision (CLI)', () => {
  it('a weakened candidate policy + pinned digest from env → ENFORCEMENT_UNTRUSTED block with the owner next action', async () => {
    await inStrictRepo(async (repo) => {
      const pin = candidatePolicyDigest(repo);
      weakenCandidatePolicy(repo);
      const { code, report } = await runRequireE2E(repo, {
        ...NO_PIN,
        [APPROVED_POLICY_DIGEST_ENV]: pin,
      });
      expect(code).toBe(1);
      expect(report.summary.blocking).toBeGreaterThan(0);
      const entry = report.blocking.find((b) => b.detail?.includes('owner-approved revision'));
      expect(entry, 'policy-ownership blocking entry present').toBeTruthy();
      expect(entry?.cause).toBe('ENFORCEMENT_UNTRUSTED');
      expect(entry?.detail).toContain('candidate policy digest does not match the owner-approved revision');
      expect(entry?.nextAction).toBe(WEAKENED_POLICY_NEXT_ACTION);
    });
  });

  it('matching pin + receipt bound to it → proceeds (exit 0)', async () => {
    await inStrictRepo(async (repo) => {
      const pin = candidatePolicyDigest(repo);
      const minted = await mintCompleteRunReceipt(repo, {
        verifierKey: VERIFIER_KEY,
        approvedPolicyDigest: pin,
      });
      expect(minted.approvedPolicyDigest).toBe(pin);
      const { code, report } = await runRequireE2E(repo, {
        ...NO_PIN,
        GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
        [APPROVED_POLICY_DIGEST_ENV]: pin,
      });
      expect(code).toBe(0);
      expect(report.summary.blocking).toBe(0);
    });
  });

  it('matching pin supplied via --approved-policy-digest flag → proceeds (exit 0)', async () => {
    await inStrictRepo(async (repo) => {
      const pin = candidatePolicyDigest(repo);
      await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY, approvedPolicyDigest: pin });
      const { code } = await runRequireE2E(
        repo,
        { ...NO_PIN, GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY },
        ['--approved-policy-digest', pin],
      );
      expect(code).toBe(0);
    });
  });

  it('missing pin in strict mode → fail-closed block naming the provisioning step', async () => {
    await inStrictRepo(async (repo) => {
      await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY });
      const { code, report } = await runRequireE2E(repo, NO_PIN);
      expect(code).toBe(1);
      const entry = report.blocking.find((b) => b.detail?.includes('no owner-approved policy digest is provisioned'));
      expect(entry, 'provisioning block present').toBeTruthy();
      expect(entry?.cause).toBe('ENFORCEMENT_UNTRUSTED');
      expect(entry?.nextAction).toBe(PROVISION_PIN_NEXT_ACTION);
    });
  });

  it('a receipt sealed under a since-revoked pin → typed reject (policy revision changed after sealing)', async () => {
    await inStrictRepo(async (repo) => {
      // The candidate policy digest still matches the CURRENT pin, but the
      // receipt was sealed under the since-revoked digest — the candidate
      // compare passes and the receipt binding is what rejects.
      const currentPin = candidatePolicyDigest(repo);
      await mintCompleteRunReceipt(repo, {
        verifierKey: VERIFIER_KEY,
        approvedPolicyDigest: 'c'.repeat(64),
      });
      const { code, report } = await runRequireE2E(repo, {
        ...NO_PIN,
        GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
        [APPROVED_POLICY_DIGEST_ENV]: currentPin,
      });
      expect(code).toBe(1);
      const entry = report.blocking.find((b) => b.detail?.includes('policy revision changed after sealing'));
      expect(entry, 'revoked-pin reject present').toBeTruthy();
      expect(entry?.cause).toBe('ENFORCEMENT_UNTRUSTED');
      expect(entry?.detail).toContain(`'${'c'.repeat(64)}'`);
      expect(entry?.detail).toContain(`'${currentPin}'`);
    });
  });

  it('under a pin, a pre-pin receipt WITHOUT the binding is rejected (strict demands the field)', async () => {
    await inStrictRepo(async (repo) => {
      const pin = candidatePolicyDigest(repo);
      await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY }); // no approvedPolicyDigest
      const { code, report } = await runRequireE2E(repo, {
        ...NO_PIN,
        GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
        [APPROVED_POLICY_DIGEST_ENV]: pin,
      });
      expect(code).toBe(1);
      const entry = report.blocking.find((b) => b.detail?.includes('carries no approvedPolicyDigest binding'));
      expect(entry, 'missing-binding reject present').toBeTruthy();
      expect(entry?.cause).toBe('ENFORCEMENT_UNTRUSTED');
    });
  });

  it('a candidate config declaring the pin itself → candidate-controlled block (never self-approval)', async () => {
    await withTempRepo({}, async (repo) => {
      // The declared value is never read as a source — any well-formed hex.
      installPinFixture(repo, `enforcement:\n  mode: standard\n  strictE2E: true\n  approvedPolicyDigest: ${'c'.repeat(64)}`);
      const { code, report } = await runRequireE2E(repo, NO_PIN);
      expect(code).toBe(1);
      const entry = report.blocking.find((b) => b.detail?.includes('candidate-controlled files cannot approve policy'));
      expect(entry, 'candidate-controlled block present').toBeTruthy();
      expect(entry?.cause).toBe('ENFORCEMENT_UNTRUSTED');
    });
  });

  it('conflicting env and flag pins → fail-closed block', async () => {
    await inStrictRepo(async (repo) => {
      const pin = candidatePolicyDigest(repo);
      await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY, approvedPolicyDigest: pin });
      const { code, report } = await runRequireE2E(
        repo,
        { ...NO_PIN, GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY, [APPROVED_POLICY_DIGEST_ENV]: 'e'.repeat(64) },
        ['--approved-policy-digest', pin],
      );
      expect(code).toBe(1);
      const entry = report.blocking.find((b) => b.detail?.includes('conflicting approved policy digests'));
      expect(entry, 'conflict block present').toBeTruthy();
    });
  });

  it('GATEFORGE_TRUSTED_CONFIG outside the candidate provisions the pin (matching → exit 0)', async () => {
    await inStrictRepo(async (repo) => {
      const pin = candidatePolicyDigest(repo);
      await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY, approvedPolicyDigest: pin });
      const dir = mkdtempSync(join(tmpdir(), 'gateforge-pin-config-'));
      try {
        const trustedConfig = join(dir, 'trusted-gateforge.yml');
        writeFileSync(trustedConfig, minimalTrustedConfig(pin), 'utf8');
        const { code } = await runRequireE2E(repo, {
          ...NO_PIN,
          GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
          [TRUSTED_CONFIG_ENV]: trustedConfig,
        });
        expect(code).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('non-strict mode without a pin keeps current behavior (pre-pin receipt stays verifiable)', async () => {
    await withTempRepo({}, async (repo) => {
      installPinFixture(repo);
      await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY });
      const { code, report } = await runRequireE2E(repo, {
        ...NO_PIN,
        GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
      });
      expect(code).toBe(0);
      expect(report.summary.blocking).toBe(0);
    });
  });

  it('non-strict mode ignores a candidate-declared pin (never a source, no block)', async () => {
    await withTempRepo({}, async (repo) => {
      // Declared before minting so the receipt binds exactly these bytes;
      // the declared value is never consulted (any well-formed hex).
      installPinFixture(repo, `enforcement:\n  mode: standard\n  approvedPolicyDigest: ${'c'.repeat(64)}`);
      await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY });
      const { code, report } = await runRequireE2E(repo, {
        ...NO_PIN,
        GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
      });
      expect(code).toBe(0);
      expect(report.summary.blocking).toBe(0);
    });
  });
});

describe('evaluateApprovedPolicy (resolution → gate mapping)', () => {
  const candidate = 'a'.repeat(64);

  it('candidate-controlled provisioning blocks only in strict mode', () => {
    const resolution = resolveApprovedPolicyDigest({
      env: {},
      candidateCwd: '/c',
      candidateConfig: {
        enforcement: { mode: 'standard', strictE2E: true, approvedPolicyDigest: candidate },
      } as unknown as GateforgeConfig,
    });
    expect(evaluateApprovedPolicy(resolution, candidate, true).status).toBe('blocked');
    expect(evaluateApprovedPolicy(resolution, candidate, false).status).toBe('unenforced');
  });

  it('a provisioned pin binds even without strictE2E (opt-in via the pin itself)', () => {
    const resolution = resolveApprovedPolicyDigest({ env: { [APPROVED_POLICY_DIGEST_ENV]: candidate }, candidateCwd: '/c' });
    expect(evaluateApprovedPolicy(resolution, candidate, false)).toEqual({ status: 'enforced', approved: candidate });
    const weakened = evaluateApprovedPolicy(resolution, 'b'.repeat(64), false);
    expect(weakened.status).toBe('blocked');
  });
});

describe('broker commit binds the approved policy revision (CLI)', () => {
  /** Authority: a real repository whose refs the broker updates. */
  async function inAuthority(body: (authority: TempRepo) => void | Promise<void>): Promise<void> {
    await withTempRepo({ prefix: 'gateforge-pin-auth-' }, async (authority) => {
      authority.commitFiles({ 'README.md': '# authority\n' }, 'authority base');
      await body(authority);
    });
  }

  /** Workspace: a committed fixture repository the broker snapshots. */
  async function inWorkspace(body: (workspace: TempRepo) => void | Promise<void>): Promise<void> {
    await withTempRepo({ prefix: 'gateforge-pin-ws-' }, async (workspace) => {
      installFixture(workspace);
      workspace.stage();
      workspace.commit('workspace base');
      await body(workspace);
    });
  }

  async function brokerCommit(
    authority: TempRepo,
    args: Record<string, string | undefined>,
    env: Record<string, string | undefined>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const argv = ['broker', 'commit'];
    for (const [name, value] of Object.entries(args)) {
      if (value === undefined) continue;
      argv.push(`--${name}`, value);
    }
    return runCli(authority, argv, env);
  }

  it('mismatched approved digest → typed rejection, NO commit created', async () => {
    await inAuthority(async (authority) => {
      await inWorkspace(async (workspace) => {
        const pin = candidatePolicyDigest(workspace);
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        weakenCandidatePolicy(workspace);
        const headBefore = authority.headSha();
        const result = await brokerCommit(
          authority,
          { workspace: workspace.root, message: 'weakened policy', receipt: minted.receiptPath },
          { ...NO_PIN, GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY, [APPROVED_POLICY_DIGEST_ENV]: pin },
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('does not match the owner-approved revision');
        expect(result.stderr).toContain('approve and repin the revision, then rerun');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('a provisioned pin demands the receipt binding: a pre-pin receipt is rejected, no commit', async () => {
    await inAuthority(async (authority) => {
      await inWorkspace(async (workspace) => {
        const pin = candidatePolicyDigest(workspace);
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        const headBefore = authority.headSha();
        const result = await brokerCommit(
          authority,
          { workspace: workspace.root, message: 'pre-pin receipt', receipt: minted.receiptPath },
          { ...NO_PIN, GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY, [APPROVED_POLICY_DIGEST_ENV]: pin },
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('carries no approvedPolicyDigest binding');
        expect(authority.headSha()).toBe(headBefore);
      });
    });
  });

  it('matching pin + receipt bound to it → commit created', async () => {
    await inAuthority(async (authority) => {
      await inWorkspace(async (workspace) => {
        const pin = candidatePolicyDigest(workspace);
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
          approvedPolicyDigest: pin,
        });
        const result = await brokerCommit(
          authority,
          { workspace: workspace.root, message: 'pinned commit', receipt: minted.receiptPath },
          { ...NO_PIN, GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY, [APPROVED_POLICY_DIGEST_ENV]: pin },
        );
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('broker: committed');
      });
    });
  });

  it('no pin provisioned → current behavior, with the honest not-enforced note', async () => {
    await inAuthority(async (authority) => {
      await inWorkspace(async (workspace) => {
        const minted = await mintCompleteRunReceipt(workspace, {
          verifierKey: VERIFIER_KEY,
          parentSha: authority.headSha(),
        });
        const result = await brokerCommit(
          authority,
          { workspace: workspace.root, message: 'unpinned commit', receipt: minted.receiptPath },
          NO_PIN,
        );
        // No verifier key in NO_PIN: the receipt cannot authenticate, so
        // this run blocks on the (unchanged) missing-key rejection — the
        // point here is the policy gate did NOT fire.
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('policy-revision ownership NOT enforced');
      });
    });
  });
});

describe('assertReceiptApprovedPolicy (receipt binding)', () => {
  it('a receipt bound to the current pin is accepted', () => {
    const pin = 'c'.repeat(64);
    expect(assertReceiptApprovedPolicy({ approvedPolicyDigest: pin }, pin)).toEqual({
      ok: true,
      enforced: true,
      approved: pin,
    });
  });

  it('a receipt without the binding is rejected when a pin is in force', () => {
    const result = assertReceiptApprovedPolicy({}, 'c'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe('ENFORCEMENT_UNTRUSTED');
      expect(result.detail).toContain('policy revision changed after sealing');
    }
  });

  it('a receipt sealed under a different approved revision is rejected', () => {
    const result = assertReceiptApprovedPolicy({ approvedPolicyDigest: 'c'.repeat(64) }, 'd'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain(`'${'c'.repeat(64)}'`);
      expect(result.detail).toContain(`'${'d'.repeat(64)}'`);
    }
  });
});

describe('enforcement doctor surfaces the pin honestly', () => {
  it('without a pin: approved policy digest reported absent (ownership NOT enforced)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], NO_PIN);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as { checks: Array<{ id: string; detail: string }> };
      const check = report.checks.find((entry) => entry.id === 'trusted-binary-policy');
      expect(check?.detail).toContain('approved policy digest: absent');
      expect(check?.detail).toContain('policy-revision ownership NOT enforced');
    });
  });

  it('with a matching pin: reported pinned and matching', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const pin = candidatePolicyDigest(repo);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        ...NO_PIN,
        [APPROVED_POLICY_DIGEST_ENV]: pin,
      });
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as { checks: Array<{ id: string; detail: string }> };
      const check = report.checks.find((entry) => entry.id === 'trusted-binary-policy');
      expect(check?.detail).toContain(`approved policy digest: pinned (${pin.slice(0, 12)}… via env)`);
      expect(check?.detail).toContain('matches the candidate policy revision');
    });
  });

  it('with a stale pin: reported MISMATCHING the candidate revision', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const pin = candidatePolicyDigest(repo);
      weakenCandidatePolicy(repo);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        ...NO_PIN,
        [APPROVED_POLICY_DIGEST_ENV]: pin,
      });
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as { checks: Array<{ id: string; status: string; detail: string }> };
      const check = report.checks.find((entry) => entry.id === 'trusted-binary-policy');
      expect(check?.detail).toContain('MISMATCHES the candidate policy revision');
    });
  });
});

/** Guard against accidental fixture drift: the weakening helper really mutates bytes. */
describe('fixture sanity', () => {
  it('weakening changes the candidate policy digest', async () => {
    await withTempRepo({}, async (repo) => {
      installPinFixture(repo);
      const before = candidatePolicyDigest(repo);
      weakenCandidatePolicy(repo);
      expect(candidatePolicyDigest(repo)).not.toBe(before);
      expect(existsSync(join(repo.root, '.gateforge/classification-policy.yml'))).toBe(true);
    });
  });

  it('REGRESSION (policy ownership): an adapter byte change is a policy-revision change, not a self-approval', async () => {
    // Review recheck 2026-09-14 finding 5: the trusted digest used to
    // hash only four documents, so a candidate could swap the EXECUTABLE
    // evidence adapter (engine-side observer) and keep the approved pin.
    // The adapter bytes are trusted-revision-owned now: any edit changes
    // the digest and blocks under a provisioned pin.
    await withTempRepo({}, async (repo) => {
      installPinFixture(repo);
      const before = candidatePolicyDigest(repo);
      repo.writeFiles({
        '.gateforge/adapters/accounts.mjs':
          'export default { environmentFingerprint: "weak", deletion: "hard", read() { return null; }, normalize: (b) => ({ entityId: b.id, fields: b }) };\n',
      });
      expect(candidatePolicyDigest(repo)).not.toBe(before);
    });
  });

  it('REGRESSION: a local plugin module byte change is a policy-revision change too', async () => {
    await withTempRepo({}, async (repo) => {
      installPinFixture(repo);
      const before = candidatePolicyDigest(repo);
      repo.writeFiles({ 'plugin.mjs': `${readFileSync(join(repo.root, 'plugin.mjs'), 'utf8')}# weakened\n` });
      expect(candidatePolicyDigest(repo)).not.toBe(before);
    });
  });
});
describe('test-gates binds the approved policy revision (orchestrator stitch)', () => {
  it('a weakened candidate under a provisioned pin blocks BEFORE the suite runs and seals nothing', async () => {
    await withTempRepo({}, async (repo) => {
      installPinFixture(repo);
      const pin = candidatePolicyDigest(repo);
      weakenCandidatePolicy(repo);
      const result = await runCli(repo, ['test-gates', '--changed'], {
        ...NO_PIN,
        [APPROVED_POLICY_DIGEST_ENV]: pin,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ENFORCEMENT_UNTRUSTED');
      expect(result.stderr).toContain('does not match the owner-approved revision');
      // The candidate never reaches the runner: no receipt line in the
      // output and no receipt file left behind.
      expect(result.stdout).not.toContain('receipt');
      expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  });

  it('strict mode without a pin fails closed naming the provisioning step', async () => {
    await withTempRepo({}, async (repo) => {
      installPinFixture(repo, 'enforcement:\n  mode: standard\n  strictE2E: true\n');
      const result = await runCli(repo, ['test-gates', '--changed'], NO_PIN);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ENFORCEMENT_UNTRUSTED');
      expect(result.stderr).toContain(APPROVED_POLICY_DIGEST_ENV);
      expect(result.stdout).not.toContain('receipt');
    });
  });

  it('a matching pin passes the policy gate and the run proceeds past it (later unrelated failure)', async () => {
    await withTempRepo({}, async (repo) => {
      installPinFixture(repo);
      const pin = candidatePolicyDigest(repo);
      const result = await runCli(repo, ['test-gates', '--changed'], {
        ...NO_PIN,
        [APPROVED_POLICY_DIGEST_ENV]: pin,
      });
      // No verifier key is provisioned, so the supervisor surface cannot
      // be used and the run fails for THAT reason — the pin check itself
      // passed (no ENFORCEMENT_UNTRUSTED, no receipt sealed), proving the
      // candidate traveled beyond the policy gate. (The observer spawns
      // fine; the 4.5 supervisor-credentials refusal is the later,
      // unrelated failure.)
      expect(result.stderr).not.toContain('ENFORCEMENT_UNTRUSTED');
      expect(result.stderr).not.toContain('owner-approved revision');
      expect(result.stdout).not.toContain('receipt');
      expect(result.stderr).toContain('GATEFORGE_WITNESS_VERIFIER_KEY');
    });
  });
});
