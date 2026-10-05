/**
 * Phase 4c (E60) — the `http.endpoint.requireObservation` policy option.
 *
 * Today an `http.endpoint` owes `http:request-observed` /
 * `http:response-status-ok` only when it is `consumed: true` (a static
 * join with the frontend), so a brand-new route no UI calls owes
 * nothing and `check` exits 0 — "you forgot a test" is invisible. The
 * option is additive and opt-in: absent (or `consumed`) the gate output
 * is byte-identical to today; `all` makes EVERY discovered endpoint owe
 * the observation obligations, so only NEW routes block
 * (`TEST_MAPPING_MISSING`) while existing debt is forgiven by the
 * adopted baseline.
 *
 * The fixture is the real engine path: a plugin emitting `http.contract`
 * routes (compiled into `http.endpoint` resources with
 * `frontendConsumed: false`) plus a `consumed: true` policy.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { configYml, runCli } from './helpers.js';

/** One compiled route: method, path, handler and source line. */
interface RouteFixture {
  symbol: string;
  normalizedPath: string;
  rawPath: string;
  line: number;
}

const EXPORT_ROUTE: RouteFixture = {
  symbol: 'app.get_account_export',
  normalizedPath: '/accounts/export',
  rawPath: '/accounts/export',
  line: 10,
};
const PARAM_ROUTE: RouteFixture = {
  symbol: 'app.get_account_by_id',
  normalizedPath: '/accounts/{}',
  rawPath: '/accounts/{id}',
  line: 20,
};
/** The route that arrives AFTER the baseline was adopted. */
const AUDIT_ROUTE: RouteFixture = {
  symbol: 'app.get_account_audit',
  normalizedPath: '/accounts/audit',
  rawPath: '/accounts/audit',
  line: 30,
};

/** The in-process detector plugin emitting the given routes. */
function routesPluginSource(routes: readonly RouteFixture[]): string {
  const emitted = routes
    .map(
      (route) =>
        `        route('${route.normalizedPath}', '${route.rawPath}', '${route.symbol}', ${route.line}),`,
    )
    .join('\n');
  return `export default {
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
${emitted}
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [],
      scannedPaths: [...paths],
    };
  },
};
`;
}

const CLASSIFICATION_POLICY_YML = `\
schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
`;

const PLANES_JSON = JSON.stringify({
  rules: [{ match: 'backend/api/v1/**', plane: 'tenant', reason: 'tenant router tree' }],
});

/** The transport-only observation scope: `consumed` (today) or `all`. */
type ObservationScope = 'absent' | 'consumed' | 'all';

/**
 * The pinned policies document. `absent` writes no `options` section at
 * all — a repository without the key must behave exactly as it did
 * before the option existed.
 */
function policiesYml(scope: ObservationScope): string {
  const options =
    scope === 'absent'
      ? ''
      : `options:\n  'http.endpoint.requireObservation': ${scope}\n`;
  return `\
schemaVersion: 1
${options}policies:
  - id: frontend-consumed-endpoints-transport-only
    when:
      kind: http.endpoint
      consumed: true
    require:
      - http:request-observed
      - http:response-status-ok
`;
}

/** Installs the routes repo with the given policy bytes. */
function installRoutesRepo(repo: TempRepo, scope: ObservationScope, routes: readonly RouteFixture[]): void {
  repo.writeFiles({
    '.gateforge.yml': configYml({ include: "['backend/**/*.py']" }),
    '.gateforge/policies.yml': policiesYml(scope),
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/planes.json': PLANES_JSON,
    'plugin.mjs': routesPluginSource(routes),
    'backend/api/v1/accounts.py': '# router fixture\n',
  });
}

interface ReportVerdict {
  obligationId: string;
  contract: string;
  verdict: string;
  cause: string | null;
  nextAction: string | null;
}

/**
 * The exact `check --format json` bytes for a repo whose policies.yml has
 * NO options section, captured from the pre-Phase-4c engine: absent =
 * today, byte for byte. Regenerate ONLY by hand-verifying the diff.
 *
 * Re-pinned ONCE by 0.11.0: the ONLY field that moved is `inputDigest`,
 * because `.gateforge.yml` gained the REQUIRED `scan:` section (the
 * scanner settings that moved out of the answers document) and those
 * bytes are inputs. Every other field — the obligation set, the
 * verdicts, the summary, the advisories — is unchanged, which is exactly
 * the invariant this case exists to pin.
 */
const GOLDEN_ABSENT = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures/endpoint-observation-policy/check-absent-option.json',
  ),
  'utf8',
).trim();

/**
 * The same bytes with the per-invocation (`runId`), per-machine (engine
 * source path) and per-release (engine version) values normalized, so two
 * runs of engines built from the SAME code on the SAME repository bytes
 * compare exactly.
 */
function normalizedReport(stdout: string): string {
  return stdout
    .replace(/"runId":"[^"]+"/, '"runId":"<run-id>"')
    .replace(/"source":"local path [^"]+"/, '"source":"<engine-source>"')
    .replace(/("engine":\{[^}]*"version":")[^"]+"/, '$1<engine-version>"')
    .trim();
}

describe('http.endpoint.requireObservation (plan Phase 4c, E60)', () => {
  it('option absent: an unconsumed route owes nothing and check exits 0 (today)', async () => {
    await withTempRepo({}, async (repo) => {
      installRoutesRepo(repo, 'absent', [EXPORT_ROUTE, PARAM_ROUTE]);
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      const report = JSON.parse(stdout) as { verdicts: ReportVerdict[]; blocking: unknown[] };
      expect(code, stdout).toBe(0);
      expect(report.verdicts).toEqual([]);
      expect(report.blocking).toEqual([]);
    });
  });

  it('option absent: the report bytes are identical to today, apart from the one new advisory', async () => {
    await withTempRepo({}, async (repo) => {
      installRoutesRepo(repo, 'absent', [EXPORT_ROUTE, PARAM_ROUTE]);
      const { stdout } = await runCli(repo, ['check', '--format', 'json']);
      const report = JSON.parse(normalizedReport(stdout)) as {
        advisories?: Array<{ detail: string }>;
      };
      // WHY the bytes differ from the historical golden: THIS fixture has
      // a by-id route (`GET /accounts/{}`) and no table at all, so 0.9.0
      // has something to report about it. It is an ADVISORY — never
      // blocking, absent an owner opt-in — and it is the ONLY delta: it is
      // asserted exactly here, and every other byte is still compared
      // against the pre-Phase-4c golden, unchanged.
      expect(report.advisories).toHaveLength(1);
      expect(report.advisories?.[0]?.detail).toContain('ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED');
      expect(report.advisories?.[0]?.detail).toContain("derives resource name 'accounts'");
      delete report.advisories;
      expect(JSON.stringify(report)).toBe(GOLDEN_ABSENT);
    });
  });

  it("option 'consumed' (today's behavior, stated explicitly) grades exactly like absent", async () => {
    await withTempRepo({}, async (repo) => {
      installRoutesRepo(repo, 'consumed', [EXPORT_ROUTE, PARAM_ROUTE]);
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      const report = JSON.parse(stdout) as {
        verdicts: ReportVerdict[];
        blocking: unknown[];
        summary: { obligations: number };
      };
      expect(code, stdout).toBe(0);
      expect(report.summary.obligations).toBe(0);
      expect(report.verdicts).toEqual([]);
      expect(report.blocking).toEqual([]);
    });
  });

  it("option 'all': every discovered endpoint owes the observation obligations and blocks unmapped", async () => {
    await withTempRepo({}, async (repo) => {
      installRoutesRepo(repo, 'all', [EXPORT_ROUTE, PARAM_ROUTE]);
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      const report = JSON.parse(stdout) as {
        verdicts: ReportVerdict[];
        summary: { obligations: number; blocking: number };
      };
      expect(code, stdout).toBe(1);
      // Two routes × (request-observed + response-status-ok).
      expect(report.summary.obligations).toBe(4);
      expect(report.summary.blocking).toBe(4);
      expect(report.verdicts.every((entry) => entry.verdict === 'missing')).toBe(true);
      expect(report.verdicts.every((entry) => entry.cause === 'TEST_MAPPING_MISSING')).toBe(true);
      // The fix is named on every blocking verdict, and the route is.
      expect(
        report.verdicts.every(
          (entry) => (entry.nextAction ?? '').includes('tests/e2e/gateforge'),
        ),
      ).toBe(true);
      const ids = report.verdicts.map((entry) => entry.obligationId);
      expect(ids.some((id) => id.includes('accounts-export'))).toBe(true);
      expect(ids.some((id) => id.includes('accounts-param'))).toBe(true);

      // The human report names the routes themselves, so the gap is
      // findable without reading ids.
      const human = await runCli(repo, ['check']);
      expect(human.code).toBe(1);
      expect(human.stdout).toContain('GET /accounts/export');
      expect(human.stdout).toContain('GET /accounts/{}');
      expect(human.stdout).toContain('unconsumed backend routes (2)');
      expect(human.stdout).toContain('gateforge run: 4 obligation(s)');
    });
  });

  it("option 'all': adopted debt stays forgiven and a NEW route blocks alone", async () => {
    await withTempRepo({}, async (before) => {
      installRoutesRepo(before, 'all', [EXPORT_ROUTE, PARAM_ROUTE]);
      // The one sanctioned bulk-add: today's debt becomes forgiven.
      const adopted = await runCli(before, ['adopt']);
      expect(adopted.code, adopted.stdout + adopted.stderr).toBe(0);
      expect(adopted.stdout).toContain('adopted as forgiven: 4');
      const forgiven = await runCli(before, ['check', '--format', 'json']);
      expect(forgiven.code, forgiven.stdout).toBe(0);
      const receipt = JSON.parse(forgiven.stdout) as { summary: { waived: number } };
      expect(receipt.summary.waived).toBe(4);

      // The same repository, one commit later: a brand-new route no UI
      // calls and nobody wired a test for. (A fresh repo tree carries the
      // adopted baseline forward; the fingerprints are content-derived.)
      const baseline = readFileSync(before.path('.gateforge/baselines/obligations.json'), 'utf8');
      const adoption = readFileSync(before.path('.gateforge/baselines/adoption.json'), 'utf8');
      await withTempRepo({}, async (after) => {
        installRoutesRepo(after, 'all', [EXPORT_ROUTE, PARAM_ROUTE, AUDIT_ROUTE]);
        after.writeFiles({
          '.gateforge/baselines/obligations.json': baseline,
          '.gateforge/baselines/adoption.json': adoption,
        });
        const run = await runCli(after, ['check', '--format', 'json']);
        const report = JSON.parse(run.stdout) as {
          verdicts: ReportVerdict[];
          summary: { waived: number; blocking: number };
        };
        expect(run.code, run.stdout).toBe(1);
        expect(report.summary.waived).toBe(4);
        expect(report.summary.blocking).toBe(2);
        const newRoute = report.verdicts.filter((entry) => entry.obligationId.includes('accounts-audit'));
        expect(newRoute).toHaveLength(2);
        expect(newRoute.every((entry) => entry.verdict === 'missing')).toBe(true);
        expect(newRoute.every((entry) => entry.cause === 'TEST_MAPPING_MISSING')).toBe(true);
        // The pre-existing routes stay forgiven — only the new debt blocks.
        const human = await runCli(after, ['check']);
        expect(human.stdout).toContain('[missing] tenant.http-get-accounts-audit');
        expect(human.stdout).not.toContain('[missing] tenant.http-get-accounts-export');
        expect(human.stdout).not.toContain('[missing] tenant.http-get-accounts-param');
      });
    });
  });

  it('next explains the option only on the item it caused, and enforcement doctor stays silent', async () => {
    await withTempRepo({}, async (repo) => {
      installRoutesRepo(repo, 'all', [EXPORT_ROUTE, PARAM_ROUTE]);
      const human = await runCli(repo, ['next']);
      expect(human.code, human.stdout).toBe(1);
      expect(human.stdout).toContain('cause: TEST_MAPPING_MISSING');
      expect(human.stdout).toContain('scope: GET ');
      expect(human.stdout).toContain("'http.endpoint.requireObservation' is 'all'");
      expect(human.stdout).toContain('.gateforge/policies.yml');

      const json = await runCli(repo, ['next', '--json']);
      const parsed = JSON.parse(json.stdout) as { cause: string; scopeNote?: string[] };
      expect(parsed.cause).toBe('TEST_MAPPING_MISSING');
      expect(parsed.scopeNote?.join('\n')).toContain('requireObservation');

      // A surface that has nothing to do with the observation scope
      // never names it.
      const doctor = await runCli(repo, ['enforcement', 'doctor']);
      expect(doctor.stdout + doctor.stderr).not.toContain('requireObservation');
    });
  });

  it('next stays silent about the option when it did not cause the item', async () => {
    await withTempRepo({}, async (repo) => {
      // An endpoint policy WITHOUT the `consumed` matcher: today's
      // option-less document that already owes every route.
      installRoutesRepo(repo, 'absent', [EXPORT_ROUTE, PARAM_ROUTE]);
      repo.writeFiles({
        '.gateforge/policies.yml': policiesYml('absent').replace(
          '      kind: http.endpoint\n      consumed: true\n',
          '      kind: http.endpoint\n',
        ),
      });
      const human = await runCli(repo, ['next']);
      expect(human.code, human.stdout).toBe(1);
      expect(human.stdout).toContain('cause: TEST_MAPPING_MISSING');
      expect(human.stdout).not.toContain('requireObservation');
      const json = await runCli(repo, ['next', '--json']);
      expect((JSON.parse(json.stdout) as { scopeNote?: string[] }).scopeNote).toBeUndefined();
    });
  });
});
