/**
 * Shared fixture for the HTTP call rules end to end: a two-route repo
 * (`/x` served, `/quiet` served and never called) and a REAL witnessed
 * session that calls whichever paths the test names. Both the WP3 call
 * finding tests and the WP5 adoption tests drive the authoritative CLI
 * over this one setup, so a finding means the same thing in both.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import { type TempRepo } from '@gate-forge/core';
import { startWitness } from '../../pack-playwright/src/witness/server.js';
import { configYml, writeV2Manifest } from './helpers.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';

/** The two served routes: one the session calls, one nobody calls. */
export const ROUTES_PLUGIN_SOURCE = `import { readFileSync } from 'node:fs';
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
export const POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: tables-only
    when:
      kind: sqlalchemy.table
    require:
      - crud:read
`;

export const CLASSIFICATION_POLICY_YML = `\
schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
planes:
  rules:
    - match: backend/api/v1/**
      plane: tenant
      reason: tenant router tree
`;

export const SERVED_PATH = '/x';
export const INVENTORY_GAP_PATH = '/not-in-inventory';
export const UNSERVED_PATH = '/nowhere';
export const RUN_ID = '22222222-0000-4000-8000-0000000000c3';
export const TOKEN = 'wp3-call-findings-token';
export const VERIFIER_KEY = 'wp3-call-findings-verifier-key';
export const TEST_ID = 'wp3-journey';
const RUN_HEADER = 'x-gateforge-run';
const VERIFIER_HEADER = 'x-gateforge-verifier';

/** The loopback host this suite names (built, never copied from output). */
const LOOPBACK = [127, 0, 0, 1].join('.');

/** Target serving declared success paths with 200 and everything else with 404. */
export async function startTarget(
  successPaths: readonly string[] = [SERVED_PATH],
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    res.writeHead(successPaths.includes(path) ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path }));
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${LOOPBACK}:${String(address.port)}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Installs the two-route repo; `callFindings` omitted = no `http:` key (the default). */
export function installRepo(repo: TempRepo, callFindings?: 'report' | 'block'): void {
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

/**
 * Seals ONE witnessed session that calls every given path (in order) and
 * installs its ledger, the v2 attestation and the run receipt as this
 * repo's run state. Calling it again replaces the run state: each call is
 * a fresh run over exactly the paths it names.
 *
 * Args:
 *   repo: the temp repo with the routes installed.
 *   paths: the request paths the session calls, in order.
 */
export async function sealRunWithCalls(
  repo: TempRepo,
  paths: readonly string[],
  successPaths: readonly string[] = [SERVED_PATH],
): Promise<void> {
  const target = await startTarget(successPaths);
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
    for (const path of paths) {
      const response = await fetch(`${session.proxyUrl as string}${path}`, {
        headers: { 'sec-fetch-dest': 'empty' },
      });
      await response.text();
      // Configured success paths simulate routes served by the app but missing from static inventory.
      expect(response.status).toBe(successPaths.includes(path) ? 200 : 404);
    }
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

/**
 * Re-mints the attestation and receipt over the repo's CURRENT sealed
 * records, after an owner input (the config) changed. Used when a test
 * rewrites `.gateforge.yml` on an already-sealed run.
 */
export async function resealCurrentRecords(repo: TempRepo): Promise<void> {
  const sealedRecords = JSON.parse(
    readFileSync(`${repo.root}/.gateforge/test-gates/records.json`, 'utf8'),
  ) as Array<Record<string, unknown>>;
  const recordIds = sealedRecords
    .map((entry) => entry['recordId'])
    .filter((id): id is string => typeof id === 'string')
    .sort();
  await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds });
  await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY, claimInventory: [] });
}
