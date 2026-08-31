/**
 * CLI arg parsing: options, positionals, repeats, string flags.
 */
import { describe, expect, it } from 'vitest';
import { parseArgs, stringFlag } from '../src/args.js';

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