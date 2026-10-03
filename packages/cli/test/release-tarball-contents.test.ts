/**
 * Release packaging: what npm would actually put into a published tarball,
 * and what the release script does when that list is not clean.
 *
 * 0.8.0 shipped Python bytecode caches (`__pycache__` / `.pyc`) inside four packages: every
 * manifest that ships Python source lists the whole `python` directory, and
 * a detector run leaves bytecode caches in it. The manifests therefore end
 * their `files` list with negations for `__pycache__`, `.pyc` and `.pyo`
 * entries, and `scripts/release-publish.sh` refuses the release — before
 * any package is published — when a packed file list still names bytecode.
 *
 * Both halves are proved here against real `npm pack` behaviour and against
 * the real script; nothing asserts the shape of a manifest.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Repository root: this file lives at packages/cli/test/. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The release publisher the tag workflow runs. */
const RELEASE_SCRIPT = join(REPO_ROOT, 'scripts', 'release-publish.sh');

/**
 * Every package that ships Python source, with one file each that must still
 * be packed: the exclusion is for bytecode, not for Python.
 */
const PYTHON_PACKAGES = [
  { dir: 'packages/pack-alembic', kept: 'python/gateforge_alembic_detector/scan.py' },
  { dir: 'packages/pack-fastapi', kept: 'python/gateforge_fastapi_detector/scan.py' },
  { dir: 'packages/pack-playwright', kept: 'python/gateforge_pytest_plugin.py' },
  { dir: 'packages/pack-sqlalchemy', kept: 'python/gateforge_sqlalchemy_detector/scan.py' },
  { dir: 'packages/plugin-protocol', kept: 'python/gateforge_plugin/__init__.py' },
] as const;

/** Bytecode shapes a detector run (or a stale tree) leaves behind. */
const PROBES = [
  'python/__pycache__/probe.cpython-312.pyc',
  'python/__pycache__/probe.cpython-314.pyo',
  'python/loose_module.pyc',
] as const;

/**
 * Copies a package into scratch space so `npm pack` can run there with a
 * planted bytecode cache and leave the source tree untouched.
 *
 * Args:
 *   packageDir: repository-relative package directory.
 *
 * Returns:
 *   The scratch directory holding the copy.
 */
function scratchPackage(packageDir: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'gateforge-pack-'));
  const source = join(REPO_ROOT, packageDir);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
    files?: string[];
  };
  cpSync(join(source, 'package.json'), join(scratch, 'package.json'));
  for (const entry of manifest.files ?? []) {
    // Negation patterns and `README.md` are not directories; npm always
    // ships the README of a packed package on its own.
    if (entry.startsWith('!')) continue;
    const path = join(source, entry);
    if (existsSync(path)) cpSync(path, join(scratch, entry), { recursive: true });
  }
  return scratch;
}

/**
 * Runs `npm pack --dry-run --json` and returns the packed file paths.
 *
 * Args:
 *   cwd: directory holding the package manifest.
 *
 * Returns:
 *   Every path npm would put in the tarball.
 */
function packedPaths(cwd: string): string[] {
  const run = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd,
    encoding: 'utf8',
  });
  const entries = JSON.parse(run.stdout) as Array<{ files: Array<{ path: string }> }>;
  expect(entries).toHaveLength(1);
  return (entries[0]?.files ?? []).map((file) => file.path);
}

/**
 * Builds a scratch workspace whose `npm` is a recording stub, so the release
 * script can run without touching a registry.
 *
 * Args:
 *   packages: package directory names to create, with their packed file lists.
 *
 * Returns:
 *   The workspace root, with `npm` on PATH and `W6_STUB_LOG` exported.
 */
function stubbedWorkspace(packages: Array<{ dir: string; files: string[] }>): {
  root: string;
  logPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-release-'));
  const bin = join(root, 'stub-bin');
  mkdirSync(bin);
  const logPath = join(root, 'npm-invocations.log');
  const packJson = join(root, 'pack.json');
  const entries = packages.map((entry) => ({
    name: `@probe/${entry.dir}`,
    filename: `probe-${entry.dir}-9.9.9.tgz`,
    files: entry.files.map((path) => ({ path })),
  }));
  writeFileSync(packJson, `${JSON.stringify(entries)}\n`);
  const stub = [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$W6_STUB_LOG"',
    'case "$1" in',
    '  view) exit 1 ;;',
    '  pack) cat "$W6_STUB_PACK_JSON" ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'npm'), stub);
  chmodSync(join(bin, 'npm'), 0o755);
  for (const entry of packages) {
    mkdirSync(join(root, 'packages', entry.dir), { recursive: true });
    writeFileSync(
      join(root, 'packages', entry.dir, 'package.json'),
      `${JSON.stringify({ name: `@probe/${entry.dir}`, version: '9.9.9' }, null, 2)}\n`,
    );
  }
  return { root, logPath };
}

/**
 * Runs the release publisher against the stubbed workspace.
 *
 * Args:
 *   root: workspace root from `stubbedWorkspace`.
 *   logPath: file the npm stub records its invocations in.
 *   args: arguments for the release script; none means publish.
 *
 * Returns:
 *   The exit status, the combined output, and the recorded npm invocations.
 */
function runReleaseScript(
  root: string,
  logPath: string,
  args: string[] = [],
): { status: number | null; output: string; invocations: string[] } {
  const run = spawnSync('bash', [RELEASE_SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(root, 'stub-bin')}:${process.env.PATH ?? ''}`,
      W6_STUB_LOG: logPath,
      W6_STUB_PACK_JSON: join(root, 'pack.json'),
    },
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const invocations = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [];
  return { status: run.status, output, invocations };
}

describe('published tarball contents', () => {
  it.each(PYTHON_PACKAGES)('$dir packs no Python bytecode', ({ dir, kept }) => {
    const scratch = scratchPackage(dir);
    try {
      for (const probe of PROBES) {
        const absolute = join(scratch, probe);
        mkdirSync(join(absolute, '..'), { recursive: true });
        writeFileSync(absolute, 'planted probe\n');
      }
      const paths = packedPaths(scratch);
      expect(
        paths.filter((path) => path.includes('__pycache__') || /\.(?:pyc|pyo)$/.test(path)),
      ).toEqual([]);
      expect(paths).toContain(kept);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('release publisher bytecode preflight', () => {
  it('refuses the whole release, publishing nothing, when a packed list names bytecode', () => {
    const { root, logPath } = stubbedWorkspace([
      { dir: 'clean-pkg', files: ['package.json', 'dist/index.js'] },
      {
        dir: 'dirty-pkg',
        files: [
          'package.json',
          'python/detector/scan.py',
          'python/detector/__pycache__/scan.cpython-312.pyc',
        ],
      },
    ]);
    try {
      const result = runReleaseScript(root, logPath);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Python bytecode would ship');
      expect(result.output).toContain('@probe/dirty-pkg: python/detector/__pycache__/scan.cpython-312.pyc');
      expect(result.invocations.filter((line) => line.startsWith('publish'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes every package when no packed list names bytecode', () => {
    const { root, logPath } = stubbedWorkspace([
      { dir: 'clean-pkg', files: ['package.json', 'python/detector/scan.py'] },
      { dir: 'other-pkg', files: ['package.json', 'dist/index.js'] },
    ]);
    try {
      const result = runReleaseScript(root, logPath);
      expect(result.output).toContain('no Python bytecode in any workspace package');
      expect(result.status).toBe(0);
      expect(result.invocations.filter((line) => line.startsWith('publish'))).toHaveLength(2);
      expect(result.output).toContain('2 published, 0 skipped, 0 failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // npm 12 prints `pack --json --workspaces` as an object keyed by package
  // name instead of an array; the preflight must read the same entries.
  function rewriteAsNpm12(root: string): void {
    const entries = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8')) as Array<{ name: string }>;
    writeFileSync(join(root, 'pack.json'), `${JSON.stringify(Object.fromEntries(entries.map((e) => [e.name, e])))}\n`);
  }

  it('reads the npm 12 keyed-object pack output and still refuses bytecode', () => {
    const { root, logPath } = stubbedWorkspace([
      { dir: 'clean-pkg', files: ['package.json'] },
      { dir: 'dirty-pkg', files: ['package.json', 'python/detector/__pycache__/scan.cpython-312.pyc'] },
    ]);
    try {
      rewriteAsNpm12(root);
      const result = runReleaseScript(root, logPath);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('@probe/dirty-pkg: python/detector/__pycache__/scan.cpython-312.pyc');
      expect(result.invocations.filter((line) => line.startsWith('publish'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes every package from the npm 12 keyed-object pack output', () => {
    const { root, logPath } = stubbedWorkspace([
      { dir: 'clean-pkg', files: ['package.json', 'python/detector/scan.py'] },
      { dir: 'other-pkg', files: ['package.json', 'dist/index.js'] },
    ]);
    try {
      rewriteAsNpm12(root);
      const result = runReleaseScript(root, logPath);
      expect(result.status).toBe(0);
      expect(result.output).toContain('2 published, 0 skipped, 0 failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to publish anything when the packed file list cannot be verified', () => {
    const { root, logPath } = stubbedWorkspace([{ dir: 'clean-pkg', files: ['package.json'] }]);
    try {
      // An unreadable list is not a clean list: the release must stop, not guess.
      writeFileSync(join(root, 'pack.json'), '[]\n');
      const result = runReleaseScript(root, logPath);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('the packed file list could not be verified');
      expect(result.invocations.filter((line) => line.startsWith('publish'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release publisher check mode', () => {
  it('verifies the packed tarballs and publishes nothing', () => {
    const { root, logPath } = stubbedWorkspace([
      { dir: 'clean-pkg', files: ['package.json', 'python/detector/scan.py'] },
    ]);
    try {
      const result = runReleaseScript(root, logPath, ['check']);
      expect(result.status).toBe(0);
      expect(result.output).toContain('nothing was published');
      expect(result.invocations).toEqual(['pack --dry-run --json --workspaces']);
      expect(result.invocations.filter((line) => line.startsWith('publish'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a dirty list exactly like the publish path', () => {
    const { root, logPath } = stubbedWorkspace([
      { dir: 'dirty-pkg', files: ['package.json', 'python/detector/__pycache__/scan.cpython-312.pyc'] },
    ]);
    try {
      const result = runReleaseScript(root, logPath, ['check']);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Python bytecode would ship');
      expect(result.invocations.filter((line) => line.startsWith('publish'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unknown mode with its usage instead of publishing', () => {
    const { root, logPath } = stubbedWorkspace([{ dir: 'clean-pkg', files: ['package.json'] }]);
    try {
      const result = runReleaseScript(root, logPath, ['publish-all']);
      expect(result.status).toBe(2);
      expect(result.output).toContain('usage: bash scripts/release-publish.sh [publish|check]');
      expect(result.invocations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('root release scripts', () => {
  // The repository's own manifest: a named, one-line shape is enough to read
  // two script strings out of it.
  const rootManifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  const rootScripts = rootManifest.scripts ?? {};

  it('publish:all goes through the release publisher, so the bytecode refusal cannot be bypassed', () => {
    expect(rootScripts['publish:all']).toContain('scripts/release-publish.sh');
    expect(rootScripts['publish:all']).not.toMatch(/npm publish/);
  });

  it('pack:check runs the same bytecode check as the publish path', () => {
    expect(rootScripts['pack:check']).toContain('scripts/release-publish.sh check');
  });
});