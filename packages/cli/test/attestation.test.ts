/**
 * Versioned attestation matrix (plan §11.7, F2/D3): evidence binds to
 * the tested source/policy inputs and the fresh invocation identity.
 *
 * - Valid-current, dirty-edit, policy-edit, and old-restore run through
 *   the REAL CLI and the REAL witness (committed temp fixture, fixed
 *   clock, valid UUIDs — never the review's synthetic `old-run` string).
 * - The full green path runs REAL `test-gates` (child-process CLI, so
 *   the in-process witness stays responsive) with a suite that drives
 *   real proxy traffic, consumes a real observation, anchors it, and
 *   proves the verifier key never reaches the suite (plan §11.8).
 * - Check-level rows cover untracked, lockfile, deletion, staged,
 *   tampered-MAC, legacy, transplanted, missing-vs-malformed, and
 *   key-absent/wrong cases with the real MAC producer/verifier.
 *
 * Red-probe rule: on the pre-Phase-6 tree none of this exists — legacy
 * v1 MACs authorize, digests are unbound, and invocations are unscoped.
 */
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAttestationMac, withTempRepo, type TempRepo } from '@gate-forge/core';
import { startWitness } from '../../pack-playwright/src/witness/server.js';
import { beginTestInterval, endTestInterval, openTestSession, type TestSession } from './witness-sessions.js';
import { configYml, currentInputDigest, runCli, writeV2Manifest } from './helpers.js';

/** Absolute path of the compiled CLI bin (child-process runs). */
const CLI_BIN = join(process.cwd(), 'packages/cli/bin/gateforge.js');

const RUN_ID = '44444444-0000-4000-8000-000000000044';
const TOKEN = 'attestation-matrix-token';
const VERIFIER_KEY = 'attestation-matrix-verifier-key';
const INVOCATION_ID = '55555555-0000-4000-8000-000000000055';
const TEST_ID = 'attestation-matrix-journey';
const HEALTH_PATH = '/api/v1/accounts';

/** Single-route detector plugin: one unambiguous literal endpoint. */
const PING_PLUGIN_SOURCE = `import { readFileSync } from 'node:fs';
export default {
  discover(paths) {
    const at = (file, line) => ({ file, line, col: 0 });
    return {
      resources: [{
        schemaVersion: 1,
        id: 'http.contract:backend/api/v1/accounts.py:app.get_account:GET:/api/v1/accounts',
        kind: 'http.contract',
        source: 'backend/api/v1/accounts.py',
        location: at('backend/api/v1/accounts.py', 10),
        detectorVersion: '1.0.0',
        attributes: {
          role: 'server-route',
          method: 'GET',
          normalizedPath: '/api/v1/accounts',
          rawPath: '/api/v1/accounts',
          framework: 'test',
          handlerSymbol: 'app.get_account',
          responseSchemaSymbols: ['AccountOut'],
        },
      }],
      unresolved: [],
      findings: [],
      classificationSignals: [],
      scannedPaths: [...paths],
    };
  },
};
`;

const PING_POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: endpoint-transport
    when:
      kind: http.endpoint
    require:
      - http:request-observed
`;

const PING_CLASSIFICATION_POLICY_YML = `\
schemaVersion: 1
scanRoots: ['backend/**/*.py']
trustedInternalEntryPoints: []
internalRules: []
declarations:
  internality: gateforge:internal
volatileFields: []
`;

/** Installs the single-route transport fixture. */
function installPingRepo(repo: TempRepo): void {
  repo.writeFiles({
    '.gateforge.yml': configYml({ include: "['backend/**/*.py']" }),
    '.gateforge/policies.yml': PING_POLICIES_YML,
    '.gateforge/classification-policy.yml': PING_CLASSIFICATION_POLICY_YML,
    '.gateforge/planes.json': JSON.stringify({
      rules: [{ match: 'backend/api/v1/**', plane: 'tenant', reason: 'tenant router tree' }],
    }),
    'plugin.mjs': PING_PLUGIN_SOURCE,
    'backend/api/v1/accounts.py': '# accounts router fixture\n',
  });
}

/** Plain loopback target serving the health endpoint. */
async function startHealthTarget(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && path === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'none' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no target port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface MatrixReport {
  summary: { blocking: number };
  verdicts: Array<{
    obligationId: string;
    verdict: string;
    reason: string | null;
    recordIds: string[];
  }>;
  blocking: Array<{ kind: string; detail?: string }>;
}

/** Parses a json-format check report. */
function parseMatrixReport(stdout: string): MatrixReport {
  return JSON.parse(stdout) as MatrixReport;
}

/**
 * Parses a json-format test-gates report whose stdout is prefixed by
 * suite output lines (the suite child's stdout is forwarded before the
 * report is printed).
 */
function parseTestGatesReport(stdout: string): MatrixReport {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.startsWith('{'));
  if (start < 0) throw new Error('test-gates printed no JSON report');
  return JSON.parse(lines.slice(start).join('\n')) as MatrixReport;
}

/**
 * Discovers the compiled transport obligation id via a baseline check
 * (writes nothing — the digest is unaffected).
 */
async function discoverPingObligation(repo: TempRepo): Promise<string> {
  const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
  expect(code).toBe(1);
  const report = parseMatrixReport(stdout);
  expect(report.verdicts).toHaveLength(1);
  const id = report.verdicts[0]?.obligationId;
  if (typeof id !== 'string') throw new Error('no obligation compiled');
  return id;
}

/**
 * Drives real traffic through the session's dedicated observation
 * channel, consumes the observation for the claim, and anchors it —
 * returning the ledger's issued ids. All over real loopback HTTP against
 * the real witness, under a supervisor-opened session (Phase 1 +
 * enforcement-review fix 3: the session open presents the verifier key —
 * the supervisor capability — exactly as the CLI's spool drain does).
 */
async function observeAndAnchor(
  witnessUrl: string,
  token: string,
  obligationId: string,
): Promise<string[]> {
  const session = await openTestSession(witnessUrl, token, VERIFIER_KEY, TEST_ID);
  if (session.proxyUrl === null) throw new Error('session proxy did not start');
  const intervalId = await beginTestInterval(witnessUrl, token, session, 'read');
  const upstream = await fetch(`${session.proxyUrl}${HEALTH_PATH}`, { method: 'GET' });
  expect(upstream.status).toBe(200);
  const headers = { 'x-gateforge-run': token, 'content-type': 'application/json' };
  const consumed = await fetch(`${witnessUrl}/witness/http-observation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      claimIds: [obligationId],
      testId: TEST_ID,
      method: 'GET',
      path: HEALTH_PATH,
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
    }),
  });
  expect(consumed.status).toBe(200);
  await endTestInterval(witnessUrl, token, session, intervalId);
  const anchored = await fetch(`${witnessUrl}/records`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      claimId: obligationId,
      kind: 'ui.action',
      payload: { operation: 'read', entityId: 'health' },
      testId: TEST_ID,
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
    }),
  });
  expect(anchored.status).toBe(200);
  const ledger = (await (
    await fetch(`${witnessUrl}/records`, { headers: { 'x-gateforge-run': token } })
  ).json()) as { records: Array<Record<string, unknown>> };
  return ledger.records
    .map((entry) => entry['recordId'])
    .filter((id): id is string => typeof id === 'string')
    .sort();
}

/** Runs the compiled CLI bin as a child process (keeps OUR event loop free). */
async function runCliChild(
  repo: TempRepo,
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...argv], {
      cwd: repo.root,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('attestation matrix: valid current run (real CLI + real witness)', () => {
  it('matching snapshot and context authorizes the real ledger (exit 0)', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      repo.stage();
      repo.commit('ping fixture');
      const obligationId = await discoverPingObligation(repo);
      const target = await startHealthTarget();
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        proxyTarget: target.url,
      });
      try {
        const digest = await currentInputDigest(repo);
        const bind = await fetch(`${witness.url}/run-context`, {
          method: 'POST',
          headers: {
            'x-gateforge-run': TOKEN,
            'x-gateforge-verifier': VERIFIER_KEY,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: digest }),
        });
        expect(bind.status).toBe(200);
        const recordIds = await observeAndAnchor(witness.url, TOKEN, obligationId);
        const ledger = (await (
          await fetch(`${witness.url}/records`, { headers: { 'x-gateforge-run': TOKEN } })
        ).json()) as { records: Array<Record<string, unknown>> };
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId, testId: TEST_ID, testFile: 'ping.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger.records),
        });
        await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds, invocationId: INVOCATION_ID });
        const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], {
          GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
        });
        expect(code).toBe(0);
        const report = parseMatrixReport(stdout);
        expect(report.summary.blocking).toBe(0);
        expect(report.verdicts[0]?.verdict).toBe('satisfied');
        expect(report.blocking).toEqual([]);
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });
});

describe('attestation matrix: stale evidence blocks (real CLI)', () => {
  it('same HEAD with an unstaged source edit blocks old evidence', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      repo.stage();
      const head = repo.commit('ping fixture');
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      const obligationId = await discoverPingObligation(repo);
      const target = await startHealthTarget();
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        proxyTarget: target.url,
      });
      try {
        const digest = await currentInputDigest(repo);
        expect((await awaitBind(witness.url, digest)).status).toBe(200);
        const recordIds = await observeAndAnchor(witness.url, TOKEN, obligationId);
        const ledger = await readLedger(witness.url);
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId, testId: TEST_ID, testFile: 'ping.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger),
        });
        await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds, invocationId: INVOCATION_ID });
        // Sanity: the current tree authorizes.
        expect((await runCli(repo, ['check', '--format', 'json'], { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY })).code).toBe(0);
        // Same HEAD, unstaged source edit: old evidence blocks.
        repo.writeFiles({ 'backend/api/v1/accounts.py': '# accounts router fixture\n# attacker tweak\n' });
        const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], {
          GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
        });
        expect(code).toBe(1);
        const report = parseMatrixReport(stdout);
        expect(report.verdicts[0]?.verdict).not.toBe('satisfied');
        expect(
          report.blocking.some((entry) => (entry.detail ?? '').includes('inputDigest')),
        ).toBe(true);
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });

  it('policy edit blocks old evidence', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      repo.stage();
      repo.commit('ping fixture');
      const obligationId = await discoverPingObligation(repo);
      const target = await startHealthTarget();
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        proxyTarget: target.url,
      });
      try {
        const digest = await currentInputDigest(repo);
        expect((await awaitBind(witness.url, digest)).status).toBe(200);
        const recordIds = await observeAndAnchor(witness.url, TOKEN, obligationId);
        const ledger = await readLedger(witness.url);
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId, testId: TEST_ID, testFile: 'ping.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger),
        });
        await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds, invocationId: INVOCATION_ID });
        repo.writeFiles({ '.gateforge/policies.yml': `${PING_POLICIES_YML}# policy tweak\n` });
        const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], {
          GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
        });
        expect(code).toBe(1);
        const report = parseMatrixReport(stdout);
        expect(report.verdicts[0]?.verdict).not.toBe('satisfied');
        expect(
          report.blocking.some((entry) => (entry.detail ?? '').includes('inputDigest')),
        ).toBe(true);
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });

  it('staged edits, untracked files, lockfile changes, and deletions block old evidence', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      repo.writeFiles({ 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }) });
      repo.stage();
      repo.commit('ping fixture with lockfile');
      const obligationId = await discoverPingObligation(repo);
      const target = await startHealthTarget();
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        proxyTarget: target.url,
      });
      try {
        const digest = await currentInputDigest(repo);
        expect((await awaitBind(witness.url, digest)).status).toBe(200);
        const recordIds = await observeAndAnchor(witness.url, TOKEN, obligationId);
        const ledger = await readLedger(witness.url);
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId, testId: TEST_ID, testFile: 'ping.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger),
        });
        await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds, invocationId: INVOCATION_ID });
        const env = { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY };
        const blocked = async (): Promise<MatrixReport> => {
          const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], env);
          expect(code).toBe(1);
          const report = parseMatrixReport(stdout);
          expect(report.verdicts[0]?.verdict).not.toBe('satisfied');
          return report;
        };
        // Same HEAD, staged source edit (HEAD sha unchanged, index moved).
        const headBefore = repo.headSha();
        repo.writeFiles({ 'backend/api/v1/accounts.py': '# accounts router fixture\n# staged tweak\n' });
        repo.stage(['backend/api/v1/accounts.py']);
        expect(repo.headSha()).toBe(headBefore);
        await blocked();
        // Revert (unstage first: checkout restores from the index).
        repo.git(['reset', '--quiet']);
        repo.git(['checkout', '--', 'backend/api/v1/accounts.py']);
        // New untracked source file.
        repo.writeFiles({ 'backend/api/v1/evil.py': '# evil\n' });
        await blocked();
        rmSync(join(repo.root, 'backend/api/v1/evil.py'));
        // Changed dependency lockfile.
        repo.writeFiles({
          'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { changed: true } }),
        });
        await blocked();
        // Restored lockfile authorizes again (D3: identical inputs reusable).
        repo.writeFiles({
          'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
        });
        expect((await runCli(repo, ['check', '--format', 'json'], env)).code).toBe(0);
        // Removed tracked source file.
        repo.git(['rm', '--quiet', 'backend/api/v1/accounts.py']);
        const deletion = await blocked();
        expect(
          deletion.blocking.some((entry) => (entry.detail ?? '').includes('inputDigest')),
        ).toBe(true);
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });

  it('an old bundle restored over a newer run cannot satisfy (check level)', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      repo.stage();
      repo.commit('ping fixture');
      const obligationId = await discoverPingObligation(repo);
      const target = await startHealthTarget();
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        proxyTarget: target.url,
      });
      try {
        const digest = await currentInputDigest(repo);
        expect((await awaitBind(witness.url, digest)).status).toBe(200);
        const recordIds = await observeAndAnchor(witness.url, TOKEN, obligationId);
        const ledger = await readLedger(witness.url);
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId, testId: TEST_ID, testFile: 'ping.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger),
        });
        await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds, invocationId: INVOCATION_ID });
        const oldManifest = readFileSync(join(repo.root, '.gateforge/test-gates/manifest.json'), 'utf8');
        const env = { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY };
        expect((await runCli(repo, ['check', '--format', 'json'], env)).code).toBe(0);
        // Tree moves on (newer run), then the OLD bundle is restored.
        repo.writeFiles({ 'backend/api/v1/accounts.py': '# accounts router fixture\n# v2\n' });
        await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds, invocationId: '66666666-0000-4000-8000-000000000066' });
        expect((await runCli(repo, ['check', '--format', 'json'], env)).code).toBe(0);
        repo.writeFiles({ '.gateforge/test-gates/manifest.json': oldManifest });
        const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], env);
        expect(code).toBe(1);
        expect(parseMatrixReport(stdout).verdicts[0]?.verdict).not.toBe('satisfied');
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });
});

describe('attestation matrix: key, format, and identity rows (real CLI)', () => {
  it('verifier key absent or wrong authorizes nothing (fail closed)', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      repo.stage();
      repo.commit('ping fixture');
      const obligationId = await discoverPingObligation(repo);
      const target = await startHealthTarget();
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        proxyTarget: target.url,
      });
      try {
        const digest = await currentInputDigest(repo);
        expect((await awaitBind(witness.url, digest)).status).toBe(200);
        const recordIds = await observeAndAnchor(witness.url, TOKEN, obligationId);
        const ledger = await readLedger(witness.url);
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId, testId: TEST_ID, testFile: 'ping.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger),
        });
        await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds, invocationId: INVOCATION_ID });
        // No key: witnessed records demote with an explicit blocker.
        const noKey = await runCli(repo, ['check', '--format', 'json']);
        expect(noKey.code).toBe(1);
        const noKeyReport = parseMatrixReport(noKey.stdout);
        expect(noKeyReport.verdicts[0]?.verdict).not.toBe('satisfied');
        expect(
          noKeyReport.blocking.some((entry) => (entry.detail ?? '').includes('verifier key')),
        ).toBe(true);
        // Wrong key: the MAC cannot verify.
        const wrongKey = await runCli(repo, ['check', '--format', 'json'], {
          GATEFORGE_WITNESS_VERIFIER_KEY: 'wrong-key-material',
        });
        expect(wrongKey.code).toBe(1);
        expect(parseMatrixReport(wrongKey.stdout).verdicts[0]?.verdict).not.toBe('satisfied');
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });

  it('snapshot-unavailable repos fail evidence authorization (discovery still runs)', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      repo.stage();
      repo.commit('ping fixture');
      const obligationId = await discoverPingObligation(repo);
      const target = await startHealthTarget();
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        proxyTarget: target.url,
      });
      try {
        const digest = await currentInputDigest(repo);
        expect((await awaitBind(witness.url, digest)).status).toBe(200);
        const recordIds = await observeAndAnchor(witness.url, TOKEN, obligationId);
        const ledger = await readLedger(witness.url);
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId, testId: TEST_ID, testFile: 'ping.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger),
        });
        await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds, invocationId: INVOCATION_ID });
        // Removing .git keeps discovery working but must fail evidence
        // authorization with a snapshot-unavailable diagnostic — the
        // MAC-valid envelope authorizes nothing without a trusted digest.
        rmSync(join(repo.root, '.git'), { recursive: true, force: true });
        const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], {
          GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
        });
        expect(code).toBe(1);
        const report = parseMatrixReport(stdout);
        expect(report.verdicts[0]?.verdict).not.toBe('satisfied');
        expect(
          report.blocking.some((entry) => (entry.detail ?? '').includes('snapshot-unavailable')),
        ).toBe(true);
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });

  it('missing vs malformed envelopes are distinguished', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      repo.stage();
      repo.commit('ping fixture');
      const obligationId = await discoverPingObligation(repo);
      const target = await startHealthTarget();
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        proxyTarget: target.url,
      });
      try {
        const digest = await currentInputDigest(repo);
        expect((await awaitBind(witness.url, digest)).status).toBe(200);
        const recordIds = await observeAndAnchor(witness.url, TOKEN, obligationId);
        const ledger = await readLedger(witness.url);
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId, testId: TEST_ID, testFile: 'ping.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger),
        });
        await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds, invocationId: INVOCATION_ID });
        const env = { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY };
        const manifestPath = join(repo.root, '.gateforge/test-gates/manifest.json');
        // Missing: manifest with ids but no envelope at all.
        repo.writeFiles({
          '.gateforge/test-gates/manifest.json': JSON.stringify({
            schemaVersion: 1,
            runId: RUN_ID,
            startedAt: '2026-01-01T00:00:00.000Z',
            gitSha: null,
            provider: 'all-files',
            plugins: [],
            attestationScope: null,
            recordIds,
          }),
        });
        const missing = await runCli(repo, ['check', '--format', 'json'], env);
        expect(missing.code).toBe(1);
        expect(
          parseMatrixReport(missing.stdout).blocking.some((entry) =>
            (entry.detail ?? '').includes('(missing)'),
          ),
        ).toBe(true);
        // Malformed: an envelope-shaped object that is not v2.
        const malformedDoc = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        repo.writeFiles({
          '.gateforge/test-gates/manifest.json': JSON.stringify({
            ...malformedDoc,
            attestation: { attestationVersion: 1, runId: RUN_ID, recordIds },
          }),
        });
        const malformed = await runCli(repo, ['check', '--format', 'json'], env);
        expect(malformed.code).toBe(1);
        expect(
          parseMatrixReport(malformed.stdout).blocking.some((entry) =>
            (entry.detail ?? '').includes('malformed'),
          ),
        ).toBe(true);
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });
});

describe('attestation matrix: full test-gates path (real CLI child + real witness)', () => {
  it('green run: suite traffic attests live, persists durable, exits 0 (key never reaches the suite)', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      const obligationId = await discoverPingObligation(repo);
      repo.writeFiles({
        'suite.mjs': `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const stateDir = process.env.GATEFORGE_STATE_DIR;
const witnessUrl = process.env.GATEFORGE_WITNESS_URL;
const token = process.env.GATEFORGE_RUN_TOKEN;
const proxyUrl = process.env.TEST_PROXY_URL;
const claimId = process.env.TEST_CLAIM;
if (!stateDir || !witnessUrl || !token || !proxyUrl || !claimId) throw new Error('missing suite env');
const keyAbsent = process.env.GATEFORGE_WITNESS_VERIFIER_KEY === undefined;
writeFileSync(join(stateDir, 'key-check.json'), JSON.stringify({ keyAbsent }));
const testId = ${JSON.stringify(TEST_ID)};
// Enforcement-review fix 3 — the legitimate session flow: the untrusted
// suite writes a testBegin lifecycle event to the run-state SPOOL
// (identities only, no secrets), and the TRUSTED CLI's spool drain
// performs the supervisor-authenticated witness session open. The suite
// then resolves its session credential by the exact (workerIndex,
// testId) pair — a credential the suite can never mint itself.
const spoolFile = join(stateDir, 'spool', process.env.GATEFORGE_RUN_ID, 'events.jsonl');
mkdirSync(join(spoolFile, '..'), { recursive: true });
appendFileSync(spoolFile, JSON.stringify({
  kind: 'testBegin', testId, workerIndex: 0, file: 'suite.mjs', titlePath: [testId], project: null,
}) + '\\n');
let session = null;
for (let i = 0; i < 100; i++) {
  const resolveRes = await fetch(witnessUrl + '/sessions/resolve', {
    method: 'POST', headers: { 'x-gateforge-run': token, 'content-type': 'application/json' },
    body: JSON.stringify({ testId, workerIndex: 0 }),
  });
  if (resolveRes.ok) { session = await resolveRes.json(); break; }
  if (resolveRes.status !== 404) throw new Error('session resolve failed: ' + (await resolveRes.text()));
  await new Promise((r) => setTimeout(r, 100));
}
if (!session) throw new Error('the supervisor never opened a session (spool drain missing?)');
if (!session.proxyUrl) throw new Error('session proxy did not start');
const intervalRes = await fetch(witnessUrl + '/sessions/intervals/open', {
  method: 'POST', headers: { 'x-gateforge-run': token, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: session.sessionId, sessionToken: session.sessionToken, operation: 'read' }),
});
if (!intervalRes.ok) throw new Error('interval open failed');
const intervalId = (await intervalRes.json()).intervalId;
const traffic = await fetch(session.proxyUrl + ${JSON.stringify(HEALTH_PATH)});
if (!traffic.ok) throw new Error('proxy traffic failed');
const headers = { 'x-gateforge-run': token, 'content-type': 'application/json' };
const consumed = await fetch(witnessUrl + '/witness/http-observation', {
  method: 'POST', headers,
  body: JSON.stringify({ claimIds: [claimId], testId, method: 'GET', path: ${JSON.stringify(HEALTH_PATH)}, sessionId: session.sessionId, sessionToken: session.sessionToken }),
});
if (!consumed.ok) throw new Error('consume failed: ' + (await consumed.text()));
const anchored = await fetch(witnessUrl + '/records', {
  method: 'POST', headers,
  body: JSON.stringify({ claimId, kind: 'ui.action', payload: { operation: 'read', entityId: 'health' }, testId, sessionId: session.sessionId, sessionToken: session.sessionToken }),
});
if (!anchored.ok) throw new Error('anchor failed: ' + (await anchored.text()));
await fetch(witnessUrl + '/sessions/intervals/close', {
  method: 'POST', headers,
  body: JSON.stringify({ sessionId: session.sessionId, sessionToken: session.sessionToken, intervalId }),
});
// testEnd: the drain seals the session with the observed outcome. The
// suite itself has NO reachable session-close path (run-token close
// answers 401/403).
appendFileSync(spoolFile, JSON.stringify({
  kind: 'testEnd', testId, workerIndex: 0, file: 'suite.mjs', titlePath: [testId], project: null,
  outcome: 'passed', attempt: 1,
}) + '\\n');
// The suite cannot seal or mint sessions: run-token lifecycle calls are
// refused (pinned here from inside the untrusted child).
const forbiddenOpen = await fetch(witnessUrl + '/sessions/open', {
  method: 'POST', headers: { 'x-gateforge-run': token, 'content-type': 'application/json' },
  body: JSON.stringify({ testId: 'invented-by-the-suite', workerIndex: 9 }),
});
if (forbiddenOpen.status === 200) throw new Error('run-token session open MUST be refused');
const forbiddenClose = await fetch(witnessUrl + '/sessions/close', {
  method: 'POST', headers: { 'x-gateforge-run': token, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: session.sessionId, outcome: 'passed' }),
});
if (forbiddenClose.status === 200) throw new Error('run-token session close MUST be refused');
// Reporter duty (GF-23): records.json is a verbatim copy of the witness
// ledger — the ONLY input the verifier reads. Fabricated bundles never
// enter it.
const ledgerRes = await fetch(witnessUrl + '/records', { headers: { 'x-gateforge-run': token } });
if (!ledgerRes.ok) throw new Error('ledger read failed');
const ledger = await ledgerRes.json();
writeFileSync(join(stateDir, 'records.json'), JSON.stringify(ledger.records));
writeFileSync(join(stateDir, 'claims.json'), JSON.stringify([
  { schemaVersion: 1, obligationId: claimId, testId, testFile: 'suite.mjs' },
]));
console.log('suite-done');
`,
      });
      repo.stage();
      repo.commit('ping fixture with suite');
      const target = await startHealthTarget();
      const stateDir = join(repo.root, '.gateforge/test-gates');
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        stateDir,
        proxyTarget: target.url,
      });
      try {
        const proxyUrl = witness.proxyUrl;
        if (proxyUrl === null) throw new Error('observation proxy did not start');
        const out = await runCliChild(
          repo,
          [
            'test-gates',
            '--out', stateDir,
            '--suite', `node ${repo.path('suite.mjs')}`,
            '--format', 'json',
            '--witness-url', witness.url,
            '--run-token', TOKEN,
          ],
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
            TEST_PROXY_URL: proxyUrl,
            TEST_CLAIM: obligationId,
          },
        );
        expect(out.code, `CLI stderr:\n${out.stderr}\nCLI stdout:\n${out.stdout}`).toBe(0);
        // The emitted report carries the satisfied transport verdict.
        const runReport = JSON.parse(
          readFileSync(join(stateDir, 'report.json'), 'utf8'),
        ) as MatrixReport;
        expect(runReport.verdicts).toHaveLength(1);
        expect(runReport.verdicts[0]?.verdict).toBe('satisfied');
        // The suite proved the verifier key never reached it.
        const keyCheck = JSON.parse(
          readFileSync(join(stateDir, 'key-check.json'), 'utf8'),
        ) as { keyAbsent: boolean };
        expect(keyCheck.keyAbsent).toBe(true);
        // The CLI persisted the validated live v2 envelope as the
        // durable fallback (witness may stop only after evaluation).
        const manifest = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')) as {
          invocationId?: string;
          inputDigest?: string;
          attestation?: {
            attestationVersion: number;
            runId: string;
            invocationId: string;
            inputDigest: string;
            recordIds: string[];
            mac: string;
          };
        };
        expect(manifest.attestation?.attestationVersion).toBe(2);
        expect(manifest.attestation?.runId).toBe(RUN_ID);
        const digest = await currentInputDigest(repo);
        expect(manifest.attestation?.inputDigest).toBe(digest);
        expect(
          verifyAttestationMac(
            VERIFIER_KEY,
            {
              runId: manifest.attestation?.runId,
              invocationId: manifest.attestation?.invocationId,
              inputDigest: manifest.attestation?.inputDigest,
              recordIds: manifest.attestation?.recordIds,
            },
            manifest.attestation?.mac,
          ),
        ).toBe(true);
        // No verifier material ever lands in suite-visible state.
        const stateText = [
          'env.json',
          'manifest.json',
          'claims.json',
          'records.json',
        ]
          .map((name) => readFileSync(join(stateDir, name), 'utf8'))
          .join('\n');
        expect(stateText).not.toContain(VERIFIER_KEY);
        // The witness shutdown append agrees with the persisted live
        // envelope (same signed object, same invocation).
        await witness.stop();
        const durable = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')) as {
          attestation?: { invocationId: string; mac: string };
        };
        expect(durable.attestation?.invocationId).toBe(manifest.attestation?.invocationId);
        await target.stop();
      } catch (error) {
        try {
          await witness.stop();
        } catch {
          // Already stopped on the green path.
        }
        try {
          await target.stop();
        } catch {
          // Already stopped on the green path.
        }
        throw error;
      }
    });
  });

  it('old bundle restored during a new invocation cannot satisfy (invocation mismatch)', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      // The restore suite is static (reads the old bundle from outside
      // the repo via env), so writing it BEFORE crafting keeps the tree
      // — and therefore the old envelope's digest — stable.
      repo.writeFiles({
        'restore.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const stateDir = process.env.GATEFORGE_STATE_DIR;
const bundleDir = process.env.OLD_BUNDLE_DIR;
if (!stateDir || !bundleDir) throw new Error('missing suite env');
writeFileSync(join(stateDir, 'manifest.json'), readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
writeFileSync(join(stateDir, 'records.json'), readFileSync(join(bundleDir, 'records.json'), 'utf8'));
console.log('restored-old-bundle');
`,
      });
      repo.stage();
      repo.commit('ping fixture with restore suite');
      const obligationId = await discoverPingObligation(repo);
      // An OLD valid envelope for the CURRENT tree but a PREVIOUS
      // invocation (as if a prior test-gates run left it behind).
      const target = await startHealthTarget();
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY,
        proxyTarget: target.url,
      });
      const digest = await currentInputDigest(repo);
      const OLD_INVOCATION = '77777777-0000-4000-8000-000000000077';
      expect((await awaitBind(witness.url, digest, OLD_INVOCATION)).status).toBe(200);
      const recordIds = await observeAndAnchor(witness.url, TOKEN, obligationId);
      const ledger = await readLedger(witness.url);
      await witness.stop();
      await target.stop();
      repo.writeFiles({
        '.gateforge/test-gates/claims.json': JSON.stringify([
          { schemaVersion: 1, obligationId, testId: TEST_ID, testFile: 'ping.mjs' },
        ]),
        '.gateforge/test-gates/records.json': JSON.stringify(ledger),
      });
      await writeV2Manifest(repo, {
        runId: RUN_ID,
        verifierKey: VERIFIER_KEY,
        recordIds,
        invocationId: OLD_INVOCATION,
      });
      // Stash the old bundle OUTSIDE the repo (inside would move the
      // digest the envelope binds).
      const bundleDir = mkdtempSync(join(tmpdir(), 'gateforge-old-bundle-'));
      writeFileSync(join(bundleDir, 'manifest.json'), readFileSync(join(repo.root, '.gateforge/test-gates/manifest.json'), 'utf8'));
      writeFileSync(join(bundleDir, 'records.json'), readFileSync(join(repo.root, '.gateforge/test-gates/records.json'), 'utf8'));
      // A NEW invocation restores the old bundle mid-run (the suite
      // overwrites the fresh manifest + records with the old files).
      const out = await runCli(repo, ['test-gates', '--suite', `node ${repo.path('restore.mjs')}`, '--format', 'json'], {
        GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
        OLD_BUNDLE_DIR: bundleDir,
      });
      expect(out.code).toBe(1);
      const report = parseTestGatesReport(out.stdout);
      expect(report.verdicts[0]?.verdict).not.toBe('satisfied');
      expect(
        report.blocking.some((entry) => (entry.detail ?? '').includes('invocation')),
      ).toBe(true);
    });
  });

  it('a suite that mutates source mid-run blocks the whole evidence run', async () => {
    await withTempRepo({}, async (repo) => {
      installPingRepo(repo);
      repo.stage();
      repo.commit('ping fixture');
      repo.writeFiles({
        'mutate.mjs': `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(join(process.env.GATEFORGE_STATE_DIR, '..', '..', 'backend', 'api', 'v1', 'accounts.py'), '# suite mutation\\n');
console.log('mutated');
`,
      });
      const out = await runCli(
        repo,
        ['test-gates', '--suite', `node ${repo.path('mutate.mjs')}`, '--format', 'json'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY },
      );
      expect(out.code).toBe(1);
      const report = parseTestGatesReport(out.stdout);
      expect(
        report.blocking.some((entry) => (entry.detail ?? '').includes('changed its own')),
      ).toBe(true);
    });
  });
});

/** Binds the witness run context for the matrix's trusted setup. */
async function awaitBind(url: string, digest: string, invocationId = INVOCATION_ID): Promise<Response> {
  return fetch(`${url}/run-context`, {
    method: 'POST',
    headers: {
      'x-gateforge-run': TOKEN,
      'x-gateforge-verifier': VERIFIER_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ runId: RUN_ID, invocationId, inputDigest: digest }),
  });
}

/** Reads the witness ledger rows (suite-placed evidence for check-level rows). */
async function readLedger(url: string): Promise<Array<Record<string, unknown>>> {
  const ledger = (await (
    await fetch(`${url}/records`, { headers: { 'x-gateforge-run': TOKEN } })
  ).json()) as { records: Array<Record<string, unknown>> };
  return ledger.records;
}
