/**
 * Gitignored files are not scanned (owner decision D5, release 0.9.0).
 *
 * The bug this pins: a consumer working copy held `playwright-report/`
 * (minified trace-viewer bundles) and `playwright-report-e2e/`, both
 * gitignored. The scan walked them like committed code, so every
 * minified call became detector evidence — 414 bogus
 * `FRONTEND_CALL_TARGET_UNRESOLVED` entries the owner then had to
 * `adopt` away — while a clean clone of the same commit produced none.
 *
 * One test per property: the ignored tree leaves the scan and comes
 * back when the ignore rule goes; a TRACKED file is scanned even when
 * an ignore pattern matches it (git's own semantics); a nested
 * `.gitignore` counts; the operator's global excludes file does NOT;
 * and a directory that is not a git repository scans exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import { expandScanPaths } from '../src/glob.js';
import { gitIgnoredPaths } from '../src/git-ignored.js';

/** A JS file whose `fetch` target cannot be resolved statically. */
const REPORT_BUNDLE = [
  'const trace = window.__trace;',
  'export function report() { return fetch(trace.url); }',
  '',
].join('\n');

/**
 * A repository whose only source is the report bundle, plus a
 * gateforge config whose include globs match it. Pack-http is the real
 * detector, so the assertions are about evidence, not about the walk.
 */
async function installReportRepo(repo: TempRepo): Promise<void> {
  const httpPack = join(process.cwd(), 'packages/pack-http/src/index.ts');
  repo.writeFiles({
    '.gateforge.yml': `schemaVersion: 1
project:
  languages: [javascript]
  paths:
    include: ['**/*.js']
    exclude: []
plugins:
  - id: gateforge.pack-http
    version: '0.1.0'
    transport: in-process
    module: ${httpPack}
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`,
    '.gateforge/policies.yml':
      'schemaVersion: 1\npolicies:\n  - id: persistence\n    when: { exposure: user-facing }\n    require: [persistence:read]\n',
    '.gateforge/classification-policy.yml':
      "schemaVersion: 1\nscanRoots: ['**/*.js']\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations: {}\nvolatileFields: []\n",
    'report/trace-viewer.js': REPORT_BUNDLE,
  });
}

/** Every unresolved entry's file, from a `discover --json` document. */
function unresolvedFiles(stdout: string): string[] {
  const graph = JSON.parse(stdout) as {
    unresolved: Array<{ reason: { location: { file: string } } }>;
  };
  return graph.unresolved.map((entry) => entry.reason.location.file);
}

describe('gitignored files are not scanned (D5)', () => {
  it('a gitignored report folder produces no unresolved entries, and the same file does once un-ignored', async () => {
    await withTempRepo({}, async (repo) => {
      await installReportRepo(repo);
      // The ignore rule is the ONLY difference between the two runs.
      repo.writeFiles({ '.gitignore': 'report/\n' });
      const ignored = await runCli(repo, ['discover', '--json']);
      expect(ignored.code, `${ignored.stdout}\n${ignored.stderr}`).toBe(0);
      // Before the fix this list named report/trace-viewer.js.
      expect(unresolvedFiles(ignored.stdout)).toEqual([]);

      repo.writeFiles({ '.gitignore': '' });
      const scanned = await runCli(repo, ['discover', '--json']);
      expect(scanned.code, `${scanned.stdout}\n${scanned.stderr}`).toBe(0);
      expect(unresolvedFiles(scanned.stdout)).toEqual(['report/trace-viewer.js']);
    });
  });

  it('a TRACKED file matching an ignore pattern is still scanned (git semantics)', () => {
    withTempRepo({}, (repo) => {
      // Committed FIRST, then ignored: `git ls-files --others` never
      // reports a tracked path, so the pattern cannot drop it.
      repo.commitFiles({ 'src/committed.js': REPORT_BUNDLE }, 'committed source');
      repo.writeFiles({ '.gitignore': 'src/committed.js\n' });
      expect(expandScanPaths(['**/*.js'], [], repo.root, gitIgnoredPaths(repo.root))).toEqual([
        'src/committed.js',
      ]);
    });
  });

  it('honours a .gitignore nested in a subfolder', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        'frontend/.gitignore': 'generated/\n',
        'frontend/generated/client.js': REPORT_BUNDLE,
        'frontend/src/app.js': REPORT_BUNDLE,
      });
      expect(expandScanPaths(['**/*.js'], [], repo.root, gitIgnoredPaths(repo.root))).toEqual([
        'frontend/src/app.js',
      ]);
    });
  });

  it('ignores the operator global excludes file, so results do not depend on the machine', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        'frontend/.gitignore': 'generated/\n',
        'frontend/generated/client.js': REPORT_BUNDLE,
        'frontend/src/app.js': REPORT_BUNDLE,
      });
      const withoutGlobal = expandScanPaths(['**/*.js'], [], repo.root, gitIgnoredPaths(repo.root));

      // A global excludes file that would hide EVERYTHING if it
      // counted; `-c core.excludesFile=` must defeat it.
      const scratch = mkdtempSync(join(tmpdir(), 'gateforge-global-excludes-'));
      const excludes = join(scratch, 'excludes');
      const config = join(scratch, 'gitconfig');
      writeFileSync(excludes, 'frontend/\n', 'utf8');
      writeFileSync(config, `[core]\n\texcludesFile = ${excludes}\n`, 'utf8');
      const previous = process.env['GIT_CONFIG_GLOBAL'];
      process.env['GIT_CONFIG_GLOBAL'] = config;
      let withGlobal: string[];
      try {
        withGlobal = expandScanPaths(['**/*.js'], [], repo.root, gitIgnoredPaths(repo.root));
      } finally {
        if (previous === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
        else process.env['GIT_CONFIG_GLOBAL'] = previous;
        rmSync(scratch, { recursive: true, force: true });
      }
      expect(withGlobal).toEqual(withoutGlobal);
      expect(withGlobal).toEqual(['frontend/src/app.js']);
    });
  });

  it('scans exactly as before outside a git work tree (unknown, nothing skipped)', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-not-a-repo-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.js'), '', 'utf8');
    try {
      const scope = gitIgnoredPaths(root);
      expect(scope.known).toBe(false);
      expect(expandScanPaths(['**/*.js'], [], root, scope)).toEqual(['src/app.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});