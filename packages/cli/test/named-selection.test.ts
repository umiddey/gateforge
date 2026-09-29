/**
 * `gateforge test-gates --test <selector>`: a hand-picked, witnessed
 * single-test check that runs in seconds and NEVER seals a receipt.
 *
 * The rules these tests pin:
 * - `--test` is only ever allowed together with `--result-only`; a
 *   hand-picked list can never become gate authority (exit 2).
 * - Selectors resolve against the PLANNED rows (the expected set fixed
 *   before the run), never against raw runner output.
 * - An unknown or ambiguous selector fails closed with the candidate
 *   keys listed — a narrower selection is never guessed.
 * - The `named-selection` mode enters the selection digest, so a named
 *   run can never collide with a full or a mapped seal.
 */
import { describe, expect, it } from 'vitest';
import { selectionDigestOf } from '@gate-forge/core';
import { withTempRepo } from '@gate-forge/core';
import { resolveTestSelectors } from '../src/commands/test-gates.js';
import { installFixture, runCli } from './helpers.js';

/** The planned rows the resolution is exercised against (logical keys only). */
const ROWS = [
  { logicalKey: 'vitest:tests/uc-53.test.mjs:creates the account' },
  { logicalKey: 'vitest:tests/uc-51.test.mjs:archives the account' },
  { logicalKey: 'vitest:tests/billing.test.mjs:invoices the account' },
];

describe('test selector resolution', () => {
  it('resolves an exact logical key and a unique substring to the same key', () => {
    expect(resolveTestSelectors(['vitest:tests/uc-53.test.mjs:creates the account'], ROWS)).toEqual([
      { selector: 'vitest:tests/uc-53.test.mjs:creates the account', logicalKeys: ['vitest:tests/uc-53.test.mjs:creates the account'] },
    ]);
    expect(resolveTestSelectors(['uc-51'], ROWS)).toEqual([
      { selector: 'uc-51', logicalKeys: ['vitest:tests/uc-51.test.mjs:archives the account'] },
    ]);
  });

  it('resolves several selectors and reports each one separately', () => {
    expect(resolveTestSelectors(['uc-53', 'billing'], ROWS)).toEqual([
      { selector: 'uc-53', logicalKeys: ['vitest:tests/uc-53.test.mjs:creates the account'] },
      { selector: 'billing', logicalKeys: ['vitest:tests/billing.test.mjs:invoices the account'] },
    ]);
  });

  it('refuses an unknown selector and lists the candidate keys', () => {
    expect(() => resolveTestSelectors(['uc-99'], ROWS)).toThrow(/uc-99/);
    expect(() => resolveTestSelectors(['uc-99'], ROWS)).toThrow(
      /vitest:tests\/uc-53\.test\.mjs:creates the account/,
    );
  });

  it('refuses an ambiguous substring and lists every candidate it could mean', () => {
    expect(() => resolveTestSelectors(['the account'], ROWS)).toThrow(/uc-53/);
    expect(() => resolveTestSelectors(['the account'], ROWS)).toThrow(/uc-51/);
    expect(() => resolveTestSelectors(['the account'], ROWS)).toThrow(/billing/);
  });

  it('resolves one bad selector even when the others are exact', () => {
    expect(() => resolveTestSelectors(['uc-51', 'uc-99'], ROWS)).toThrow(/uc-99/);
  });
});

describe('test-gates --test flag', () => {
  it('refuses --test without --result-only: a hand-picked list never seals a receipt', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      const result = await runCli(repo, ['test-gates', '--changed', '--test', 'uc-53']);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/--test requires --result-only/);
      expect(result.stderr).toMatch(/never seals a receipt/);
    });
  });

  it('refuses --test together with the legacy --suite escape hatch', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      const result = await runCli(repo, [
        'test-gates',
        '--test',
        'uc-53',
        '--result-only',
        '--suite',
        'echo hi',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/--test runs through the supervised runner adapter/);
    });
  });
});

describe('named selection digest', () => {
  it('never collides with a full or a mapped seal', () => {
    const logicalKeys = ['k-1'];
    const named = selectionDigestOf({ runner: 'vitest', mode: 'named-selection', logicalKeys });
    expect(named).not.toBe(selectionDigestOf({ runner: 'vitest', mode: 'full-relevant-suite', logicalKeys }));
    expect(named).not.toBe(selectionDigestOf({ runner: 'vitest', mode: 'mapped-selection', logicalKeys }));
    // Same mode, same keys: stable regardless of order or repetition.
    expect(named).toBe(selectionDigestOf({ runner: 'vitest', mode: 'named-selection', logicalKeys: ['k-1', 'k-1'] }));
  });
});
