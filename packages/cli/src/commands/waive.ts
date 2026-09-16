/**
 * `gateforge waive <resourceId:contract>`: write ONE schema-valid waiver
 * file into the configured waivers directory (ADR 0001 D4, GF-15).
 *
 * The command resolves the target through the REAL pipeline (the same
 * discovery → classification → policy run `obligations`/`check` uses), so
 * the waivered identity is never guessed: the obligation must exist TODAY
 * and its pin-#2 fingerprint ({resourceId, contract, policyId, lifecycle},
 * the exact hash baselines store) is computed from the resolved
 * obligation. An unknown resource/contract is a typed UsageError — a
 * waiver for an obligation that does not resolve would be a license with
 * no subject (fail closed).
 *
 * Deliberate limits (documented in the usage text):
 * - NO `--force` and NO overwrite: the file target
 *   `<waivers-dir>/<sanitized-resource>-<contract>.json` existing means a
 *   waiver is already on record — expiry/renewal is a HAND-EDIT of that
 *   file (or delete + re-run), keeping the exception under human review.
 * - All-or-nothing: after writing, the directory is re-loaded through the
 *   production `loadWaivers`; any load failure (duplicate exact scope,
 *   schema drift) deletes the just-written file and fails with the
 *   loader's error — the command can never leave a broken waivers
 *   directory behind.
 * - Expiry is judged against the INJECTED run clock (`pipeline.now`),
 *   never the wall clock (invariant 7, GF-16), so fixed-clock repos
 *   behave identically in tests and CI.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { jsonPathFor, loadWaivers, WaiverSchema, writeWaiver } from '@gateforge/core';
import { parseArgs, stringFlag } from '../args.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { obligationFingerprint } from '../evaluate.js';
import { resolveRepoPath, runPipeline } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';

export const WAIVE_USAGE =
  'usage: gateforge waive <resourceId:contract> --owner <name> --approver <name>\n' +
  '       --justification-url <url> --expires <ISO-date|datetime>\n' +
  '       Writes one exact-scope waiver (all five fields mandatory, GF-15) for the obligation\n' +
  "       the pipeline resolves from <resourceId:contract>. --expires accepts an ISO date\n" +
  '       (normalized to UTC midnight) or a full ISO datetime; it must be in the future.\n' +
  '       No --force: an existing waiver file is never overwritten — expiry/renewal is a\n' +
  '       hand-edit of that file (or delete it and re-run this command).\n' +
  '       Note: under enforcement.strictE2E a waiver is not proof — the obligation still blocks.';

/** Schema field → the flag that supplied it (for precise flag-level errors). */
const FIELD_TO_FLAG: Record<string, string> = {
  owner: 'owner',
  justificationUrl: 'justification-url',
  approver: 'approver',
  expiresAt: 'expires',
};

/** Flags the command accepts (plus the implicit `help`). */
const WAIVE_FLAGS = ['owner', 'approver', 'justification-url', 'expires', 'help'] as const;

/**
 * Deterministic waiver filename for one obligation:
 * `<sanitized-resourceId>-<sanitized-contract>.json`. There is no shared
 * slug helper in the codebase, so this is the convention: characters
 * outside `[A-Za-z0-9._-]` (the contract's interior colon included,
 * `crud:update` → `crud-update`) collapse to one dash; case is PRESERVED
 * (resource ids are case-sensitive, and lowercasing here could collide
 * two distinct ids onto one file — a silent overwrite risk). An id that
 * sanitizes to nothing is a usage error, never an empty filename.
 *
 * Args:
 *   resourceId: the obligation's resource id (no colons).
 *   contract: the obligation's contract (interior colons legal).
 *
 * Returns:
 *   string: basename of the waiver file.
 * @throws UsageError when no safe filename can be derived.
 */
function waiverFilename(resourceId: string, contract: string): string {
  const sanitize = (value: string): string =>
    value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const name = `${sanitize(resourceId)}-${sanitize(contract)}`;
  if (name === '-' || name.length === 0) {
    throw new UsageError(
      `waive: cannot derive a waiver filename from '${resourceId}:${contract}' — ` +
        'the id sanitizes to nothing; waive requires a resolvable obligation id',
    );
  }
  return `${name}.json`;
}

/**
 * Cheap close-match suggestions for an unresolvable target (the
 * `explain`-style "discovered:" listing): prefer obligations of the SAME
 * resource (a contract typo on the right resource), then obligations
 * sharing the contract (the right contract on the wrong resource).
 * Capped so a repo with hundreds of obligations still gets one readable
 * error line.
 *
 * Args:
 *   obligations: the pipeline's resolved obligations.
 *   resourceId: requested resource id.
 *   contract: requested contract.
 *
 * Returns:
 *   string[]: obligation ids to suggest (possibly empty).
 */
function closeMatches(
  obligations: readonly { id: string; resourceId: string; contract: string }[],
  resourceId: string,
  contract: string,
): string[] {
  const sameResource = obligations
    .filter((obligation) => obligation.resourceId === resourceId)
    .map((obligation) => obligation.id);
  const matches =
    sameResource.length > 0
      ? sameResource
      : obligations
          .filter((obligation) => obligation.contract === contract)
          .map((obligation) => obligation.id);
  return matches.slice(0, 8);
}

/**
 * Runs the waive subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 waiver written, 2 usage/validation/config.
 * @throws UsageError (exit 2) on any usage or fail-closed problem; other
 *   fail-closed engine errors (config/plugin/pipeline) propagate.
 */
export async function waiveCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, WAIVE_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, WAIVE_FLAGS, WAIVE_USAGE);
  const target = positionals[0];
  if (target === undefined || positionals.length > 1) {
    throw new UsageError(
      `waive requires exactly one <resourceId:contract> target (${WAIVE_USAGE})`,
    );
  }
  // Obligation-id grammar: split at the FIRST colon — resourceId never
  // contains one, the contract may (`crud:update`).
  const separator = target.indexOf(':');
  if (separator <= 0 || separator === target.length - 1) {
    throw new UsageError(
      `waive target must be '<resourceId:contract>' (ids split at the first colon), got '${target}' (${WAIVE_USAGE})`,
    );
  }
  const resourceId = target.slice(0, separator);
  const contract = target.slice(separator + 1);
  // All five waiver fields are mandatory (GF-15): four flags here, the
  // fifth (the exact scope) is derived from the resolved obligation so it
  // can never drift from the identity the engine actually grades.
  const owner = stringFlag(options, 'owner');
  const approver = stringFlag(options, 'approver');
  const justificationUrl = stringFlag(options, 'justification-url');
  const rawExpires = stringFlag(options, 'expires');
  const missing = (
    [
      ['owner', owner],
      ['approver', approver],
      ['justification-url', justificationUrl],
      ['expires', rawExpires],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([name]) => `'--${name}'`);
  if (missing.length > 0) {
    throw new UsageError(`waive requires ${missing.join(', ')} (${WAIVE_USAGE})`);
  }

  const config = loadConfigAt(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir: resolveStateDir(io.cwd),
  });
  // `pipeline.now` is the injected run instant — the ONLY time source for
  // expiry judgment (invariant 7 / GF-16); the wall clock never joins.
  const nowMs = Date.parse(pipeline.now);

  const obligation = pipeline.policy.obligations.find(
    (candidate) => candidate.resourceId === resourceId && candidate.contract === contract,
  );
  if (obligation === undefined) {
    const suggestions = closeMatches(pipeline.policy.obligations, resourceId, contract);
    throw new UsageError(
      `waive: no obligation resolves for '${resourceId}:${contract}'` +
        (suggestions.length > 0 ? ` — resolved obligations: ${suggestions.join(', ')}` : ''),
    );
  }
  // Pin-#2 fingerprint over the RESOLVED obligation (shared with
  // check/adopt) — the exact identity the verdict engine matches waivers on.
  const fingerprint = obligationFingerprint(obligation);

  // A bare date means UTC midnight of that day: the least-surprise
  // reading of `--expires 2027-01-01` (valid through the day before).
  // The chosen instant is printed verbatim in the summary, so the
  // normalization is reviewable, never silent. Anything else must
  // already be a schema-valid ISO datetime.
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const expiresAt =
    rawExpires !== undefined && DATE_ONLY.test(rawExpires)
      ? `${rawExpires}T00:00:00.000Z`
      : (rawExpires as string);

  // The schema is the authority (z.url(), 64-hex fingerprint, ISO
  // datetime, strict fields); the command validates BEFORE any write so
  // a bad flag never touches disk, and renders issues against the flag
  // that supplied the field.
  const candidate = {
    schemaVersion: 1 as const,
    owner: owner as string,
    justificationUrl: justificationUrl as string,
    approver: approver as string,
    scope: { kind: 'exact' as const, resourceId, fingerprint },
    expiresAt,
  };
  const parsed = WaiverSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const field = issue.path.join('.') || '<waiver>';
        const flag = FIELD_TO_FLAG[field];
        return flag !== undefined
          ? `--${flag}: ${issue.message}`
          : `${jsonPathFor(issue.path)}: ${issue.message}`;
      })
      .join('; ');
    throw new UsageError(`waive: waiver document is invalid — ${issues}`);
  }
  // Mirror the loader's expiry boundary (`now >= expiresAt` ⇒ expired):
  // creating an already-expired waiver would grade its obligation
  // `invalid` — blocking, and indistinguishable from a stale waiver
  // someone forgot — so the command rejects it up front.
  if (Date.parse(expiresAt) <= nowMs) {
    throw new UsageError(
      `waive: --expires '${expiresAt}' is not in the future (injected run clock: ${pipeline.now}) — ` +
        'a waiver that is expired at creation would block, not forgive',
    );
  }

  const waiversDir = resolveRepoPath(io.cwd, config.waivers);
  const filename = waiverFilename(resourceId, contract);
  const targetPath = join(waiversDir, filename);
  const repoRelative = `${config.waivers}/${filename}`;
  if (existsSync(targetPath)) {
    // Fail closed, no silent overwrite, no --force: the file on disk IS
    // the reviewable record; renewal edits it by hand.
    throw new UsageError(
      `waive: refusing to overwrite existing waiver file '${repoRelative}' — ` +
        'renew or expire it by hand-editing that file (or delete it and re-run this command); there is no --force',
    );
  }

  // The core writer (serializeBaseline house style: 2-space JSON +
  // trailing newline) is the ONLY programmatic waiver write.
  writeWaiver(targetPath, parsed.data);
  // All-or-nothing (fail closed): prove the new file loads cleanly
  // alongside the existing population through the PRODUCTION loader. Any
  // problem — above all a duplicate exact (resourceId, fingerprint)
  // scope — rolls the write back (only the file this command created is
  // removed) and surfaces the loader's own error.
  try {
    loadWaivers(waiversDir, { now: pipeline.now });
  } catch (error) {
    rmSync(targetPath, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(
      `waive: rolled back '${repoRelative}' — the waivers directory does not load cleanly: ${detail}`,
    );
  }

  const expiresMs = Date.parse(expiresAt);
  const remainingDays = Math.max(0, Math.ceil((expiresMs - nowMs) / 86_400_000));
  writeLine(io.stdout, `waiver written: ${repoRelative}`);
  writeLine(io.stdout, `  obligation: ${obligation.id} (policy '${obligation.policyId}')`);
  writeLine(io.stdout, `  fingerprint: ${fingerprint.slice(0, 12)} (${fingerprint})`);
  writeLine(io.stdout, `  owner: ${owner} / approver: ${approver}`);
  writeLine(io.stdout, `  justification: ${justificationUrl}`);
  writeLine(
    io.stdout,
    `  expires: ${expiresAt} (in ${remainingDays} day${remainingDays === 1 ? '' : 's'})`,
  );
  // Honest limits (plan §3.3, applyStrictE2E): under strict E2E mode the
  // verdict engine re-grades every waived verdict to blocking `missing`
  // (cause ENFORCEMENT_UNTRUSTED) — a waiver records an accepted risk, it
  // does not authorize a change. Printed unconditionally: the reminder is
  // cheap and the strict repo where it matters is exactly the one that
  // must not miss it.
  writeLine(
    io.stdout,
    'note: under enforcement.strictE2E this waiver does NOT authorize a change — the waived ' +
      "obligation is re-graded blocking 'missing' (ENFORCEMENT_UNTRUSTED) and still requires its " +
      'own witnessed evidence. Renewal: hand-edit this file or delete it and re-run the command.',
  );
  return 0;
}
