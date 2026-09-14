/**
 * Phase 4 end-to-end route attribution (plan §9, D2): unambiguous
 * runtime route attribution from the complete candidate set.
 *
 * A real loopback target serves a literal handler (`GET
 * /accounts/export`) and a parameter handler (`GET /accounts/<id>`)
 * with per-handler call counters. Real traffic through the real
 * witness observation proxy is consumed for a claim, anchored, and
 * evaluated by the authoritative CLI (`check`) against a repo whose
 * pipeline compiled BOTH routes (the sibling carries no obligation of
 * its own but still participates in ambiguity detection).
 *
 * - Request hits the literal handler, claim names the parameter
 *   endpoint → CLI blocks (`invalid`, ambiguous) AND the counters prove
 *   the parameter handler was never called (no wrong-route credit).
 * - Request hits `/accounts/123`, claim names the parameter endpoint →
 *   the unique parameter endpoint satisfies (the literal sibling does
 *   not match, so there is no overlap).
 *
 * Also unit-covers the CLI's inventory derivation (`httpRoutesView`):
 * every `http.endpoint` graph resource is carried (consumed or not),
 * sorted deterministically, and malformed resources are never dropped
 * (they flag the inventory incomplete in core instead).
 */
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gateforge/core';
import { startWitness } from '../../pack-playwright/src/witness/server.js';
import { beginTestInterval, endTestInterval, openTestSession, type TestSession } from './witness-sessions.js';
import { httpRoutesView } from '../src/state.js';
import { configYml, runCli, writeV2Manifest } from './helpers.js';

/** In-process detector plugin emitting the two overlapping routes. */
const HTTP_PLUGIN_SOURCE = `import { readFileSync } from 'node:fs';
export default {
  discover(paths) {
    const at = (file, line) => ({ file, line, col: 0 });
    const route = (normalizedPath, rawPath, handlerSymbol, line) => ({
      schemaVersion: 1,
      id: 'http.contract:backend/api/v1/accounts.py:' + handlerSymbol + ':GET:' + normalizedPath,
      kind: 'http.contract',
      source: 'backend/api/v1/accounts.py',
      location: at('backend/api/v1/accounts.py', line),
      detectorVersion: '1.0.0',
      attributes: {
        role: 'server-route',
        method: 'GET',
        normalizedPath,
        rawPath,
        framework: 'test',
        handlerSymbol,
        responseSchemaSymbols: ['AccountOut'],
      },
    });
    return {
      resources: [
        route('/accounts/export', '/accounts/export', 'app.get_account_export', 10),
        route('/accounts/{}', '/accounts/{id}', 'app.get_account_by_id', 20),
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [],
      scannedPaths: [...paths],
    };
  },
};
`;

const HTTP_POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: endpoint-transport
    when:
      kind: http.endpoint
    require:
      - http:request-observed
`;

const HTTP_CLASSIFICATION_POLICY_YML = `\
schemaVersion: 1
scanRoots: ['backend/**/*.py']
trustedInternalEntryPoints: []
internalRules: []
declarations:
  internality: gateforge:internal
volatileFields: []
`;

const PLANES_JSON = JSON.stringify({
  rules: [{ match: 'backend/api/v1/**', plane: 'tenant', reason: 'tenant router tree' }],
});

const LITERAL_PATH = '/accounts/export';
const PARAM_PATH = '/accounts/123';
const TEST_ID = 'route-attribution-journey';

/** Target with separate literal/parameter handlers plus call counters. */
async function startCountingTarget(): Promise<{
  url: string;
  counters: { literal: number; param: number };
  stop: () => Promise<void>;
}> {
  const counters = { literal: 0, param: 0 };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && path === LITERAL_PATH) {
      counters.literal += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ handler: 'literal' }));
      return;
    }
    const segments = path.split('/').filter((segment) => segment.length > 0);
    if (req.method === 'GET' && segments.length === 2 && segments[0] === 'accounts') {
      counters.param += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ handler: 'param', id: segments[1] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ handler: 'none' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no target port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    counters,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Installs the two-route repo (no business resources, no obligations yet). */
function installRoutesRepo(repo: TempRepo): void {
  repo.writeFiles({
    '.gateforge.yml': configYml({ include: "['backend/**/*.py']" }),
    '.gateforge/policies.yml': HTTP_POLICIES_YML,
    '.gateforge/classification-policy.yml': HTTP_CLASSIFICATION_POLICY_YML,
    '.gateforge/planes.json': PLANES_JSON,
    'plugin.mjs': HTTP_PLUGIN_SOURCE,
    'backend/api/v1/accounts.py': '# router fixture\n',
  });
}

interface ReportVerdict {
  obligationId: string;
  contract: string;
  verdict: string;
  reason: string | null;
  recordIds: string[];
}

async function checkJson(
  repo: TempRepo,
  env: Record<string, string | undefined>,
): Promise<{ code: number; verdicts: ReportVerdict[] }> {
  const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], env);
  const report = JSON.parse(stdout) as { verdicts: ReportVerdict[] };
  return { code, verdicts: report.verdicts };
}

/**
 * Discovers the compiled obligation ids from a baseline check: the
 * literal obligation (slug `accounts-export`) and the parameter
 * obligation (slug `accounts-param`).
 *
 * Args:
 *   repo: the temp repo with the two-route fixture installed.
 *
 * Returns:
 *   The literal and parameter obligation ids.
 */
async function discoverObligations(repo: TempRepo): Promise<{ literal: string; param: string }> {
  const { verdicts } = await checkJson(repo, {});
  const ids = verdicts.map((v) => v.obligationId);
  const literal = ids.find((id) => id.includes('accounts-export'));
  const param = ids.find((id) => id.includes('accounts-param'));
  if (literal === undefined || param === undefined) {
    throw new Error(`expected literal+param obligations, got: ${JSON.stringify(ids)}`);
  }
  return { literal, param };
}

describe('httpRoutesView: complete deterministic inventory from the graph', () => {
  it('carries every http.endpoint resource sorted, never drops malformed ones', () => {
    const graph = {
      resources: [
        {
          id: 'tenant.b',
          kind: 'http.endpoint',
          attributes: { method: 'GET', canonicalPath: '/b' },
        },
        { id: 'tenant.orders', kind: 'sqlalchemy.table', attributes: {} },
        {
          id: 'tenant.a',
          kind: 'http.endpoint',
          attributes: { method: 'POST', canonicalPath: '/a/{}' },
        },
        // A route with no consumer and no obligation is still carried.
        {
          id: 'tenant.unconsumed',
          kind: 'http.endpoint',
          attributes: { method: 'GET', canonicalPath: '/quiet' },
        },
        // Malformed: carried with empty fields so core flags the
        // inventory incomplete instead of trusting a partial list.
        { id: 'tenant.broken', kind: 'http.endpoint', attributes: {} },
        { id: null, kind: 'http.endpoint', attributes: { method: 'GET', canonicalPath: '/' } },
      ],
    };
    expect(httpRoutesView(graph as never)).toEqual([
      { resourceId: 'tenant.a', method: 'POST', canonicalPath: '/a/{}' },
      { resourceId: 'tenant.b', method: 'GET', canonicalPath: '/b' },
      { resourceId: 'tenant.broken', method: '', canonicalPath: '' },
      { resourceId: 'tenant.unconsumed', method: 'GET', canonicalPath: '/quiet' },
    ]);
  });
});

describe('F4 e2e: literal request claimed for the overlapping parameter endpoint', () => {
  it('CLI blocks with ambiguity and the param handler stays uncalled', async () => {
    await withTempRepo({}, async (repo) => {
      installRoutesRepo(repo);
      // Baseline: both endpoint obligations exist and are missing.
      const { literal: LITERAL_OBLIGATION, param: PARAM_OBLIGATION } =
        await discoverObligations(repo);

      const runId = '11111111-0000-4000-8000-000000000041';
      const token = 'f4-wrong-route-token';
      const verifierKey = 'f4-wrong-route-verifier-key';
      const target = await startCountingTarget();
      const witness = await startWitness({
        runId,
        token,
        verifierKey,
        proxyTarget: target.url,
      });
      try {
        // Phase 1: the exchange exists only under a supervisor-opened
        // session channel, inside a recorded interval.
        const session = await openTestSession(witness.url, token, verifierKey, TEST_ID);
        if (session.proxyUrl === null) throw new Error('session proxy did not start');
        const intervalId = await beginTestInterval(witness.url, token, session, 'read');
        // The request reaches the LITERAL handler only.
        const upstream = await fetch(`${session.proxyUrl}${LITERAL_PATH}`, {
          method: 'GET',
        });
        expect(upstream.status).toBe(200);
        expect(target.counters).toEqual({ literal: 1, param: 0 });

        // ...but the suite claims the PARAMETER endpoint for it.
        const headers = { 'x-gateforge-run': token, 'content-type': 'application/json' };
        const consumed = await fetch(`${witness.url}/witness/http-observation`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            claimIds: [PARAM_OBLIGATION],
            testId: TEST_ID,
            method: 'GET',
            path: LITERAL_PATH,
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        });
        expect(consumed.status).toBe(200);
        await endTestInterval(witness.url, token, session, intervalId);
        const anchored = await fetch(`${witness.url}/records`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            claimId: PARAM_OBLIGATION,
            kind: 'ui.action',
            payload: { operation: 'read', entityId: 'x' },
            testId: TEST_ID,
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        });
        expect(anchored.status).toBe(200);
        const ledger = (await (
          await fetch(`${witness.url}/records`, { headers: { 'x-gateforge-run': token } })
        ).json()) as { records: Array<Record<string, unknown>> };
        expect(ledger.records.length).toBeGreaterThan(0);

        const recordIds = ledger.records
          .map((entry) => entry['recordId'])
          .filter((id): id is string => typeof id === 'string')
          .sort();
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId: PARAM_OBLIGATION, testId: TEST_ID, testFile: 'route.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger.records),
        });
        // v2 attestation over the CURRENT inputs (plan §11.3): the same
        // real ledger authorizes only while the tree is unchanged.
        await writeV2Manifest(repo, { runId, verifierKey, recordIds });

        const { code, verdicts } = await checkJson(repo, {
          GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
        });
        expect(code).toBe(1);
        const param = verdicts.find((v) => v.obligationId === PARAM_OBLIGATION);
        expect(param?.verdict).toBe('invalid');
        expect(param?.reason).toContain('ambiguous route attribution');
        expect(param?.reason).toContain(LITERAL_PATH);
        expect(param?.reason).toContain('/accounts/{}');
        // The counter proves the parameter handler was not called: the
        // block is attribution, not a missed request.
        expect(target.counters).toEqual({ literal: 1, param: 0 });
        expect(LITERAL_OBLIGATION).toContain('accounts-export');
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });

  it('F6 e2e: two exchanges in either ledger order yield the same verdict and selection', async () => {
    // Plan §10 acceptance: a real target plus the real witness produce
    // two exchanges at distinct parameter paths; the ledger records
    // written in both orders must evaluate (authoritative `check`) to
    // the same verdict, reason, record ids, and exit code.
    await withTempRepo({}, async (repo) => {
      installRoutesRepo(repo);
      const { param: PARAM_OBLIGATION } = await discoverObligations(repo);
      const runId = '33333333-0000-4000-8000-000000000043';
      const token = 'f6-two-exchange-token';
      const verifierKey = 'f6-two-exchange-verifier-key';
      const target = await startCountingTarget();
      const witness = await startWitness({
        runId,
        token,
        verifierKey,
        proxyTarget: target.url,
      });
      try {
        const session = await openTestSession(witness.url, token, verifierKey, TEST_ID);
        if (session.proxyUrl === null) throw new Error('session proxy did not start');
        const intervalId = await beginTestInterval(witness.url, token, session, 'read');
        const headers = { 'x-gateforge-run': token, 'content-type': 'application/json' };
        for (const path of ['/accounts/123', '/accounts/456']) {
          const upstream = await fetch(`${session.proxyUrl}${path}`, { method: 'GET' });
          expect(upstream.status).toBe(200);
          const consumed = await fetch(`${witness.url}/witness/http-observation`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              claimIds: [PARAM_OBLIGATION],
              testId: TEST_ID,
              method: 'GET',
              path,
              sessionId: session.sessionId,
              sessionToken: session.sessionToken,
            }),
          });
          expect(consumed.status).toBe(200);
        }
        await endTestInterval(witness.url, token, session, intervalId);
        expect(target.counters).toEqual({ literal: 0, param: 2 });
        const anchored = await fetch(`${witness.url}/records`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            claimId: PARAM_OBLIGATION,
            kind: 'ui.action',
            payload: { operation: 'read', entityId: '123' },
            testId: TEST_ID,
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        });
        expect(anchored.status).toBe(200);
        const ledger = (await (
          await fetch(`${witness.url}/records`, { headers: { 'x-gateforge-run': token } })
        ).json()) as { records: Array<Record<string, unknown>> };
        expect(ledger.records.filter((entry) => entry['kind'] === 'http.request')).toHaveLength(2);

        const recordIds = ledger.records
          .map((entry) => entry['recordId'])
          .filter((id): id is string => typeof id === 'string')
          .sort();
        const claimsDoc = JSON.stringify([
          { schemaVersion: 1, obligationId: PARAM_OBLIGATION, testId: TEST_ID, testFile: 'route.mjs' },
        ]);
        const env = { GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey };
        const paramRow = (verdicts: ReportVerdict[]) =>
          verdicts.find((v) => v.obligationId === PARAM_OBLIGATION);

        repo.writeFiles({
          '.gateforge/test-gates/claims.json': claimsDoc,
          '.gateforge/test-gates/records.json': JSON.stringify(ledger.records),
        });
        // v2 attestation over the CURRENT inputs (plan §11.3); the
        // reversed-order rerun below keeps the same digest (run state is
        // excluded), so the verdict must be identical.
        await writeV2Manifest(repo, { runId, verifierKey, recordIds });
        const first = await checkJson(repo, env);

        repo.writeFiles({
          '.gateforge/test-gates/records.json': JSON.stringify([...ledger.records].reverse()),
        });
        const second = await checkJson(repo, env);

        expect(paramRow(first.verdicts)?.verdict).toBe('satisfied');
        expect(second.code).toBe(first.code);
        expect(paramRow(second.verdicts)).toEqual(paramRow(first.verdicts));
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });

  it('a parameter-only observation uniquely satisfies the parameter endpoint', async () => {
    await withTempRepo({}, async (repo) => {
      installRoutesRepo(repo);
      const { param: PARAM_OBLIGATION } = await discoverObligations(repo);
      const runId = '22222222-0000-4000-8000-000000000042';
      const token = 'f4-unique-param-token';
      const verifierKey = 'f4-unique-param-verifier-key';
      const target = await startCountingTarget();
      const witness = await startWitness({
        runId,
        token,
        verifierKey,
        proxyTarget: target.url,
      });
      try {
        const session = await openTestSession(witness.url, token, verifierKey, TEST_ID);
        if (session.proxyUrl === null) throw new Error('session proxy did not start');
        const intervalId = await beginTestInterval(witness.url, token, session, 'read');
        const upstream = await fetch(`${session.proxyUrl}${PARAM_PATH}`, {
          method: 'GET',
        });
        expect(upstream.status).toBe(200);
        expect(target.counters).toEqual({ literal: 0, param: 1 });

        const headers = { 'x-gateforge-run': token, 'content-type': 'application/json' };
        const consumed = await fetch(`${witness.url}/witness/http-observation`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            claimIds: [PARAM_OBLIGATION],
            testId: TEST_ID,
            method: 'GET',
            path: PARAM_PATH,
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        });
        expect(consumed.status).toBe(200);
        await endTestInterval(witness.url, token, session, intervalId);
        const anchored = await fetch(`${witness.url}/records`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            claimId: PARAM_OBLIGATION,
            kind: 'ui.action',
            payload: { operation: 'read', entityId: '123' },
            testId: TEST_ID,
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        });
        expect(anchored.status).toBe(200);
        const ledger = (await (
          await fetch(`${witness.url}/records`, { headers: { 'x-gateforge-run': token } })
        ).json()) as { records: Array<Record<string, unknown>> };

        const recordIds = ledger.records
          .map((entry) => entry['recordId'])
          .filter((id): id is string => typeof id === 'string')
          .sort();
        repo.writeFiles({
          '.gateforge/test-gates/claims.json': JSON.stringify([
            { schemaVersion: 1, obligationId: PARAM_OBLIGATION, testId: TEST_ID, testFile: 'route.mjs' },
          ]),
          '.gateforge/test-gates/records.json': JSON.stringify(ledger.records),
        });
        // v2 attestation over the CURRENT inputs (plan §11.3).
        await writeV2Manifest(repo, { runId, verifierKey, recordIds });

        // The literal obligation stays missing (unclaimed) so the run
        // still exits 1 — but the parameter row itself satisfies: the
        // observation attributes uniquely, with no literal overlap.
        const { verdicts } = await checkJson(repo, {
          GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
        });
        const param = verdicts.find((v) => v.obligationId === PARAM_OBLIGATION);
        expect(param?.verdict).toBe('satisfied');
        expect(target.counters).toEqual({ literal: 0, param: 1 });
      } finally {
        await witness.stop();
        await target.stop();
      }
    });
  });
});
