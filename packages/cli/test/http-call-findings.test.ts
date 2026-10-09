/**
 * The HTTP call rules R2/R3 end to end (0.14 WP3, plan §4.3): a REAL
 * witnessed session calls a served path and an unserved one, and the
 * authoritative CLI reports the unmatched call with the test's own id.
 *
 * The channel is the owner's declaration (`http.callFindings`):
 * `report` (the default) prints and serializes the finding while the exit
 * code stays 0; `block` puts the same finding on the run's blocking set
 * and fails the check exactly like any other blocking finding. Nothing
 * else about the report changes between the two.
 *
 * still printed, no call finding exists, and the verdicts are untouched.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { startWitness } from '../../pack-playwright/src/witness/server.js';
import { configYml, runCli, writeV2Manifest } from './helpers.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';

/** The two served routes: one the session calls, one nobody calls. */
const ROUTES_PLUGIN_SOURCE = `import { readFileSync } from 'node:fs';
export default {
  discover(paths) {
    const at = (line) => ({ file: 'backend/api/v1/accounts.py', line, col: 0 });
    const route = (normalizedPath, handlerSymbol, line) => ({
      schemaVersion: 1,
      id: 'http.contract:backend/api/v1/accounts.py:' + handlerSymbol + ':GET:' + normalizedPath,
      kind: 'http.contract',
      source: 'backend/api/v1/accounts.py',
      location: at(line),
      detectorVersion: '1.0.0',
      attributes: {
        role: 'server-route',
        method: 'GET',
        normalizedPath,
        rawPath: normalizedPath,
        framework: 'test',
        handlerSymbol,
        // Capability evidence: without it every endpoint is an
        // ENDPOINT_SEMANTICS_UNRESOLVED blocker and this fixture would
        // be about that instead of about the call rules.
        responseSchemaSymbols: ['RouteOut'],
      },
    });
    return {
      resources: [route('/x', 'app.get_x', 10), route('/quiet', 'app.get_quiet', 20)],
      unresolved: [],
      findings: [],
      classificationSignals: [],
      scannedPaths: [...paths],
    };
  },
};
`;

/**
 * A policy that matches nothing in this repo: the fixture is about the
 * CALL rules, so no obligation of its own may colour the exit code.
 */
const POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: tables-only
    when:
      kind: sqlalchemy.table
    require:
      - crud:read
`;

const CLASSIFICATION_POLICY_YML = `\
schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
planes:
  rules:
    - match: backend/api/v1/**
      plane: tenant
      reason: tenant router tree
`;

const SERVED_PATH = '/x';
const UNSERVED_PATH = '/nowhere';
const RUN_ID = '22222222-0000-4000-8000-0000000000c3';
const TOKEN = 'wp3-call-findings-token';
const VERIFIER_KEY = 'wp3-call-findings-verifier-key';
const TEST_ID = 'wp3-journey';
const RUN_HEADER = 'x-gateforge-run';
const VERIFIER_HEADER = 'x-gateforge-verifier';

/** The loopback host this suite names (built, never copied from output). */
const LOOPBACK = [127, 0, 0, 1].join('.');

/** Target serving `/x` with 200 and everything else with 404. */
async function startTarget(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    res.writeHead(path === SERVED_PATH ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path }));
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${LOOPBACK}:${String(address.port)}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Installs the two-route repo with the given call-findings channel. */
function installRepo(repo: TempRepo, callFindings?: 'report' | 'block'): void {
  repo.writeFiles({
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge.yml': configYml({
      include: "['backend/**/*.py']",
      ...(callFindings === undefined ? {} : { http: { callFindings } }),
    }),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    'plugin.mjs': ROUTES_PLUGIN_SOURCE,
    'backend/api/v1/accounts.py': '# router fixture\n',
  });
}

interface CallReport {
  code: number;
  advisories: Array<{ detail: string; cause: string | null }>;
  blocking: Array<{ detail: string; cause: string | null }>;
  verdicts: unknown[];
  httpCoverage: { served: number; used: number; proven: number; missing: number; unmatched: number; ambiguous: number };
  httpLedger?: { rows: Array<{ path: string; resolution: string }> };
}

/** Runs `check --format json` over the sealed run state. */
async function checkJson(repo: TempRepo): Promise<CallReport> {
  const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], {
    GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
  });
  // An empty channel is an ABSENT key (the report adds no empty lists),
  // so the reader normalizes it once here.
  const report = JSON.parse(stdout) as Omit<CallReport, 'code' | 'advisories' | 'blocking' | 'verdicts'> & {
    advisories?: CallReport['advisories'];
    blocking?: CallReport['blocking'];
    verdicts?: CallReport['verdicts'];
  };
  return {
    ...report,
    code,
    advisories: report.advisories ?? [],
    blocking: report.blocking ?? [],
    verdicts: report.verdicts ?? [],
  };
}

/**
 * Seals one witnessed session that calls the served path and the unserved
 * one, and installs its ledger (plus the v2 attestation and the run
 * receipt) as this repo's run state.
 *
 * Args:
 *   repo: the temp repo with the routes installed.
 *
 * Returns:
 *   void: the run state under `.gateforge/test-gates/` is written.
 */
async function sealRunWithBothCalls(repo: TempRepo): Promise<void> {
  const target = await startTarget();
  const witness = await startWitness({
    runId: RUN_ID,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    proxyTarget: target.url,
  });
  try {
    const headers = {
      'content-type': 'application/json',
      [RUN_HEADER]: TOKEN,
      [VERIFIER_HEADER]: VERIFIER_KEY,
    };
    const opened = await fetch(`${witness.url}/sessions/open`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ runId: RUN_ID, testId: TEST_ID, workerIndex: 0, claims: [] }),
    });
    expect(opened.status).toBe(200);
    const session = (await opened.json()) as { sessionId: string; proxyUrl: string | null };
    expect(session.proxyUrl).not.toBeNull();
    const proxiedGet = async (path: string): Promise<number> => {
      const response = await fetch(`${session.proxyUrl as string}${path}`);
      await response.text();
      return response.status;
    };
    expect(await proxiedGet(SERVED_PATH)).toBe(200);
    expect(await proxiedGet(UNSERVED_PATH)).toBe(404);
    const closed = await fetch(`${witness.url}/sessions/close`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: session.sessionId, outcome: 'passed' }),
    });
    expect(closed.status).toBe(200);

    const ledger = (await (
      await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })
    ).json()) as { records: Array<Record<string, unknown>> };
    const recordIds = ledger.records
      .map((entry) => entry['recordId'])
      .filter((id): id is string => typeof id === 'string')
      .sort();
    repo.writeFiles({
      '.gateforge/test-gates/claims.json': '[]',
      '.gateforge/test-gates/records.json': JSON.stringify(ledger.records),
    });
    await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds });
    await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY, claimInventory: [] });
  } finally {
    await witness.stop();
    await target.stop();
  }
}

describe('the HTTP call rules end to end (0.14 WP3 R2/R3/R5)', () => {
  it('reports the unmatched call with its test id and leaves the exit code at 0', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      await sealRunWithBothCalls(repo);

      const report = await checkJson(repo);
      expect(report.blocking).toEqual([]);
      expect(report.code).toBe(0);
      // The served route's caller is a `match`, the unserved one a
      // `nomatch`: the ledger is the input, exactly as WP2 left it.
      expect(report.httpLedger?.rows).toEqual([
        expect.objectContaining({ path: '/nowhere', resolution: 'nomatch', testId: TEST_ID, status: 404 }),
        expect.objectContaining({ path: '/x', resolution: 'match', testId: TEST_ID, status: 200 }),
      ]);
      // R5: two routes served, one used (the caller's route), one never
      // called — a count, never a finding.
      expect(report.httpCoverage).toEqual({
        served: 2,
        used: 1,
        proven: 0,
        missing: 1,
        unmatched: 1,
        ambiguous: 0,
      });
      const findings = report.advisories.filter((entry) => entry.detail.includes('HTTP_CALL_'));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.cause).toBe('HTTP_CALL_UNMATCHED');
      expect(findings[0]?.detail).toContain(TEST_ID);
      expect(findings[0]?.detail).toContain(`'GET ${UNSERVED_PATH}'`);
      expect(findings[0]?.detail).toContain('HTTP 404');
      // Report mode never blocks.
      expect(report.blocking).toEqual([]);
      expect(report.verdicts).toEqual([]);
    });
  }, 60_000);

  it('blocks the very same finding when the owner declares http.callFindings: block', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      await sealRunWithBothCalls(repo);
      // The declaration is an owner input, so the attestation and the
      // receipt are re-minted over the changed repository bytes.
      repo.writeFiles({ '.gateforge.yml': configYml({ include: "['backend/**/*.py']", http: { callFindings: 'block' } }) });
      const sealedRecords = JSON.parse(
        readFileSync(`${repo.root}/.gateforge/test-gates/records.json`, 'utf8'),
      ) as Array<Record<string, unknown>>;
      const recordIds = sealedRecords
        .map((entry) => entry['recordId'])
        .filter((id): id is string => typeof id === 'string')
        .sort();
      await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds });
      await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY, claimInventory: [] });

      const report = await checkJson(repo);
      expect(report.code).toBe(1);
      const findings = report.blocking.filter((entry) => entry.detail.includes('HTTP_CALL_'));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.cause).toBe('HTTP_CALL_UNMATCHED');
      expect(findings[0]?.detail).toContain(TEST_ID);
      // The advisory channel is empty in block mode: one finding, one
      // channel, never the same finding twice.
      expect(report.advisories.filter((entry) => entry.detail.includes('HTTP_CALL_'))).toEqual([]);
      expect(report.httpCoverage).toMatchObject({ served: 2, used: 1, unmatched: 1 });
    });
  }, 60_000);

  it('prints the summary and mints no finding for a run without exchanges', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      // An empty run state: no records, no claims, no attestation.
      repo.writeFiles({
        '.gateforge/test-gates/claims.json': '[]',
        '.gateforge/test-gates/records.json': '[]',
      });
      const report = await checkJson(repo);
      expect(report.httpLedger).toBeUndefined();
      expect(report.httpCoverage).toEqual({
        served: 2,
        used: 0,
        proven: 0,
        missing: 0,
        unmatched: 0,
        ambiguous: 0,
      });
      expect(report.advisories.filter((entry) => entry.detail.includes('HTTP_CALL_'))).toEqual([]);
      expect(report.blocking.filter((entry) => entry.detail.includes('HTTP_CALL_'))).toEqual([]);
      expect(report.verdicts).toEqual([]);
    });
  });
});