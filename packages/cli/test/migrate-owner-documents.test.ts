/**
 * WP0 acceptance (plan §7 item 0): a 0.10.x repository that still carries
 * the four old owner-answer files.
 *
 * The properties, each observable:
 *
 * 1. every command refuses BY NAME and points at `gateforge migrate` —
 *    the strict load cannot even see the answers, so a repo that has not
 *    migrated gets a sentence that names the way out, not "unknown key";
 * 2. the preview writes NOTHING (byte-identical documents, old files
 *    intact);
 * 3. `--confirm` yields a `scan:` section in `.gateforge.yml` and the
 *    `planes:` / `endpoints:` sections in the answers document, and the
 *    four old files are GONE;
 * 4. the migrated repository LOADS and produces the same scanner policy it
 *    declared before the move — the answers survived the migration, they
 *    did not quietly change;
 * 5. the owner's own bytes survive: the comment above a moved key travels
 *    with it, and everything else in both documents is untouched;
 * 6. the trusted policy digest moves EXACTLY ONCE: re-pinning the migrated
 *    repository is enough, and a second migrate changes nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNER_ANSWERS_PATH, loadConfig, withTempRepo, type GateforgeConfig } from '@gate-forge/core';
import { parse as parseYaml } from 'yaml';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { MOVED_OWNER_DOCUMENTS } from '../src/moved-owner-documents.js';
import { configYml, installFixture, runCli } from './helpers.js';

/** The pre-0.11 answers document: the scanner keys sit at its top level. */
const PRE_MIGRATION_ANSWERS = `# Owner-reviewed policy. The reasons below ARE the review record.
# Do not reflow this file by hand.
schemaVersion: 1
scanRoots:
  - src/**/*.txt
# Only this detector may assert internality.
declarations:
  internality: 'gateforge:internal'
volatileFields:
  - updated_at
trustedInternalEntryPoints: []
internalRules: []
`;

const PRE_MIGRATION_PLANES = JSON.stringify(
  { rules: [{ match: 'src/accounts.txt', plane: 'tenant', reason: 'Owner-reviewed tenant data.' }] },
  null,
  2,
);

const PRE_MIGRATION_CLIENTS = JSON.stringify(
  { clientScanRoots: ['src/frontend'], serverScanRoots: ['src/api'] },
  null,
  2,
);

/** A repository exactly as 0.10.x left it: the old files, no `scan:`. */
function preMigrationRepo(repo: Parameters<typeof installFixture>[0]): void {
  installFixture(repo);
  repo.writeFiles({
    '.gateforge.yml': configYml().replace(/scan:\n(?:  .*\n)*/, ''),
    [OWNER_ANSWERS_PATH]: PRE_MIGRATION_ANSWERS,
    '.gateforge/planes.json': PRE_MIGRATION_PLANES,
    '.gateforge/http-clients.json': PRE_MIGRATION_CLIENTS,
  });
}

/** The scanner settings a repository's config declares right now. */
function scanOf(cwd: string): GateforgeConfig['scan'] {
  return loadConfig(join(cwd, '.gateforge.yml')).scan;
}

/** Every file under `.gateforge/` plus `.gateforge.yml`, as name -> bytes. */
function snapshotOf(cwd: string): Record<string, string> {
  const files: Record<string, string> = { '.gateforge.yml': readFileSync(join(cwd, '.gateforge.yml'), 'utf8') };
  for (const document of MOVED_OWNER_DOCUMENTS) {
    const absolute = join(cwd, ...document.path.split('/'));
    if (existsSync(absolute)) files[document.path] = readFileSync(absolute, 'utf8');
  }
  const answers = join(cwd, ...OWNER_ANSWERS_PATH.split('/'));
  if (existsSync(answers)) files[OWNER_ANSWERS_PATH] = readFileSync(answers, 'utf8');
  return files;
}

/**
 * `.gateforge.yml` with the inserted `scan:` block (and the blank line the
 * writer separated it with) cut out — the pre-migration bytes, so a test
 * can assert the migration only ever ADDED to that document.
 */
function withoutScanBlock(text: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf('scan:');
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end] ?? ''))) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n+$/, '\n');
}

describe('WP0 acceptance: a 0.10.x repository migrates to the consolidated documents', () => {
  it('refuses by name and points at gateforge migrate, from both refusals', async () => {
    await withTempRepo({}, async (repo) => {
      preMigrationRepo(repo);
      // First refusal: the config declares no `scan:` at all, so the load
      // fails before anything else is read. The message names the command
      // that fixes it instead of reporting "expected object, received
      // undefined" and leaving the owner with no next step.
      const check = await runCli(repo, ['check']);
      expect(check.code).toBe(2);
      expect(check.stderr).toContain('gateforge migrate');

      // Second refusal: a repository whose config DOES declare `scan:`
      // while the old files are still on disk is refused by file name, with
      // each file's new home. Silently ignoring them would silently drop
      // the owner's declarations.
      repo.writeFiles({ '.gateforge.yml': configYml() });
      const gates = await runCli(repo, ['test-gates']);
      expect(gates.code).toBe(2);
      expect(gates.stderr).toContain('gateforge migrate');
      for (const document of MOVED_OWNER_DOCUMENTS.filter((entry) =>
        existsSync(join(repo.root, ...entry.path.split('/'))),
      )) {
        expect(gates.stderr).toContain(document.path);
      }
    });
  });

  it('previews the exact change and writes nothing', async () => {
    await withTempRepo({}, async (repo) => {
      preMigrationRepo(repo);
      const before = snapshotOf(repo.root);

      const preview = await runCli(repo, ['migrate']);
      expect(preview.code).toBe(0);
      // One line per step, each naming the file that moves and its new home.
      expect(preview.stdout).toContain('scan:');
      expect(preview.stdout).toContain('`planes:` section');
      expect(preview.stdout).toContain('scan.httpClients');
      expect(preview.stdout).toContain('scanRoots');
      expect(preview.stdout).toContain('dry run only');
      // And the preview is a PREVIEW: not one byte moved.
      expect(snapshotOf(repo.root)).toEqual(before);
    });
  });

  it('--confirm writes the scan: and answers sections and deletes the old files', async () => {
    await withTempRepo({}, async (repo) => {
      preMigrationRepo(repo);

      const applied = await runCli(repo, ['migrate', '--confirm']);
      expect(applied.code).toBe(0);

      // The old files are gone: no command reads them anymore.
      for (const document of MOVED_OWNER_DOCUMENTS) {
        expect(existsSync(join(repo.root, ...document.path.split('/'))), document.path).toBe(false);
      }
      // The repository LOADS again, which it could not before.
      expect(() => loadConfig(join(repo.root, '.gateforge.yml'))).not.toThrow();
      const answers = parseYaml(readFileSync(join(repo.root, ...OWNER_ANSWERS_PATH.split('/')), 'utf8'));
      expect(answers.planes.rules[0].match).toBe('src/accounts.txt');
      expect(answers.scanRoots).toBeUndefined();
      expect(answers.declarations).toBeUndefined();
      expect(answers.volatileFields).toBeUndefined();
      expect(answers.trustedInternalEntryPoints).toEqual([]);
    });
  });

  it('the answers survive the migration unchanged', async () => {
    await withTempRepo({}, async (repo) => {
      preMigrationRepo(repo);

      expect((await runCli(repo, ['migrate', '--confirm'])).code).toBe(0);

      // The scanner settings the owner declared before the move are the
      // ones the migrated repository now validates: the migration MOVED the
      // bytes, it did not restate or reinterpret them.
      const scan = scanOf(repo.root);
      expect(scan.scanRoots).toEqual(['src/**/*.txt']);
      expect(scan.declarations).toEqual({ internality: 'gateforge:internal' });
      expect(scan.volatileFields).toEqual(['updated_at']);
      expect(scan.httpClients).toEqual({
        clientScanRoots: ['src/frontend'],
        serverScanRoots: ['src/api'],
      });
      // The plane answer reads back through the runtime's own strict parser.
      const answers = parseYaml(readFileSync(join(repo.root, ...OWNER_ANSWERS_PATH.split('/')), 'utf8'));
      expect(answers.planes.rules).toEqual([
        { match: 'src/accounts.txt', plane: 'tenant', reason: 'Owner-reviewed tenant data.' },
      ]);
    });
  });

  it('the owner bytes survive: the moved key keeps its comment, nothing else moves', async () => {
    await withTempRepo({}, async (repo) => {
      preMigrationRepo(repo);
      const answersBefore = readFileSync(join(repo.root, ...OWNER_ANSWERS_PATH.split('/')), 'utf8');
      const configBefore = readFileSync(join(repo.root, '.gateforge.yml'), 'utf8');

      expect((await runCli(repo, ['migrate', '--confirm'])).code).toBe(0);

      const answersAfter = readFileSync(join(repo.root, ...OWNER_ANSWERS_PATH.split('/')), 'utf8');
      const configAfter = readFileSync(join(repo.root, '.gateforge.yml'), 'utf8');
      // The comment that documented `declarations` travelled with it.
      expect(configAfter).toContain("# Only this detector may assert internality.");
      expect(answersAfter).not.toContain('Only this detector may assert internality');
      // The comment above the whole document is untouched.
      expect(answersAfter).toContain('# Owner-reviewed policy. The reasons below ARE the review record.');
      expect(answersAfter).toContain('# Do not reflow this file by hand.');
      // Every section the owner did not move is byte-identical, and so is
      // every byte of `.gateforge.yml` outside the inserted `scan:` block.
      expect(answersAfter).toContain('trustedInternalEntryPoints: []');
      expect(answersAfter).toContain('internalRules: []');
      expect(withoutScanBlock(configAfter).replace(/\n+$/, '')).toBe(configBefore.replace(/\n+$/, ''));
    });
  });

  it('the trusted policy digest moves exactly once, then stays put', async () => {
    await withTempRepo({}, async (repo) => {
      preMigrationRepo(repo);

      // Before the migration there is no digest a run could compute at all
      // (the config does not load), so the first comparable digest is the
      // migrated repository's.
      expect((await runCli(repo, ['migrate', '--confirm'])).code).toBe(0);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      const pinned = trustedPolicyDigestForConfig(repo.root, config);

      // Idempotent: a second migrate finds nothing, and the digest the
      // owner approved still matches.
      const again = await runCli(repo, ['migrate', '--confirm']);
      expect(again.stdout).toContain('nothing to migrate');
      expect(trustedPolicyDigestForConfig(repo.root, loadConfig(join(repo.root, '.gateforge.yml')))).toBe(pinned);
    });
  });

  it('a repository with nothing to migrate says so and exits 0', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['migrate']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('nothing to migrate');
    });
  });

  it('refuses a moved file whose bytes its new home would reject, writing nothing', async () => {
    await withTempRepo({}, async (repo) => {
      preMigrationRepo(repo);
      // No `reason` on a plane rule: the strict reader behind the `planes:`
      // section refuses it, so the migration refuses BEFORE writing.
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({ rules: [{ match: 'src/**', plane: 'tenant' }] }),
      });
      const before = snapshotOf(repo.root);

      const refused = await runCli(repo, ['migrate', '--confirm']);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('planes.json');
      expect(snapshotOf(repo.root)).toEqual(before);
    });
  });
});