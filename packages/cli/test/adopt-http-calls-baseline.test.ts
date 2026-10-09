import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import { VERIFIER_KEY, installRepo, sealRunWithCalls } from './http-call-session.js';

const BASELINE_PATH = '.gateforge/baselines/obligations.json';
const BASELINE_AT_FEC15D2 = readFileSync(
  new URL('./fixtures/adopt-http-calls-baseline-fec15d2.json', import.meta.url),
  'utf8',
);

describe('gateforge adopt with witnessed HTTP exchanges', () => {
  it('keeps the whole-repository baseline byte-identical to fec15d2', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, 'report');
      await sealRunWithCalls(repo, ['/x', '/nowhere']);

      const adopted = await runCli(repo, ['adopt'], {
        GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
      });
      expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);
      expect(readFileSync(repo.path(BASELINE_PATH), 'utf8')).toBe(BASELINE_AT_FEC15D2);
    });
  });
});
