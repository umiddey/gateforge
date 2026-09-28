import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';

const EXAMPLE_ROOT = fileURLToPath(new URL('../../../examples/alembic/', import.meta.url));
const adminUrl = process.env['GATEFORGE_ALEMBIC_TEST_ADMIN_URL'];

if (adminUrl === undefined || adminUrl.trim() === '') {
  console.warn(
    '[cli] Alembic setup e2e skipped: set GATEFORGE_ALEMBIC_TEST_ADMIN_URL to a disposable PostgreSQL admin URL ' +
      '(the engine runs `python3`, which needs Alembic, SQLAlchemy, and a PostgreSQL driver).',
  );
}

const postgres = adminUrl === undefined || adminUrl.trim() === '' ? describe.skip : describe;

/**
 * Copies the example Alembic app into a repository, untouched.
 *
 * Args:
 *   root: repository root to copy into.
 *
 * Returns:
 *   void: the repository now holds the example chain, models, and seed.
 */
function copyExample(root: string): void {
  cpSync(EXAMPLE_ROOT, root, {
    recursive: true,
    filter: (source) => {
      const path = relative(EXAMPLE_ROOT, source);
      return path === '' || !path.split(sep).some((part) => part === '.git' || part === 'node_modules');
    },
  });
}

/**
 * Turns the printed opt-in block into the configuration the owner would write.
 *
 * Args:
 *   printed: the `alembic-opt-in: begin` … `end` block `init` printed.
 *   scratchAdminUrl: trusted admin URL of the disposable instance.
 *
 * Returns:
 *   string: YAML body without the marker lines or comments.
 */
function enablePrintedOptIn(printed: string, scratchAdminUrl: string): string {
  const body = printed
    .split('\n')
    .filter((line) => !line.startsWith('alembic-opt-in:') && !line.trimStart().startsWith('#'))
    .join('\n');
  return body.replace(/adminUrl: .*/, `adminUrl: ${scratchAdminUrl}`);
}

/**
 * Collects the migration cause codes a command reported.
 *
 * Args:
 *   stdout: captured command output.
 *
 * Returns:
 *   string[]: unique `MIGRATION_*` codes in first-seen order.
 */
function migrationCauses(stdout: string): string[] {
  const codes = [...stdout.matchAll(/MIGRATION_[A-Z_]+/g)].map((match) => match[0]);
  return [...new Set(codes)];
}

/** One parsed `gateforge run:` summary line. */
interface RunSummary {
  /** Obligations the run compiled. */
  obligations: number;
  /** Obligations graded satisfied. */
  satisfied: number;
  /** Blocking findings the run reported. */
  blocking: number;
}

/**
 * Parses the `gateforge run:` summary line.
 *
 * Args:
 *   stdout: captured command output.
 *
 * Returns:
 *   RunSummary: counts, or zeroes when the line is absent.
 */
function runSummary(stdout: string): RunSummary {
  const match = /gateforge run: (\d+) obligation\(s\) — (\d+) satisfied, \d+ waived, (\d+) blocking/.exec(stdout);
  return {
    obligations: Number(match?.[1] ?? 0),
    satisfied: Number(match?.[2] ?? 0),
    blocking: Number(match?.[3] ?? 0),
  };
}

postgres('Alembic setup from init to green on a fresh copy', () => {
  it('prints the opt-in, adds nothing until it is enabled, then witnesses the chain and names causes', async () => {
    await withTempRepo({}, async (repo) => {
      copyExample(repo.root);
      repo.writeFiles({
      'models.py': readFileSync(join(repo.root, 'models.py'), 'utf8'),
      'alembic.ini': readFileSync(join(repo.root, 'alembic.ini'), 'utf8'),
      });
      const init = await runCli(repo, ['init', '--no-ci', '--no-blocking']);
      expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
      expect(init.stdout).toContain('alembic detected: alembic.ini');
      expect(init.stdout).toContain('alembic-opt-in: begin');
      expect(init.stdout).toContain('migrations/versions');
      expect(init.stdout).toContain('command: gateforge check');
      expect(readFileSync(join(repo.root, '.gateforge.yml'), 'utf8')).not.toContain('alembic:');

      // Without the printed block the pack is absent: no obligation, no database work.
      const untouched = await runCli(repo, ['check']);
      const before = runSummary(untouched.stdout);
      expect(before.obligations).toBe(0);
      expect(before.satisfied).toBe(0);
      expect(migrationCauses(untouched.stdout)).toEqual([]);
      expect(untouched.stdout).not.toContain('alembic:');

      const lines = init.stdout.split('\n');
      const start = lines.indexOf('alembic-opt-in: begin');
      const printed = lines.slice(start, lines.indexOf('alembic-opt-in: end')).join('\n');
      const config = readFileSync(join(repo.root, '.gateforge.yml'), 'utf8');
      writeFileSync(join(repo.root, '.gateforge.yml'), `${config}\n${enablePrintedOptIn(printed, adminUrl as string)}\n`);

      // The honest example chain is witnessed green and adds no new finding.
      const check = await runCli(repo, ['check']);
      const after = runSummary(check.stdout);
      expect(after.obligations).toBeGreaterThanOrEqual(2);
      expect(after.satisfied).toBe(after.obligations);
      expect(after.blocking).toBe(before.blocking);
      expect(migrationCauses(check.stdout)).toEqual([]);
      const next = await runCli(repo, ['next']);
      expect(migrationCauses(next.stdout)).toEqual([]);

      repo.writeFiles({
        'models.py': `${readFileSync(join(repo.root, 'models.py'), 'utf8')}\nInvoice.__table__.append_column(Column('unmapped_field', String, nullable=True))\n`,
      });
      const broken = await runCli(repo, ['check']);
      expect(runSummary(broken.stdout).blocking).toBeGreaterThan(before.blocking);
      expect(migrationCauses(broken.stdout)).toContain('MIGRATION_DRIFT');
      const brokenNext = await runCli(repo, ['next']);
      expect(brokenNext.code).toBe(1);
      expect(migrationCauses(brokenNext.stdout)).toContain('MIGRATION_DRIFT');
    });
  }, 120_000);
});
