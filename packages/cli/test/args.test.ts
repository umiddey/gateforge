/**
 * CLI arg parsing: options, positionals, repeats, string flags.
 */
import { describe, expect, it } from 'vitest';
import { parseArgs, stringFlag } from '../src/args.js';
import { parseRunTimeoutMin } from '../src/commands/test-gates.js';
import { UsageError } from '../src/errors.js';

describe('parseArgs', () => {
  it('parses booleans, values, and equals forms', () => {
    const parsed = parseArgs(['--changed', '--format', 'json', '--out=dir/x']);
    expect(parsed.options).toEqual({ changed: true, format: 'json', out: 'dir/x' });
    expect(parsed.positionals).toEqual([]);
  });

  it('collects positionals and stops flag parsing at --', () => {
    const parsed = parseArgs(['baseline', 'update', '--', '--not-a-flag']);
    expect(parsed.positionals).toEqual(['baseline', 'update', '--not-a-flag']);
  });

  it('turns repeated string flags into arrays and stringFlag rejects them', () => {
    const parsed = parseArgs(['--tag', 'a', '--tag', 'b']);
    expect(parsed.options['tag']).toEqual(['a', 'b']);
    expect(() => stringFlag(parsed.options, 'tag')).toThrow(/may only be given once/);
  });

  it('rejects a missing flag value', () => {
    expect(() => parseArgs(['--format'])).toThrow(/requires a value/);
  });
});

describe('parseRunTimeoutMin (--run-timeout-min)', () => {
  it('absent flag keeps the 30-minute default bound', () => {
    expect(parseRunTimeoutMin(undefined)).toBeUndefined();
  });

  it('converts whole minutes to milliseconds', () => {
    expect(parseRunTimeoutMin('30')).toBe(1_800_000);
    expect(parseRunTimeoutMin('720')).toBe(43_200_000);
    expect(parseRunTimeoutMin('2880')).toBe(172_800_000);
  });

  it('rejects non-integer, non-positive, and overflowing values', () => {
    for (const raw of ['0', '-5', 'abc', '1.5', '', '   ', '2881', '999999999']) {
      expect(() => parseRunTimeoutMin(raw), `raw='${raw}'`).toThrow(UsageError);
    }
  });

  it('parses through the real argv shape', () => {
    const parsed = parseArgs(['--changed', '--run-timeout-min', '720']);
    expect(parseRunTimeoutMin(stringFlag(parsed.options, 'run-timeout-min'))).toBe(43_200_000);
  });
});