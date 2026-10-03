/**
 * `gateforge quarantine <testKey>`: write ONE owner-approved, always
 * expiring flaky-test quarantine.
 *
 * The trust pattern is the waiver's: the
 * owner (and a named approver) state the reason, the document always
 * expires (14 days maximum), and there is no `--force` — an existing
 * file is the reviewable record and is never silently overwritten.
 *
 * What a quarantine is NOT, printed on every write:
 * - it is not proof: the quarantined test leaves the required set
 *   before the run, and an obligation only it covered stays `missing`;
 * - it never blocks: nothing about a flake can fail the gate;
 * - it is not the agent's tool: only the owner can write one, and the
 *   file lives inside the pinned trusted policy, so an agent-authored
 *   quarantine is a policy change that blocks until the owner repins.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadQuarantines,
  QuarantineSchema,
  QUARANTINE_DIR,
  QUARANTINE_MAX_DAYS,
  QUARANTINE_MAX_DURATION_MS,
  writeQuarantine,
} from '@gate-forge/core';
import { discoverTestCatalog } from '@gate-forge/pack-playwright';
import { parseArgs, stringFlag } from '../args.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { resolveStateDir } from '../state.js';
import { engineGeneratedStateFileFilter } from '../state-artifacts.js';
import { resolveRepoPath, runPipeline } from '../pipeline.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';

export const QUARANTINE_USAGE =
  'usage: gateforge quarantine <testKey> --owner <name> --approver <name>\n' +
  '       --reason "why it is flaky" --expires <ISO-date|datetime>\n' +
  `       Writes ONE owner-approved quarantine (all four fields mandatory) for the test the\n` +
  '       catalog reports under <testKey> (`<runner>:<project>:<file>:<title path>`, as printed\n' +
  '       by `gateforge tests discover`). It REMOVES that test from the\n' +
  `       required set for at most ${String(QUARANTINE_MAX_DAYS)} days. --expires accepts an ISO date\n` +
  '       (normalized to UTC midnight) or a full ISO datetime; it must be in the future and no\n' +
  `       further than ${String(QUARANTINE_MAX_DAYS)} days out.\n` +
  '       A quarantined test NEVER proves anything (an obligation only it covered stays missing)\n' +
  '       and NEVER blocks. An expired quarantine is ignored and BLOCKS until it is renewed or\n' +
  '       deleted. No --force: renewal is a hand-edit of that file (or delete it and re-run).\n' +
  '       The file is part of the pinned trusted policy — an agent cannot write one.';

/** Flags the command accepts (plus the implicit `help`). */
const QUARANTINE_FLAGS = ['owner', 'approver', 'reason', 'expires', 'help'] as const;

/**
 * Deterministic quarantine filename for one test key: a filesystem-safe,
 * collision-free slug of the exact test identity.
 *
 * Args:
 *   testKey: the test's logical key (`<file>#<title path>`).
 *
 * Returns:
 *   string: the basename (no extension) written under the quarantine dir.
 */
function quarantineFilename(testKey: string): string {
  const slug = testKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug}-${Buffer.from(testKey, 'utf8').toString('hex').slice(0, 16)}.yml`;
}

/**
 * Cheap close-match suggestions for an unresolvable test key, so a typo
 * never leaves the owner hunting for the right identity by hand.
 *
 * Args:
 *   known: every catalog logical key in the repository.
 *   testKey: the requested (unresolvable) key.
 *
 * Returns:
 *   string[]: up to five known keys that share a prefix or suffix.
 */
function closeMatches(known: readonly string[], testKey: string): string[] {
  const needle = testKey.toLowerCase();
  return known
    .filter((candidate) => {
      const haystack = candidate.toLowerCase();
      return haystack.includes(needle) || needle.includes(haystack) || haystack.split('#')[0] === testKey.split('#')[0];
    })
    .slice(0, 5);
}

/**
 * Runs the quarantine subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 quarantine written, 2 usage/validation/config.
 * @throws UsageError (exit 2) on any usage or fail-closed problem; other
 *   fail-closed engine errors (config/pipeline) propagate.
 */
export async function quarantineCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, QUARANTINE_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, QUARANTINE_FLAGS, QUARANTINE_USAGE);
  const testKey = positionals[0];
  if (testKey === undefined || positionals.length > 1) {
    throw new UsageError(`quarantine requires exactly one <testKey> target (${QUARANTINE_USAGE})`);
  }
  const owner = stringFlag(options, 'owner');
  const approver = stringFlag(options, 'approver');
  const reason = stringFlag(options, 'reason');
  const rawExpires = stringFlag(options, 'expires');
  const missing = (
    [
      ['owner', owner],
      ['approver', approver],
      ['reason', reason],
      ['expires', rawExpires],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([name]) => `'--${name}'`);
  if (missing.length > 0) {
    throw new UsageError(`quarantine requires ${missing.join(', ')} (${QUARANTINE_USAGE})`);
  }

  const config = loadConfigAt(io.cwd);
  const stateDir = resolveStateDir(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir,
  });
  // `pipeline.now` is the injected run instant — the ONLY time source for
  // expiry judgment (invariant 7); the wall clock never joins.
  const nowMs = Date.parse(pipeline.now);

  // The key must name a test the catalog ACTUALLY reports: a quarantine
  // for a typo would silently never apply, which is worse than an error.
  let catalogKeys: string[];
  try {
    const discovered = await discoverTestCatalog({
      cwd: io.cwd,
      config,
      excludeFile: engineGeneratedStateFileFilter(io.cwd, stateDir),
    });
    catalogKeys = discovered.catalog.entries.map((entry) => entry.logicalKey);
  } catch (error) {
    // Fail closed with the OWN action: a quarantine may only name a test
    // the catalog actually reports, so an unresolvable inventory is a
    // setup problem the owner must fix first.
    throw new UsageError(
      `quarantine: the test catalog could not be enumerated (${
        (error as Error).message.split('\n')[0] ?? 'unknown'
      }); fix the runner setup (gateforge tests discover) before quarantining a test`,
    );
  }
  if (!catalogKeys.includes(testKey)) {
    const suggestions = closeMatches(catalogKeys, testKey);
    throw new UsageError(
      `quarantine: no test resolves for '${testKey}'` +
        (suggestions.length > 0 ? ` — catalog tests: ${suggestions.join(', ')}` : ' (run `gateforge tests discover`)'),
    );
  }

  // A bare date means UTC midnight of that day (waiver convention), and
  // the normalization is printed verbatim, never silent.
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const expiresAt =
    rawExpires !== undefined && DATE_ONLY.test(rawExpires)
      ? `${rawExpires}T00:00:00.000Z`
      : (rawExpires as string);

  const candidate = {
    schemaVersion: 1 as const,
    testKey,
    owner: owner as string,
    approver: approver as string,
    reason: reason as string,
    expiresAt,
  };
  const parsed = QuarantineSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<quarantine>'}: ${issue.message}`)
      .join('; ');
    throw new UsageError(`quarantine: quarantine document is invalid — ${issues}`);
  }
  if (Date.parse(expiresAt) <= nowMs) {
    throw new UsageError(
      `quarantine: --expires '${expiresAt}' is not in the future (injected run clock: ${pipeline.now}) — ` +
        'a quarantine that is expired at creation would block, not forgive',
    );
  }
  if (Date.parse(expiresAt) - nowMs > QUARANTINE_MAX_DURATION_MS) {
    throw new UsageError(
      `quarantine: --expires '${expiresAt}' is more than ${String(QUARANTINE_MAX_DAYS)} days out — ` +
        'a quarantine always expires; shorten it and renew it',
    );
  }

  const quarantineDir = resolveRepoPath(io.cwd, QUARANTINE_DIR);
  const filename = quarantineFilename(testKey);
  const targetPath = join(quarantineDir, filename);
  const repoRelative = `${QUARANTINE_DIR}/${filename}`;
  if (existsSync(targetPath)) {
    throw new UsageError(
      `quarantine: refusing to overwrite existing quarantine file '${repoRelative}' — ` +
        'renew or delete it by hand-editing that file (or delete it and re-run this command); there is no --force',
    );
  }

  writeQuarantine(targetPath, parsed.data);
  // All-or-nothing (fail closed): prove the new file loads cleanly
  // alongside the existing population through the PRODUCTION loader; any
  // problem rolls back only the file this command created.
  try {
    loadQuarantines(quarantineDir, { now: pipeline.now });
  } catch (error) {
    rmSync(targetPath, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(
      `quarantine: rolled back '${repoRelative}' — the quarantine directory does not load cleanly: ${detail}`,
    );
  }

  const remainingDays = Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 86_400_000));
  writeLine(io.stdout, `quarantine written: ${repoRelative}`);
  writeLine(io.stdout, `  test: ${testKey}`);
  writeLine(io.stdout, `  owner: ${owner} / approver: ${approver}`);
  writeLine(io.stdout, `  reason: ${reason}`);
  writeLine(
    io.stdout,
    `  expires: ${expiresAt} (in ${String(remainingDays)} day${remainingDays === 1 ? '' : 's'})`,
  );
  writeLine(
    io.stdout,
    'note: this test is removed from the required set and its evidence is never used — an obligation ' +
      'only it covered stays unproven. It never blocks. After the expiry the quarantine BLOCKS until it ' +
      'is renewed or deleted, and the file is part of the pinned trusted policy (an agent cannot write one).',
  );
  return 0;
}
