/**
 * Adoption of HTTP call findings (0.14 WP5, plan §4.5 and §8 decision 2).
 *
 * The contract, end to end over a REAL witnessed session:
 * - a call finding that exists when the owner adopts is recorded as debt:
 *   the same run passes, and the debt number counts it;
 * - a NEW unmatched call after adoption blocks, and ONLY the new one;
 * - removing the adopted call shrinks the debt by one, automatically;
 * - re-adopting changes nothing (the receipt bytes are identical);
 * - a 0.13 receipt (no `http-calls` family) gets a one-line migration
 *   message and an explicit, preview-first family migration, never an
 *   unexplained red.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import {
  SERVED_PATH,
  UNSERVED_PATH,
  VERIFIER_KEY,
  installRepo,
  sealRunWithCalls,
} from './http-call-session.js';

const RECEIPT_PATH = '.gateforge/baselines/adoption.json';
const ENV = { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY };
const FAMILY = 'http-calls';

interface Finding {
  detail: string;
  cause: string | null;
}

interface Checked {
  code: number;
  blocking: Finding[];
  advisories: Finding[];
  /** The call-finding debt the receipt records (`baseline.httpCallFindings`); 0 before adoption. */
  httpCallDebt: number;
}

/** `check --format json` over the current run state, with absent lists normalized. */
async function checked(repo: TempRepo): Promise<Checked> {
  const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], ENV);
  const parsed = JSON.parse(stdout) as {
    blocking?: Finding[];
    advisories?: Finding[];
    summary?: { baselinedHttpCallFindings?: number };
  };
  return {
    code,
    blocking: parsed.blocking ?? [],
    advisories: parsed.advisories ?? [],
    httpCallDebt: parsed.summary?.baselinedHttpCallFindings ?? 0,
  };
}

/** The HTTP call findings in one channel. */
function callFindings(entries: readonly Finding[]): Finding[] {
  return entries.filter((entry) => entry.detail.includes('HTTP_CALL_'));
}

/** The adoption receipt on disk, as bytes and as parsed JSON. */
function receiptBytes(repo: TempRepo): string {
  return readFileSync(repo.path(RECEIPT_PATH), 'utf8');
}


describe('HTTP call findings are adopted as recorded debt (0.14 WP5)', () => {
  it('adopts today’s call finding: the same run passes and the debt counts it', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);

      // Before adoption the new unmatched call blocks.
      const before = await checked(repo);
      expect(before.code).toBe(1);
      expect(callFindings(before.blocking)).toHaveLength(1);

      const adopted = await runCli(repo, ['adopt'], ENV);
      expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);
      // C2: a plain whole-repository adopt grades exactly as before WP5. The
      // call findings are recorded ONLY as the `http-calls` family of the
      // receipt, so none of their fingerprints may appear in the baseline
      // document (which stores hashes only; a code-name check would be vacuous).
      const baselineDocument = JSON.parse(readFileSync(repo.path('.gateforge/baselines/obligations.json'), 'utf8')) as {
        fingerprints: string[];
      };
      const receipt = JSON.parse(receiptBytes(repo)) as {
        families: Record<string, { fingerprintsById: Record<string, string> }>;
      };
      const callFingerprints = Object.values(receipt.families[FAMILY]?.fingerprintsById ?? {});
      expect(callFingerprints).toHaveLength(1);
      for (const fingerprint of callFingerprints) {
        expect(baselineDocument.fingerprints).not.toContain(fingerprint);
      }
      // Adopt writes the hook and config files, so the sealed run is stale
      // until `test-gates` runs again: re-seal, exactly as a user would.
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);

      // The re-sealed run: the finding is debt, not a failure.
      const after = await checked(repo);
      expect(after.code).toBe(0);
      expect(callFindings(after.blocking)).toEqual([]);
      expect(callFindings(after.advisories)).toEqual([]);
      expect(after.httpCallDebt).toBe(1);
    });
  }, 120_000);

  it('blocks a NEW unmatched call after adoption, and only the new one', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);
      expect((await runCli(repo, ['adopt'], ENV)).code).toBe(0);

      // A new call the owner did not adopt.
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH, '/brand-new']);
      const run = await checked(repo);
      expect(run.code).toBe(1);
      const blocking = callFindings(run.blocking);
      expect(blocking).toHaveLength(1);
      expect(blocking[0]?.cause).toBe('HTTP_CALL_UNMATCHED');
      expect(blocking[0]?.detail).toContain("'GET /brand-new'");
      // The adopted call is still debt, never re-blocked.
      expect(blocking.some((entry) => entry.detail.includes(UNSERVED_PATH))).toBe(false);
      expect(run.httpCallDebt).toBe(1);
    });
  }, 120_000);

  it('shrinks the debt by one automatically when the adopted call is removed', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);
      expect((await runCli(repo, ['adopt'], ENV)).code).toBe(0);
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);
      expect((await checked(repo)).httpCallDebt).toBe(1);

      // The product (or the test) no longer makes the adopted call.
      await sealRunWithCalls(repo, [SERVED_PATH]);
      const run = await checked(repo);
      expect(run.code).toBe(0);
      expect(callFindings(run.blocking)).toEqual([]);
      expect(run.httpCallDebt).toBe(0);
    });
  }, 120_000);

  it('re-adopting changes nothing: the receipt bytes are identical', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);
      expect((await runCli(repo, ['adopt'], ENV)).code).toBe(0);
      const settled = receiptBytes(repo);

      const again = await runCli(repo, ['adopt'], ENV);
      expect(again.code).toBe(0);
      expect(receiptBytes(repo)).toBe(settled);

      const preview = await runCli(repo, ['adopt', '--family', FAMILY], ENV);
      expect(preview.code).toBe(0);
      expect(receiptBytes(repo)).toBe(settled);

      const repeat = await runCli(repo, ['adopt', '--family', FAMILY, '--confirm'], ENV);
      expect(repeat.code).toBe(0);
      expect(receiptBytes(repo)).toBe(settled);
    });
  }, 120_000);

  it('migrates a 0.13 receipt: one line says what to run, and the migration is preview-first', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      // A 0.13 adoption: the repository had no call findings yet.
      await sealRunWithCalls(repo, [SERVED_PATH]);
      expect((await runCli(repo, ['adopt'], ENV)).code).toBe(0);
      // With no call findings at adoption, 0.14 writes no `families` key: this
      // IS the 0.13 receipt shape. Asserted, so the premise cannot drift.
      expect(JSON.parse(receiptBytes(repo))['families']).toBeUndefined();

      // The owner now runs a call the 0.13 receipt never saw.
      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);
      const text = await runCli(repo, ['check'], ENV);
      expect(text.code).toBe(1);
      expect(text.stdout).toContain('HTTP call findings: 1 not yet recorded as debt');
      expect(text.stdout).toContain(`gateforge adopt --family ${FAMILY}`);

      // Preview writes nothing.
      const before = receiptBytes(repo);
      const preview = await runCli(repo, ['adopt', '--family', FAMILY], ENV);
      expect(preview.code).toBe(0);
      expect(receiptBytes(repo)).toBe(before);

      // Confirm writes the family once; the call becomes recorded debt.
      const confirmed = await runCli(repo, ['adopt', '--family', FAMILY, '--confirm'], ENV);
      expect(confirmed.code, `${confirmed.stdout}\n${confirmed.stderr}`).toBe(0);
      const family = ((JSON.parse(receiptBytes(repo)) as Record<string, unknown>)['families'] as Record<string, Record<string, unknown>>)[FAMILY];
      expect(Object.keys(family?.['fingerprintsById'] as Record<string, string>)).toHaveLength(1);
      expect(family?.['forgiven']).toEqual(Object.values(family?.['fingerprintsById'] as Record<string, string>));

      await sealRunWithCalls(repo, [SERVED_PATH, UNSERVED_PATH]);
      const run = await checked(repo);
      expect(run.code, JSON.stringify(run.blocking.map((entry) => [entry.cause, entry.detail]))).toBe(0);
      expect(callFindings(run.blocking)).toEqual([]);
      expect(run.httpCallDebt).toBe(1);

      // Repeating the confirmed migration is a loud no-op.
      const settled = receiptBytes(repo);
      const repeat = await runCli(repo, ['adopt', '--family', FAMILY, '--confirm'], ENV);
      expect(repeat.code).toBe(0);
      expect(receiptBytes(repo)).toBe(settled);
    });
  }, 180_000);
});
