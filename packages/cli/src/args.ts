/**
 * Minimal dependency-free argv parser.
 *
 * Supports `--flag`, `--flag=value`, `--flag value` (boolean flags do
 * not consume the next token), repeated string flags, and positional
 * arguments. `--` stops flag parsing. No flag abbreviations.
 */
import { UsageError } from './errors.js';

export interface ParsedArgs {
  /** Map of flag name (without `--`) to value (true for bare flags). */
  options: Record<string, string | boolean | string[]>;
  /** Positional arguments after flag parsing. */
  positionals: string[];
}

/** Flags that carry no value (bare presence). */
const BOOLEAN_FLAGS = new Set(['json', 'changed', 'staged', 'help', 'version', 'blocking', 'no-blocking', 'strict-e2e', 'pytest', 'require-e2e', 'pre-commit', 'no-pre-commit', 'ci', 'no-ci']);

/**
 * Parses argv (without node/script) into options + positionals.
 *
 * Args:
 *   argv: argument vector from the command line.
 *
 * Returns:
 *   ParsedArgs: option map + positionals.
 * @throws UsageError on an unknown flag shape or a missing flag value.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  let afterDoubleDash = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (afterDoubleDash) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!token.startsWith('--') || token === '-') {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined;
    if (name.length === 0) {
      throw new UsageError(`invalid flag '${token}'`);
    }
    let value: string | boolean;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (BOOLEAN_FLAGS.has(name)) {
      value = true;
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`flag '--${name}' requires a value`);
      }
      value = next;
      index += 1;
    }
    const existing = options[name];
    if (existing === undefined) {
      options[name] = value;
    } else if (typeof existing === 'string' && typeof value === 'string') {
      options[name] = [existing, value];
    } else {
      options[name] = [String(existing), String(value)];
    }
  }
  return { options, positionals };
}

/**
 * Reads a string flag value; repeated occurrences are an error (callers
 * that accept repeats read the array form themselves).
 *
 * Args:
 *   options: parsed options.
 *   name: flag name.
 *
 * Returns:
 *   string | undefined: the value, or undefined when the flag is absent.
 * @throws UsageError when the flag was repeated.
 */
export function stringFlag(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  if (typeof value !== 'string') {
    if (Array.isArray(value)) {
      throw new UsageError(`flag '--${name}' may only be given once`);
    }
    return undefined;
  }
  return value;
}