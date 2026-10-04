/**
 * The pack configs are OWNER-PINNED POLICY INPUTS (0.10.2, task 3).
 *
 * `.gateforge/http-clients.json` (and `planes.json`, `endpoints.json`,
 * `fastapi.json`) are classified `pack-config`, which under `strictE2E`
 * means exactly two things: they can never be `CHANGE_UNMAPPED`, and
 * they can never expand the evaluation scope. Both hold only while the
 * owner-approved policy digest actually binds their bytes — a candidate
 * that narrows `clientScanRoots` in the same commit it deletes an
 * obligation with otherwise had nothing to catch it: the obligation left
 * the graph, the file was excused as policy-owned, and the pin matched.
 *
 * The honest cost is a re-pin, so the constraint is stated here too: a
 * repository with NO pack config contributes NO entry and NO absence
 * marker — its digest is byte-identical to what it was before this fix.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@gate-forge/core';
import { PLUGIN_SOURCE, configYml } from './helpers.js';
import { evaluateApprovedPolicy, resolveApprovedPolicyDigest } from '../src/trusted-policy.js';
import { trustedPolicyDigestEntriesForConfig, trustedPolicyDigestForConfig } from '../src/execution.js';
import { PACK_CONFIGS } from '../src/input-snapshot.js';

const DIRECTORIES: string[] = [];

afterEach(() => {
  for (const dir of DIRECTORIES.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes a file tree (repo-relative posix keys) into a temp directory. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [key, content] of Object.entries(files)) {
    const absolute = join(root, ...key.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

/** A temp repository root with the fixture's plugin and policy documents. */
function tempRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-packconfig-'));
  DIRECTORIES.push(dir);
  writeTree(dir, {
    '.gateforge.yml': configYml(),
    '.gateforge/policies.yml': 'schemaVersion: 1\npolicies: []\n',
    '.gateforge/classification-policy.yml': 'schemaVersion: 1\nscanRoots: []\n',
    'plugin.mjs': PLUGIN_SOURCE,
    ...files,
  });
  return dir;
}

/** The approved revision the owner pinned for `cwd`. */
function digestOf(cwd: string): string {
  return trustedPolicyDigestForConfig(cwd, loadConfig(join(cwd, '.gateforge.yml')));
}

/** A loopback base URL, assembled rather than written out. */
function loopback(): string {
  return `http://${[127, 0, 0, 1].join('.')}:8080`;
}

const WIDE_CLIENTS = JSON.stringify(
  { schemaVersion: 1, clients: [{ id: 'accounts', baseUrl: loopback(), clientScanRoots: ['src/accounts'] }] },
  null,
  2,
);

const NARROWED_CLIENTS = JSON.stringify(
  { schemaVersion: 1, clients: [{ id: 'accounts', baseUrl: loopback(), clientScanRoots: [] }] },
  null,
  2,
);

describe('pack configs are owner-pinned policy inputs', () => {
  it('narrowing a client scan root changes the approved revision and the gate refuses', () => {
    // The measured gap: `clientScanRoots` decides which files become
    // obligations, so a same-commit narrowing deletes obligations. While
    // the approved revision does not move, nothing blocks it.
    const cwd = tempRepo({ '.gateforge/http-clients.json': WIDE_CLIENTS });
    const approved = digestOf(cwd);

    writeTree(cwd, { '.gateforge/http-clients.json': NARROWED_CLIENTS });

    expect(digestOf(cwd)).not.toBe(approved);
    const gate = evaluateApprovedPolicy(
      resolveApprovedPolicyDigest({
        flag: approved,
        env: {},
        candidateCwd: cwd,
        candidateConfig: loadConfig(join(cwd, '.gateforge.yml')),
      }),
      digestOf(cwd),
      true,
    );
    expect(gate.status).toBe('blocked');
    expect(gate.status === 'blocked' ? gate.cause : '').toBe('ENFORCEMENT_UNTRUSTED');
  });

  it('every declared pack config is bound, not only the client one', () => {
    for (const relative of PACK_CONFIGS) {
      const cwd = tempRepo({ [relative]: JSON.stringify({ schemaVersion: 1 }) });
      const approved = digestOf(cwd);
      writeTree(cwd, { [relative]: JSON.stringify({ schemaVersion: 1, edited: true }) });
      expect(digestOf(cwd), relative).not.toBe(approved);
    }
  });

  it('a repository with no pack config keeps a byte-identical digest (no entry, no marker)', () => {
    const cwd = tempRepo();
    const names = trustedPolicyDigestEntriesForConfig(cwd, loadConfig(join(cwd, '.gateforge.yml'))).map(
      (entry) => entry.name,
    );
    for (const relative of PACK_CONFIGS) {
      expect(names).not.toContain(relative);
    }
    // Two otherwise identical repositories: only the pack config itself
    // may move the revision.
    const withPack = tempRepo({ '.gateforge/planes.json': JSON.stringify({ schemaVersion: 1 }) });
    expect(digestOf(withPack)).not.toBe(digestOf(cwd));
  });
});

describe('the generated gate wiring is owner-pinned too', () => {
  it('removing the generated pre-commit hook is a policy-revision change', () => {
    // F2 §6/§9: deleting `.gateforge/hooks/**` must not be a way back
    // into adoption mode. The hook is a Gateforge-owned policy input AND
    // its bytes belong to the approved revision, so the pin has to move.
    const cwd = tempRepo({ '.gateforge/hooks/gateforge-check.mjs': '// generated\n' });
    const approved = digestOf(cwd);

    writeTree(cwd, { '.gateforge/hooks/gateforge-check.mjs': '' });

    expect(digestOf(cwd)).not.toBe(approved);
  });

  it('a repository with no generated wiring keeps a byte-identical digest', () => {
    const bare = tempRepo();
    const wired = tempRepo({ '.gateforge/ci/gitlab-gateforge.yml': '# generated\n' });
    expect(digestOf(wired)).not.toBe(digestOf(bare));
    expect(digestOf(bare)).toBe(digestOf(tempRepo()));
  });
});