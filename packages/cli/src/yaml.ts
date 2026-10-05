/**
 * The shared fail-closed YAML reader and zod-issue formatter.
 *
 * Both live in their own module (not in `pipeline.ts`) so the modules
 * that read ONE owner document — `owner-answers.ts`, reached from
 * `route-plane-proposals.ts` for the `init` plane proposals — can reuse
 * them without importing the whole pipeline and closing an import cycle.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { jsonPathFor } from '@gate-forge/core';
import { UsageError } from './errors.js';

/** Reads a YAML document fail-closed (missing/unparsable → UsageError). */
export function loadYaml(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new UsageError(`cannot read ${label} file '${path}' (${code})`);
  }
  try {
    return parseYaml(raw);
  } catch (error) {
    throw new UsageError(
      `${label} file '${path}' is not valid YAML: ${(error as Error).message.split('\n')[0] ?? 'parse error'}`,
    );
  }
}

/** First zod issue as one actionable `path: message` line. */
export function firstIssueText(
  error: { issues?: Array<{ path: PropertyKey[]; message: string }> },
  fallback: string,
): string {
  const issue = error.issues?.[0];
  return issue === undefined ? fallback : `${jsonPathFor(issue.path)}: ${issue.message}`;
}
