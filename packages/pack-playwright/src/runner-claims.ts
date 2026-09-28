/**
 * The claim injections a supervised run writes for its runner children:
 * `<stateDir>/claim-injections.json` maps a runner reconciliation key
 * (`<repo-relative file>#<title path>`) to the obligation ids that test
 * is expected to prove.
 *
 * The runner-side halves (the pack's Vitest reporter, the Cypress
 * plugin) read it so the lifecycle event they spool carries the claims
 * the trusted CLI drain turns into witness finalize calls. A missing,
 * malformed, or partial document contributes NOTHING — never a guess.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAIM_INJECTIONS_FILE } from '@gate-forge/witness/constants';

/**
 * The obligation ids injected for one reconciliation key.
 *
 * Args:
 *   stateDir: the run-scoped state dir the CLI drain reads.
 *   logicalKey: the runner's `<file>#<title path>` key.
 *
 * Returns:
 *   string[]: the de-duplicated, sorted claim ids (empty when the
 *   document is absent, unreadable, or has no entry for the key).
 */
export function claimInjectionsFor(stateDir: string, logicalKey: string): string[] {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(join(stateDir, CLAIM_INJECTIONS_FILE), 'utf8'));
  } catch {
    return [];
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return [];
  const injections = (document as Record<string, unknown>)['injections'];
  if (typeof injections !== 'object' || injections === null || Array.isArray(injections)) return [];
  const claims = (injections as Record<string, unknown>)[logicalKey];
  if (!Array.isArray(claims)) return [];
  return [
    ...new Set(claims.filter((claim): claim is string => typeof claim === 'string' && claim !== '')),
  ].sort();
}
