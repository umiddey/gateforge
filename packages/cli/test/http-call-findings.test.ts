/**
 * The HTTP call rules R2/R3 end to end (0.14 WP3, plan §4.3): a REAL
 * witnessed session calls a served path and an unserved one, and the
 * authoritative CLI reports the unmatched call with the test's own id.
 *
 * The channel is the owner's declaration (`http.callFindings`):
 * `block` (the default since 0.14 WP5) puts the finding on the run's
 * blocking set and fails the check exactly like any other blocking
 * finding; `report` prints and serializes the same finding while the exit
 * code stays 0. Nothing else about the report changes between the two.
 *
 * Without exchanges no call finding exists, and the verdicts are untouched.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { configYml, runCli } from './helpers.js';
import {
  SERVED_PATH,
  TEST_ID,
  UNSERVED_PATH,
  VERIFIER_KEY,
  installRepo,
  resealCurrentRecords,
  sealRunWithCalls,
} from './http-call-session.js';

interface CallReport {
  code: number;
  advisories: Array<{ detail: string; cause: string | null }>;
  blocking: Array<{ detail: string; cause: string | null }>;
  verdicts: unknown[];
  httpCoverage: { served: number; used: number; proven: number; missing: number; unmatched: number; ambiguous: number };
  httpLedger?: { rows: Array<{ path: string; resolution: string }> };
}

/** Runs `check --format json` over the sealed run state. */
async function checkJson(repo: Parameters<typeof runCli>[0]): Promise<CallReport> {
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

describe('the HTTP call rules end to end (0.14 WP3 R2/R3/R5)', () => {
  it('reports the unmatched call with its test id and leaves the exit code at 0', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, 'report');
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);

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
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);
      // The declaration is an owner input, so the attestation and the
      // receipt are re-minted over the changed repository bytes.
      repo.writeFiles({ '.gateforge.yml': configYml({ include: "['backend/**/*.py']", http: { callFindings: 'block' } }) });
      await resealCurrentRecords(repo);

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
      installRepo(repo, 'report');
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
