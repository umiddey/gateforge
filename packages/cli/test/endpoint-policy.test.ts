/**
 * The init policies template (ADR 0004 D8): endpoint capability
 * classification must compile capability-specific obligations and never
 * serve browser-exercise obligations to server-only (unconsumed)
 * endpoints. Domain-capability policies are deliberately ABSENT: the
 * auth/workflow/webhook/task/validation contracts have no honest
 * evidence channel until their packs ship engine-owned state-observing
 * producers, so the template must not require them. The template is
 * validated against the same pinned `PolicyFileSchema` the pipeline
 * enforces on `.gateforge/policies.yml`.
 */
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { withTempRepo } from '@gate-forge/core';
import { PolicyFileSchema } from '@gate-forge/core';
import { POLICIES_TEMPLATE, TRANSPORT_ONLY_POLICY_EXAMPLE } from '../src/commands/init.js';
import { installFixture, runCli, writeV2Manifest } from './helpers.js';
import { startWitness } from '../../pack-playwright/src/witness/server.js';
import { beginTestInterval, endTestInterval, openTestSession } from './witness-sessions.js';

const parsed = PolicyFileSchema.parse(parseYaml(POLICIES_TEMPLATE));
const byId = new Map(parsed.policies.map((policy) => [policy.id, policy]));

/** Contract namespaces with no honest evidence channel today. */
const UNPRODUCIBLE_NAMESPACES = ['auth:', 'workflow:', 'webhook:', 'task:', 'validation:'];

describe('init policies template: endpoint policies (ADR 0004 D8)', () => {
  it('parses and lists exactly the two honest policies', () => {
    expect(parsed.policies.map((policy) => policy.id)).toEqual([
      'frontend-consumed-endpoints',
      'user-facing-persistence',
    ]);
  });

  it('scopes frontend-consumed-endpoints to consumed endpoints with no capability clause', () => {
    const policy = byId.get('frontend-consumed-endpoints');
    expect(policy?.when).toEqual({ kind: 'http.endpoint', consumed: true });
    expect(policy?.require).toEqual([
      'http:frontend-request-observed',
      'http:response-status-ok',
    ]);
  });

  it('no policy requires an auth:/workflow:/webhook:/task:/validation: contract', () => {
    for (const policy of parsed.policies) {
      for (const contract of policy.require) {
        const unproducible = UNPRODUCIBLE_NAMESPACES.some((namespace) =>
          contract.startsWith(namespace),
        );
        expect(
          unproducible,
          `policy '${policy.id}' requires '${contract}', which has no honest evidence ` +
            'channel until its pack ships a state-observing producer',
        ).toBe(false);
      }
    }
  });

  it('no policy matches on a capability when-clause', () => {
    for (const policy of parsed.policies) {
      expect(
        policy.when,
        `policy '${policy.id}' must not match on 'capability'`,
      ).not.toHaveProperty('capability');
    }
  });

  it('leaves the user-facing-persistence policy unchanged (tables are not endpoints)', () => {
    const policy = byId.get('user-facing-persistence');
    expect(policy?.when).toEqual({ exposure: 'user-facing' });
    expect(policy?.require).toEqual([
      'persistence:create',
      'persistence:read',
      'persistence:update',
      'persistence:delete',
    ]);
  });

  it('keeps the default frontend requirement (blocking with the current observer)', () => {
    const policy = byId.get('frontend-consumed-endpoints');
    expect(policy?.require).toContain('http:frontend-request-observed');
  });
});

describe('transport-only policy example (plan §8 / D1, opt-in)', () => {
  it('parses and requires only the explicit transport contracts', () => {
    const example = PolicyFileSchema.parse(parseYaml(TRANSPORT_ONLY_POLICY_EXAMPLE));
    expect(example.policies.map((policy) => policy.id)).toEqual([
      'frontend-consumed-endpoints-transport-only',
    ]);
    const policy = example.policies[0];
    expect(policy?.when).toEqual({ kind: 'http.endpoint', consumed: true });
    expect(policy?.require).toEqual(['http:request-observed', 'http:response-status-ok']);
    expect(policy?.require).not.toContain('http:frontend-request-observed');
  });
});

describe('plan §8 integration: Node-only attack ledger through the authoritative CLI', () => {
  const RUN_ID = '00000000-0000-4000-8000-000000000011';
  const TOKEN = 'cli-phase3-token';
  const VERIFIER_KEY = 'cli-phase3-verifier-secret';
  const TEST_ID = 'node-attack';

  /** Minimal loopback target: every POST answers 201. */
  async function startTarget(): Promise<{ url: string; stop: () => Promise<void> }> {
    const server: Server = createServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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

  interface AttackLedger {
    records: Array<Record<string, unknown>>;
  }

  /**
   * Runs the Node-only attack against a real target + trusted witness:
   * plain Node HTTP (never Playwright) through the observation proxy,
   * consumed once for both fixture obligations, plus provenanced
   * claimed ui.action anchors — all under a testId that only the suite
   * asserts.
   *
   * Args:
   *   contract: the http contract the obligations require.
   *
   * Returns:
   *   AttackLedger: the real witness-issued ledger for the run.
   */
  async function nodeAttackLedger(contract: string): Promise<AttackLedger> {
    const obligations = [
      `tenant.accounts:${contract}`,
      `tenant.orders:${contract}`,
    ];
    const target = await startTarget();
    // Enforcement-review fix 3: the test acts as its own supervisor —
    // the witness gets the verifier key and the session open presents it.
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      // Phase 1: the attack ledger exists only under a supervisor-opened
      // session, through the session's dedicated observation channel,
      // inside a recorded action interval.
      const session = await openTestSession(witness.url, TOKEN, VERIFIER_KEY, TEST_ID);
      if (session.proxyUrl === null) throw new Error('session proxy did not start');
      const intervalId = await beginTestInterval(witness.url, TOKEN, session, 'create');
      const attack = await fetch(`${session.proxyUrl}/api/contracts`, { method: 'POST' });
      expect(attack.status).toBe(201);
      const consume = await fetch(`${witness.url}/witness/http-observation`, {
        method: 'POST',
        headers: { 'x-gateforge-run': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimIds: obligations,
          testId: TEST_ID,
          method: 'POST',
          path: '/api/contracts',
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      expect(consume.status).toBe(200);
      await endTestInterval(witness.url, TOKEN, session, intervalId);
      for (const obligationId of obligations) {
        const anchor = await fetch(`${witness.url}/records`, {
          method: 'POST',
          headers: { 'x-gateforge-run': TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            claimId: obligationId,
            kind: 'ui.action',
            payload: { operation: 'create', entityId: 'acc-1' },
            testId: TEST_ID,
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        });
        expect(anchor.status).toBe(200);
      }
      const ledgerResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      expect(ledgerResponse.status).toBe(200);
      return (await ledgerResponse.json()) as AttackLedger;
    } finally {
      await witness.stop();
      await target.stop();
    }
  }

  it('frontend policy: the Node attack ledger stays blocking missing (exit 1)', async () => {
    const ledger = await nodeAttackLedger('http:frontend-request-observed');
    expect(ledger.records.length).toBeGreaterThan(0);
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const obligations = [
        'tenant.accounts:http:frontend-request-observed',
        'tenant.orders:http:frontend-request-observed',
      ];
      repo.writeFiles({
        '.gateforge/policies.yml':
          'schemaVersion: 1\npolicies:\n  - id: user-facing-http\n    when:\n      exposure: user-facing\n    require: [http:frontend-request-observed]\n',
        '.gateforge/test-gates/claims.json': JSON.stringify(
          obligations.map((obligationId) => ({
            schemaVersion: 1,
            obligationId,
            testId: TEST_ID,
            testFile: 'tests/attack.spec.ts',
          })),
        ),
        '.gateforge/test-gates/records.json': JSON.stringify(ledger.records),
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as {
        summary: { blocking: number };
        verdicts: Array<{ obligationId: string; verdict: string; reason: string | null }>;
        blocking: Array<{ kind: string; detail?: string }>;
      };
      // Two missing verdicts plus the §11.6 evidence-context blocker:
      // witnessed records with no verifier key demote and stay visible
      // (fail closed — never silently unattributed).
      expect(report.summary.blocking).toBe(3);
      expect(report.verdicts.map((v) => v.obligationId).sort()).toEqual([...obligations].sort());
      for (const row of report.verdicts) {
        expect(row.verdict).toBe('missing');
        expect(row.reason ?? '').toContain("'http:frontend-request-observed'");
        expect(row.reason ?? '').toContain('no independent browser/test observation channel');
      }
      expect(
        report.blocking.some(
          (entry) =>
            entry.kind === 'finding' && (entry.detail ?? '').includes('no witness verifier key'),
        ),
      ).toBe(true);
    });
  });

  it('transport policy on business resources: no endpoint inventory blocks invalid (exit 1, plan §9)', async () => {
    // Phase 4 migration (plan §9): business-resource `http:*`
    // obligations carry no endpoint inventory (the fixture graph has no
    // `http.endpoint` resources), so even a perfectly witnessed exchange
    // blocks as `invalid` — the any-endpoint fallback is removed. The
    // real positive CLI flow is the route-attribution e2e
    // (`http-route-attribution.test.ts`), where the graph compiles both
    // overlapping routes.
    const ledger = await nodeAttackLedger('http:request-observed');
    const recordIds = ledger.records.map((entry) => String(entry['recordId'] ?? ''));
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const obligations = [
        'tenant.accounts:http:request-observed',
        'tenant.orders:http:request-observed',
      ];
      repo.writeFiles({
        '.gateforge/policies.yml':
          'schemaVersion: 1\npolicies:\n  - id: user-facing-http\n    when:\n      exposure: user-facing\n    require: [http:request-observed]\n',
        '.gateforge/test-gates/claims.json': JSON.stringify(
          obligations.map((obligationId) => ({
            schemaVersion: 1,
            obligationId,
            testId: TEST_ID,
            testFile: 'tests/attack.spec.ts',
          })),
        ),
        '.gateforge/test-gates/records.json': JSON.stringify(ledger.records),
      });
      // v2 attestation over the CURRENT inputs (plan §11.3): records
      // must authorize before the engine reaches route attribution.
      await writeV2Manifest(repo, { runId: RUN_ID, verifierKey: VERIFIER_KEY, recordIds });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], {
        GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
      });
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as {
        summary: { blocking: number };
        verdicts: Array<{ obligationId: string; verdict: string; reason: string | null }>;
      };
      expect(report.summary.blocking).toBe(2);
      expect(report.verdicts.map((v) => v.obligationId).sort()).toEqual([...obligations].sort());
      for (const row of report.verdicts) {
        expect(row.verdict).toBe('invalid');
        expect(row.reason ?? '').toContain('matches none of the 0 inventoried routes');
      }
    });
  });
});

// The config template keeps its own init-time self-check via parseConfig
// (asserted end-to-end by test/init.test.ts through `loadConfig`), so it
// is not re-asserted here.
