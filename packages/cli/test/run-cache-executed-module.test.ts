/**
 * Run-cache key binds the EXECUTED plugin module's bytes (plan
 * 20261016_0330): for a package specifier the executing copy is the
 * CLI's own installed package — resolved by Node's own resolution from
 * the CLI module — not the target repository's `node_modules` copy. The
 * loader imports EXACTLY the resolver's entry URL and the key digests
 * the SAME resolution's package dir, so an engine rebuilt at the same
 * version (or a repo with an older installed pack) can no longer serve
 * a stale cache HIT.
 *
 * Fixture: a target repo whose `node_modules` holds pack copy A and a
 * synthetic CLI installation whose `node_modules` holds copy B (the
 * resolution is anchored at the fixture CLI, mirroring the production
 * default with `createRequire`). The cache key must change when B
 * changes and stay stable when nothing changes, and fail closed to a
 * null (uncacheable) key when the executed module cannot be resolved or
 * read. One further test pins the loader's URL to Node's own answer for
 * a REAL package.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveExecutedModule } from '../src/detector-trust.js';
import { pluginCacheIdentity, type PluginCacheIdentity } from '../src/run-cache.js';

/** One fake installed pack: manifest (with a resolvable entry) + the bytes a detector edit would touch. */
function writePack(packDir: string, discoverBody: string): void {
  mkdirSync(join(packDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packDir, 'package.json'),
    `${JSON.stringify({
      name: '@gate-forge/pack-http',
      version: '1.0.0',
      exports: { '.': './dist/index.js' },
    })}\n`,
  );
  writeFileSync(join(packDir, 'dist', 'index.js'), discoverBody);
}

/**
 * Builds the two-copy world: `repo/node_modules/@gate-forge/pack-http`
 * (copy A, what the OLD key digested) and
 * `<base>/cli/packages/cli/node_modules/@gate-forge/pack-http` (copy B,
 * the CLI's installed package — what actually executes).
 */
function twoCopyFixture(): { repo: string; cliRoot: string; bundledPack: string } {
  const base = mkdtempSync(join(tmpdir(), 'gf-runcache-key-'));
  const repo = join(base, 'repo');
  const cliRoot = join(base, 'cli', 'packages', 'cli');
  const bundledPack = join(cliRoot, 'node_modules', '@gate-forge', 'pack-http');
  // The resolution anchor must be a REAL module — Node's require.resolve
  // stats the parent chain before walking node_modules.
  mkdirSync(join(cliRoot, 'dist'), { recursive: true });
  writeFileSync(join(cliRoot, 'dist', 'index.mjs'), 'export {};\n');
  writePack(bundledPack, 'export const discover = () => ({ copy: "bundled" });\n');
  mkdirSync(join(repo, 'node_modules', '@gate-forge'), { recursive: true });
  writePack(join(repo, 'node_modules', '@gate-forge', 'pack-http'), 'export const discover = () => ({ copy: "repo" });\n');
  return { repo, cliRoot, bundledPack };
}

/**
 * The production injectee anchored at a FIXTURE CLI: the same Node
 * resolution (`createRequire(...).resolve`) walks the fixture layout, so
 * the tests exercise the real algorithm, not a hand-rolled mapping.
 */
function fixtureResolveBare(cliRoot: string): (specifier: string) => string {
  const anchorModule = join(cliRoot, 'dist', 'index.mjs');
  return (specifier: string): string =>
    pathToFileURL(createRequire(anchorModule).resolve(specifier)).href;
}

const PACK_HTTP_PLUGIN = {
  id: 'gateforge.pack-http',
  version: '1.0.0',
  transport: 'in-process',
  module: '@gate-forge/pack-http',
} as const;

function identityFor(repo: string, cliRoot: string): PluginCacheIdentity | null {
  return pluginCacheIdentity(
    PACK_HTTP_PLUGIN,
    'inputs-digest',
    repo,
    process.env,
    '0.0.0-test',
    fixtureResolveBare(cliRoot),
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
    const { repo, cliRoot, bundledPack } = twoCopyFixture();
    createdFixtures.push(join(cliRoot, '..', '..'));
    const before = identityFor(repo, cliRoot);
    expect(before).not.toBeNull();
    writeFileSync(
      join(bundledPack, 'dist', 'index.js'),
      'export const discover = () => ({ copy: "bundled-v2" });\n',
    );
    const after = identityFor(repo, cliRoot);
    expect(after).not.toBeNull();
    expect(after?.moduleBytesDigest).not.toBe(before?.moduleBytesDigest);
    expect(after).not.toEqual(before);
  });

  it('keeps the key identical while both copies stay unchanged', () => {
    const { repo, cliRoot } = twoCopyFixture();
    createdFixtures.push(join(cliRoot, '..', '..'));
    expect(identityFor(repo, cliRoot)).toEqual(identityFor(repo, cliRoot));
  });

  it('fails closed to a null key when the executed module is unreadable', () => {
    const { repo, cliRoot, bundledPack } = twoCopyFixture();
    createdFixtures.push(join(cliRoot, '..', '..'));
    const executedFile = join(bundledPack, 'dist', 'index.js');
    chmodSync(executedFile, 0o000);
    try {
      expect(identityFor(repo, cliRoot)).toBeNull();
    } finally {
      chmodSync(executedFile, 0o644);
    }
  });

  it('fails closed to a null key when the executed package cannot be resolved', () => {
    const base = mkdtempSync(join(tmpdir(), 'gf-runcache-key-'));
    createdFixtures.push(base);
    const repo = join(base, 'repo');
    const cliRoot = join(base, 'cli', 'packages', 'cli');
    mkdirSync(join(repo, 'node_modules', '@gate-forge', 'pack-http', 'dist'), { recursive: true });
    // The CLI module anchor is real; only the PACK is missing, so Node's
    // own resolution from the CLI module throws MODULE_NOT_FOUND and the
    // key must be null — even though the old repo-copy lookup would
    // happily digest copy A.
    mkdirSync(join(cliRoot, 'dist'), { recursive: true });
    writeFileSync(join(cliRoot, 'dist', 'index.mjs'), 'export {};\n');
    writePack(join(repo, 'node_modules', '@gate-forge', 'pack-http'), 'export const discover = () => ({});\n');
    expect(identityFor(repo, cliRoot)).toBeNull();
  });

  it("imports the resolver's entry URL and loads the same module Node loads by name", async () => {
    const base = mkdtempSync(join(tmpdir(), 'gf-runcache-key-'));
    createdFixtures.push(base);
    // Resolution anchors at the CLI installation, never the (empty) repo.
    const resolved = resolveExecutedModule('@gate-forge/pack-http', base);
    expect(resolved).not.toBeNull();
    expect(resolved?.packageDir).not.toBeNull();
    // Node's own answer, resolved independently from THIS test module:
    const nodeEntryHref = pathToFileURL(
      realpathSync(createRequire(import.meta.url).resolve('@gate-forge/pack-http')),
    ).href;
    expect(resolved?.entryUrl).toBe(nodeEntryHref);
    // The loader imports the entry URL; that must be the SAME instance
    // an import by name produces (realpath-canonical ESM identity).
    // Dynamic import is the subject of this test — it intentionally
    // exercises the module-loading boundary the plugin host uses, and a
    // static import cannot express a runtime-computed specifier:
    const viaEntry = (await import(resolved!.entryUrl)) as { default?: unknown };
    const viaName = (await import('@gate-forge/pack-http')) as { default?: unknown };
    expect(viaEntry.default).toBe(viaName.default);
  });
});
