/**
 * `check --staged` evaluates the STAGED bytes for IN-PROCESS packs whose
 * detector captures the repository root (findings problem 33).
 *
 * The staged candidate checkout IS the gated repository for the run:
 * `check --staged` materializes it and moves the process cwd into it
 * before discovery, because in-process plugins resolve repo-relative paths
 * against the process cwd (the pinned `discover(paths)` contract). A pack
 * whose default export is `createXDetector()` evaluated at MODULE IMPORT —
 * the CLI imports `@gate-forge/pack-fastapi` statically at startup, long
 * before the chdir — captured the root at factory time and therefore read
 * the user's WORKING TREE.
 *
 * The repro, end to end: a FastAPI route committed at HEAD, a DIFFERENT
 * valid route staged, and a syntax-broken working-tree copy. The gate must
 * report the STAGED route and never the broken working-tree bytes.
 *
 * Red/green: on the factory-time-capture detector this test FAILS — the
 * working-tree `PARSE_ERROR` reaches the report and `/beta` is missing,
 * because the pack's pinned root is the loader's cwd, not the candidate
 * checkout.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';

/** A FastAPI module serving `routePath`. */
function fastapiModule(routePath: string): string {
  return [
    'from fastapi import FastAPI',
    '',
    'app = FastAPI()',
    '',
    '',
    `@app.get("${routePath}")`,
    'def handler() -> dict:',
    '    return {"ok": True}',
    '',
  ].join('\n');
}

/** The same module with a syntax error at line 7 (`@app.get("/beta"`). */
const BROKEN_MODULE = [
  'from fastapi import FastAPI',
  '',
  'app = FastAPI()',
  '',
  '',
  '@app.get("/beta"',
  'def handler( -> dict',
  '    return {"ok": True}',
  '',
].join('\n');

const CONFIG = `schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ['**/*.py']
    exclude: []
plugins:
  - id: gateforge.pack-fastapi
    version: '0.1.0'
    transport: in-process
    module: '@gate-forge/pack-fastapi'
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
`;

const POLICIES = `schemaVersion: 1
policies:
  - id: persistence
    when: { exposure: user-facing }
    require: [persistence:read]
`;

const CLASSIFICATION_POLICY = `schemaVersion: 1
scanRoots: ['**/*.py']
trustedInternalEntryPoints: []
internalRules: []
coverage: []
declarations: {}
volatileFields: []
`;

describe('check --staged gates the staged bytes for an in-process pack', () => {
  it('reads the STAGED route, never the syntax-broken working-tree copy', () =>
    withTempRepo({}, async (repo) => {
      // The REAL pack is already imported by the time this test runs (the
      // CLI imports it statically), so its default-export detector exists
      // exactly as in production — created long before the staged chdir.
      repo.writeFiles({
        '.gitignore': '.gateforge/test-gates/\n',
        '.gateforge.yml': CONFIG,
        '.gateforge/policies.yml': POLICIES,
        '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY,
        'app/main.py': fastapiModule('/alpha'),
      });
      repo.stage();
      repo.commit('base route');

      // STAGED: a different, VALID route. WORKTREE: a syntax-broken copy of
      // the same file. Two candidates, one index.
      repo.writeFiles({ 'app/main.py': fastapiModule('/beta') });
      repo.stage(['app/main.py']);
      repo.writeFiles({ 'app/main.py': BROKEN_MODULE });
      expect(repo.git(['status', '--porcelain']).stdout.trim()).toBe('MM app/main.py');

      const result = await runCli(repo, ['check', '--staged']);

      // The gated bytes are the STAGED ones: exactly one endpoint, served
      // by the staged module, and no trace of the working tree's bytes.
      expect(result.stdout).toContain('endpoint inventory (1):');
      expect(result.stdout).toContain('GET /beta');
      expect(result.stdout).toContain('route=app/main.py:6');
      expect(result.stdout).not.toContain('PARSE_ERROR');
      // The committed route belongs to HEAD, which the candidate replaces —
      // proof the gate graded the staged file, not the base commit.
      expect(result.stdout).not.toContain('/alpha');
      // The unstaged working-tree copy is untouched: the gate never wrote
      // to the user's index or worktree.
      expect(repo.git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('app/main.py');
      expect(repo.git(['status', '--porcelain']).stdout.trim()).toBe('MM app/main.py');
    }));
});