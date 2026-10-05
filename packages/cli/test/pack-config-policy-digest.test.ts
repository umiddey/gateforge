/**
 * The pack answers are OWNER-PINNED POLICY INPUTS (0.10.2, task 3).
 *
 * Since 0.11.0 they are no longer files of their own: the plane, endpoint,
 * HTTP-client and FastAPI answers are `planes:` / `endpoints:` sections of
 * the owner-answers document and `scan.httpClients` / `scan.fastapi` in
 * `.gateforge.yml` (plan 2026-10-05 §5 D0). Both documents were already
 * pinned, so the property this file pins is unchanged — a candidate that
 * narrows a client scan root in the same commit it deletes an obligation
 * with otherwise had nothing to catch it: the obligation left the graph,
 * the declaration was excused as policy-owned, and the pin matched.
 *
 * What DID change is the removal of the four paths from the digest: they
 * are no longer listed as inputs (a repository must not pin four files
 * that do not exist), and a pre-0.11 file left on disk is refused by name
 * by `gateforge migrate`, never read.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_ANSWERS_PATH, loadConfig } from '@gate-forge/core';
import { CLASSIFICATION_POLICY_YML, PLUGIN_SOURCE, configYml } from './helpers.js';
import { evaluateApprovedPolicy, resolveApprovedPolicyDigest } from '../src/trusted-policy.js';
import { trustedPolicyDigestEntriesForConfig, trustedPolicyDigestForConfig } from '../src/execution.js';
import { MOVED_OWNER_DOCUMENTS } from '../src/moved-owner-documents.js';
import type { ScanConfig } from '@gate-forge/core';
/** The pre-0.11 paths that must no longer appear as pinned inputs. */
const REMOVED_PACK_CONFIG_PATHS = MOVED_OWNER_DOCUMENTS.map((document) => document.path);

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
    [OWNER_ANSWERS_PATH]: CLASSIFICATION_POLICY_YML,
    'plugin.mjs': PLUGIN_SOURCE,
    ...files,
  });
  return dir;
}

/** The approved revision the owner pinned for `cwd`. */
function digestOf(cwd: string): string {
  return trustedPolicyDigestForConfig(cwd, loadConfig(join(cwd, '.gateforge.yml')));
}

// The real shape of the client-scan document (was
// `.gateforge/http-clients.json`, now `scan.httpClients`): globs that
// decide which files produce client-call facts at all.
const CLIENT_SCAN_WIDE = `clientScanRoots:
  - src/accounts
sameOriginHosts:
  - api.internal`;

const CLIENT_SCAN_NARROWED = `clientScanRoots: []
sameOriginHosts:
  - api.internal`;

/** A repository whose `.gateforge.yml` declares the given `scan.httpClients`. */
function clientScanRepo(section: string): string {
  const cwd = tempRepo();
  writeTree(cwd, { '.gateforge.yml': configYml({ scan: { httpClients: section } }) });
  return cwd;
}

describe('the pack answers are owner-pinned policy inputs', () => {
  it('narrowing a client scan root changes the approved revision and the gate refuses', () => {
    // The measured gap: `clientScanRoots` decides which files become
    // obligations, so a same-commit narrowing deletes obligations. While
    // the approved revision does not move, nothing blocks it.
    const cwd = clientScanRepo(CLIENT_SCAN_WIDE);
    const approved = digestOf(cwd);

    writeTree(cwd, { '.gateforge.yml': configYml({ scan: { httpClients: CLIENT_SCAN_NARROWED } }) });

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

  it('editing a plane rule in the answers document moves the approved revision', () => {
    const cwd = tempRepo();
    const approved = digestOf(cwd);
    writeTree(cwd, {
      [OWNER_ANSWERS_PATH]: `${CLASSIFICATION_POLICY_YML}planes:\n  rules:\n    - match: 'backend/**'\n      plane: master\n      reason: reviewed by hand\n`,
    });
    expect(digestOf(cwd)).not.toBe(approved);
  });

  it('no repository pins the pre-0.11 pack-config paths anymore', () => {
    const cwd = tempRepo();
    const names = trustedPolicyDigestEntriesForConfig(cwd, loadConfig(join(cwd, '.gateforge.yml'))).map(
      (entry) => entry.name,
    );
    for (const relative of REMOVED_PACK_CONFIG_PATHS) {
      expect(names).not.toContain(relative);
    }
  });

  it('a repository with no pack answers keeps a byte-identical digest', () => {
    const bare = tempRepo();
    expect(digestOf(bare)).toBe(digestOf(tempRepo()));
  });

  it('a repository that declares no scanner section cannot load (the pin is not a fallback)', () => {
    // `scan:` is REQUIRED: a repository that has not answered "what must a
    // closed-world proof cover" must fail the load (exit 2), not silently
    // get the weaker today's-default behaviour.
    const cwd = tempRepo();
    writeTree(cwd, {
      '.gateforge.yml': configYml().replace(/scan:\n(?:  .*\n)*/, ''),
    });
    expect(() => loadConfig(join(cwd, '.gateforge.yml'))).toThrow();
  });

  it('the composed scanner policy carries the `scan:` section a run validates', () => {
    const cwd = clientScanRepo(CLIENT_SCAN_WIDE);
    const scan: ScanConfig = loadConfig(join(cwd, '.gateforge.yml')).scan;
    expect(scan.httpClients?.clientScanRoots).toEqual(['src/accounts']);
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