import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';
import { VERIFIER_KEY_ENV, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { environmentVerifierKeyId, resolveVerifierKeyring } from '../src/verifier-keys.js';

const externalRoots: string[] = [];

/** Creates a fresh external directory for key-file tests. */
function externalRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-key-source-'));
  externalRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of externalRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('verifier key-ring source', () => {
  it('requires an explicit ceremony, creates owner-only keys, rotates, and retires without printing secrets', async () => {
    await withTempRepo({}, async (repo) => {
      const path = join(externalRoot(), 'keys.json');
      const missingConfirm = await runCli(repo, ['key', 'create', '--file', path]);
      expect(missingConfirm.code).toBe(2);
      const created = await runCli(repo, ['key', 'create', '--file', path, '--confirm']);
      expect(created.code).toBe(0);
      const initial = JSON.parse(readFileSync(path, 'utf8')) as {
        activeKeyId: string;
        keys: Record<string, string>;
      };
      const oldKey = initial.keys[initial.activeKeyId] ?? '';
      expect(oldKey).not.toBe('');
      expect(created.stdout).toContain(initial.activeKeyId);
      expect(created.stdout).not.toContain(oldKey);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);

      const rotated = await runCli(repo, ['key', 'rotate', '--file', path, '--confirm']);
      expect(rotated.code).toBe(0);
      const afterRotation = JSON.parse(readFileSync(path, 'utf8')) as {
        activeKeyId: string;
        keys: Record<string, string>;
      };
      expect(afterRotation.activeKeyId).not.toBe(initial.activeKeyId);
      expect(afterRotation.keys[initial.activeKeyId]).toBe(oldKey);
      expect(Object.keys(afterRotation.keys)).toHaveLength(2);
      expect(rotated.stdout).not.toContain(afterRotation.keys[afterRotation.activeKeyId] ?? '');

      const retired = await runCli(repo, [
        'key',
        'retire',
        '--file',
        path,
        '--key-id',
        initial.activeKeyId,
        '--confirm',
      ]);
      expect(retired.code).toBe(0);
      const afterRetirement = JSON.parse(readFileSync(path, 'utf8')) as {
        activeKeyId: string;
        keys: Record<string, string>;
      };
      expect(afterRetirement.keys[initial.activeKeyId]).toBeUndefined();
      expect(afterRetirement.activeKeyId).toBe(afterRotation.activeKeyId);
    });
  });

  it('rejects in-repository, artifact-root, symlink, and group-readable sources', async () => {
    await withTempRepo({}, async (repo) => {
      const external = externalRoot();
      const keyFile = join(external, 'keys.json');
      const document = { schemaVersion: 1, activeKeyId: 'key-old', keys: { 'key-old': 'old-secret' } };
      const fs = await import('node:fs');
      fs.writeFileSync(keyFile, `${JSON.stringify(document)}\n`, { mode: 0o600 });
      const env = { [VERIFIER_KEY_FILE_ENV]: keyFile };
      const inRepoPath = join(repo.root, 'keys.json');
      fs.writeFileSync(inRepoPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
      expect(() => resolveVerifierKeyring(repo.root, { [VERIFIER_KEY_FILE_ENV]: inRepoPath })).toThrow(
        /outside the candidate repository/,
      );
      expect(() => resolveVerifierKeyring(repo.root, env, [external])).toThrow(/uploaded artifact roots/);

      const link = join(external, 'keys-link.json');
      symlinkSync(keyFile, link);
      expect(() => resolveVerifierKeyring(repo.root, { [VERIFIER_KEY_FILE_ENV]: link })).toThrow(/symbolic link/);
      const hardLink = join(external, 'keys-hardlink.json');
      linkSync(keyFile, hardLink);
      expect(() => resolveVerifierKeyring(repo.root, env)).toThrow(/other hard links/);
      rmSync(hardLink);

      chmodSync(keyFile, 0o640);
      expect(() => resolveVerifierKeyring(repo.root, env)).toThrow(/owner-only/);
    });
  });
  it('distinguishes an unreadable verifier key from a missing key and keeps exit 2', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const keyFile = join(externalRoot(), 'unreadable.json');
      writeFileSync(
        keyFile,
        `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'key-unreadable', keys: { 'key-unreadable': 'secret' } })}\n`,
        { mode: 0o000 },
      );
      chmodSync(keyFile, 0o000);
      const result = await runCli(repo, ['check'], { [VERIFIER_KEY_FILE_ENV]: keyFile });
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/verifier key exists at .*not readable by uid \d+ \(owner uid \d+\).*fix ownership/);
    });
  });

  it('imports an existing environment key without printing it or changing the active key', async () => {
    await withTempRepo({}, async (repo) => {
      const path = join(externalRoot(), 'keys.json');
      expect((await runCli(repo, ['key', 'create', '--file', path, '--confirm'])).code).toBe(0);
      const before = JSON.parse(readFileSync(path, 'utf8')) as { activeKeyId: string };
      const legacyKey = 'legacy-env-key-material';
      const imported = await runCli(repo, ['key', 'import-env', '--file', path, '--confirm'], {
        [VERIFIER_KEY_ENV]: legacyKey,
      });
      expect(imported.code).toBe(0);
      expect(imported.stdout).not.toContain(legacyKey);
      const keyring = resolveVerifierKeyring(repo.root, { [VERIFIER_KEY_FILE_ENV]: path });
      expect(keyring?.active.keyId).toBe(before.activeKeyId);
      expect(keyring?.keys).toContainEqual({ keyId: environmentVerifierKeyId(legacyKey), key: legacyKey });
    });
  });

  it('creates and automatically discovers the owner-only XDG key ring outside the repository', async () => {
    await withTempRepo({}, async (repo) => {
      const xdg = externalRoot();
      const created = await runCli(repo, ['key', 'create', '--confirm'], { XDG_CONFIG_HOME: xdg });
      const path = join(xdg, 'gateforge', 'verifier-keyring.json');
      expect(created.code).toBe(0);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      const resolved = resolveVerifierKeyring(repo.root, { XDG_CONFIG_HOME: xdg });
      expect(resolved?.active.keyId).toMatch(/^key-/);
      expect(path.startsWith(repo.root)).toBe(false);
    });
  });

  it('does not pass the key or file source to a legacy suite or write either to run state', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const key = 'key-file-suite-secret';
      const path = join(externalRoot(), 'keys.json');
      const keyId = 'key-suite';
      const fs = await import('node:fs');
      fs.writeFileSync(
        path,
        `${JSON.stringify({ schemaVersion: 1, activeKeyId: keyId, keys: { [keyId]: key } })}\n`,
        { mode: 0o600 },
      );
      const probe =
        `if (process.env[${JSON.stringify(VERIFIER_KEY_ENV)}] || ` +
        `process.env[${JSON.stringify(VERIFIER_KEY_FILE_ENV)}]) process.exit(43)`;
      const suite = `${process.execPath} -e '${probe}'`;
      const result = await runCli(
        repo,
        ['test-gates', '--suite', suite],
        { [VERIFIER_KEY_ENV]: undefined, [VERIFIER_KEY_FILE_ENV]: path },
      );
      expect(result.stderr).not.toContain('suite exited with status 43');

      const stateDir = join(repo.root, '.gateforge', 'test-gates');
      const stateText = readdirSync(stateDir)
        .map((name) => readFileSync(join(stateDir, name)))
        .join('\n');
      expect(stateText).not.toContain(key);
      expect(stateText).not.toContain(path);
    });
  });
});

describe('key create on an existing key ring is honest about what is already there', () => {
  it('names the existing ring, its active key id, and the command for a new key', async () => {
    await withTempRepo({}, async (repo) => {
      const xdg = externalRoot();
      const created = await runCli(repo, ['key', 'create', '--confirm'], { XDG_CONFIG_HOME: xdg });
      expect(created.code).toBe(0);
      const document = JSON.parse(
        readFileSync(join(xdg, 'gateforge', 'verifier-keyring.json'), 'utf8'),
      ) as { activeKeyId: string; keys: Record<string, string> };
      const secret = document.keys[document.activeKeyId] ?? '';

      // The documented second-project step: the ring exists and already
      // holds an active key, so nothing needs doing.
      const again = await runCli(repo, ['key', 'create', '--confirm'], { XDG_CONFIG_HOME: xdg });
      expect(again.code).toBe(2);
      expect(again.stderr).toContain('already exists');
      expect(again.stderr).toContain(document.activeKeyId);
      // The secret never appears.
      expect(again.stderr).not.toContain(secret);
      // The way forward for a NEW key is named, and it is the real one.
      expect(again.stderr).toContain('gateforge key rotate');
      // Nothing needs doing while that key is active.
      expect(again.stderr).toMatch(/nothing to do|no action/i);
      // The ring is untouched by the refusal.
      expect(
        JSON.parse(readFileSync(join(xdg, 'gateforge', 'verifier-keyring.json'), 'utf8')),
      ).toEqual(document);
    });
  });

  it('still refuses a file it cannot read as a key ring', async () => {
    await withTempRepo({}, async (repo) => {
      const path = join(externalRoot(), 'keys.json');
      writeFileSync(path, 'not a key ring\n', { mode: 0o600 });
      const again = await runCli(repo, ['key', 'create', '--file', path, '--confirm']);
      expect(again.code).toBe(2);
      expect(again.stderr).not.toContain('gateforge key rotate');
    });
  });
});
