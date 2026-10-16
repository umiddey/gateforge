/**
 * Run-cache key binds the EXECUTED plugin module's bytes (plan
 * 20261016_0330): for a package specifier the executing copy is the
 * CLI's own bundled/installed package, not the target repository's
 * `node_modules` copy — Node resolves the bare specifier from the
 * importing CLI, so an engine rebuilt at the same version (or a repo
 * with an older installed pack) used to get a stale cache HIT while the
 * executed bytes differed from the digested bytes.
 *
 * Fixture: a target repo whose `node_modules` holds pack copy A and a
 * synthetic CLI layout whose bundled package dir holds copy B. The cache
 * key must change when B changes and stay stable when nothing changes,
 * and fail closed to a null (uncacheable) key when the executed module
 * cannot be resolved or read.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginCacheIdentity, type PluginCacheIdentity } from '../src/run-cache.js';

/** One fake installed pack: manifest + the bytes a detector edit would touch. */
function writePack(packDir: string, discoverBody: string): void {
  mkdirSync(join(packDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packDir, 'package.json'),
    `${JSON.stringify({ name: '@gate-forge/pack-http', version: '1.0.0' })}\n`,
  );
  writeFileSync(join(packDir, 'dist', 'index.js'), discoverBody);
}

/**
 * Builds the two-copy world: `repo/node_modules/@gate-forge/pack-http`
 * (copy A, what the OLD key digested) and `<base>/cli/packages/pack-http`
 * (copy B, the CLI's bundled package — what actually executes). The
 * anchor is the CLI's module directory the shared resolver walks up from.
 */
function twoCopyFixture(): { repo: string; anchor: string; bundledPack: string } {
  const base = mkdtempSync(join(tmpdir(), 'gf-runcache-key-'));
  const repo = join(base, 'repo');
  const cliPackageRoot = join(base, 'cli', 'packages', 'cli');
  const anchor = join(cliPackageRoot, 'dist');
  const repoPack = join(repo, 'node_modules', '@gate-forge', 'pack-http');
  const bundledPack = join(base, 'cli', 'packages', 'pack-http');
  mkdirSync(join(repo, 'node_modules', '@gate-forge'), { recursive: true });
  mkdirSync(anchor, { recursive: true });
  writeFileSync(
    join(cliPackageRoot, 'package.json'),
    `${JSON.stringify({ name: '@gate-forge/cli', version: '0.0.0-test' })}\n`,
  );
  writePack(repoPack, 'export const discover = () => ({ copy: "repo" });\n');
  writePack(bundledPack, 'export const discover = () => ({ copy: "bundled" });\n');
  return { repo, anchor, bundledPack };
}

const PACK_HTTP_PLUGIN = {
  id: 'gateforge.pack-http',
  version: '1.0.0',
  transport: 'in-process',
  module: '@gate-forge/pack-http',
} as const;

function identityFor(repo: string, anchor: string): PluginCacheIdentity | null {
  return pluginCacheIdentity(
    PACK_HTTP_PLUGIN,
    'inputs-digest',
    repo,
    process.env,
    '0.0.0-test',
    anchor,
  );
}

const createdFixtures: string[] = [];

afterEach(() => {
  while (createdFixtures.length > 0) {
    rmSync(createdFixtures.pop() as string, { recursive: true, force: true });
  }
});

describe('run-cache executed-module digest', () => {
  it('changes the key when the bundled (executed) pack copy changes while the repo copy stays', () => {
    const { repo, anchor, bundledPack } = twoCopyFixture();
    createdFixtures.push(join(bundledPack, '..', '..'));
    const before = identityFor(repo, anchor);
    expect(before).not.toBeNull();
    writeFileSync(
      join(bundledPack, 'dist', 'index.js'),
      'export const discover = () => ({ copy: "bundled-v2" });\n',
    );
    const after = identityFor(repo, anchor);
    expect(after).not.toBeNull();
    expect(after?.moduleBytesDigest).not.toBe(before?.moduleBytesDigest);
    expect(after).not.toEqual(before);
  });

  it('keeps the key identical while both copies stay unchanged', () => {
    const { repo, anchor, bundledPack } = twoCopyFixture();
    createdFixtures.push(join(bundledPack, '..', '..'));
    expect(identityFor(repo, anchor)).toEqual(identityFor(repo, anchor));
  });

  it('fails closed to a null key when the executed module is unreadable', () => {
    const { repo, anchor, bundledPack } = twoCopyFixture();
    createdFixtures.push(join(bundledPack, '..', '..'));
    const executedFile = join(bundledPack, 'dist', 'index.js');
    chmodSync(executedFile, 0o000);
    try {
      expect(identityFor(repo, anchor)).toBeNull();
    } finally {
      chmodSync(executedFile, 0o644);
    }
  });

  it('fails closed to a null key when the executed package cannot be resolved', () => {
    const base = mkdtempSync(join(tmpdir(), 'gf-runcache-key-'));
    createdFixtures.push(base);
    const repo = join(base, 'repo');
    const cliPackageRoot = join(base, 'cli', 'packages', 'cli');
    const anchor = join(cliPackageRoot, 'dist');
    mkdirSync(join(repo, 'node_modules', '@gate-forge', 'pack-http', 'dist'), { recursive: true });
    mkdirSync(anchor, { recursive: true });
    writeFileSync(
      join(cliPackageRoot, 'package.json'),
      `${JSON.stringify({ name: '@gate-forge/cli', version: '0.0.0-test' })}\n`,
    );
    // Only the REPO holds the pack; the CLI installation has none, so the
    // executed module does not resolve and the key must be null — even
    // though the old repo-copy lookup would happily digest copy A.
    writePack(join(repo, 'node_modules', '@gate-forge', 'pack-http'), 'export const discover = () => ({});\n');
    expect(identityFor(repo, anchor)).toBeNull();
  });
});
