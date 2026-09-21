/**
 * Staged-runtime supervision tests (plan 2026-09-21 witnessed pre-commit,
 * acceptance cases 11–13): preparation and readiness failures are TYPED
 * and actionable, and child process groups are cleaned up on every exit
 * path — including interruption while only the registry exists.
 *
 * Every case runs REAL processes (shell commands, Node children); the
 * orphan probes use a unique marker pattern per case so concurrent
 * vitest files can never collide.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeConfigSchema, withTempRepo, type RuntimeConfig } from '@gate-forge/core';
import {
  RuntimeBlockError,
  loadRuntimeConfigAt,
  prepareRuntime,
  runtimeReuseDigest,
  startRuntimeServices,
  stopRuntimeChildren,
} from '../src/runtime.js';

/** Absolute path of the compiled CLI bin (child-process runs). */
const CLI_BIN = join(process.cwd(), 'packages/cli/bin/gateforge.js');

/** Minimal Io stand-in (the runtime layer only reads `env`). */
const io = { env: process.env } as Parameters<typeof prepareRuntime>[3];

/** Scratch roots created per test; removed on afterEach. */
const scratch: string[] = [];

/** Creates one throwaway directory tree. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-runtime-'));
  scratch.push(dir);
  return dir;
}

/** Counts live processes whose command line carries the marker. */
function orphanCount(marker: string): number {
  const result = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
  if (result.status !== 0) return 0; // pgrep: no match
  return (result.stdout ?? '').split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Polls a real process condition with a bounded budget (platform-timing
 * test: the child must be OBSERVED alive/gone — no deterministic clock
 * can stand in for the OS process table).
 *
 * Args:
 *   condition: predicate polled every 50ms.
 *
 * Returns:
 *   Promise<void>: resolves when the condition holds; rejects at 10s.
 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error('condition not reached within 10s');
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
}

afterEach(() => {
  // Belt and braces: a failing assertion must never leak processes into
  // the next test.
  return stopRuntimeChildren().finally(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
});

describe('staged-runtime supervision', () => {
  it('a failing preparation command is typed and names its log', async () => {
    const root = tempDir();
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      prepare: { command: 'echo prepare-started && exit 3', timeoutSeconds: 30 },
    };
    const failure = await prepareRuntime(root, root, runtime, io, join(root, 'state')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeBlockError);
    expect((failure as RuntimeBlockError).causeCode).toBe('RUNTIME_PREPARATION_FAILED');
    expect((failure as Error).message).toContain('exit 3');
    const logPath = join(root, 'state/runtime/prepare.log');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toContain('prepare-started');
  });

  it('a preparation timeout is typed and leaves no orphan behind', async () => {
    const root = tempDir();
    const marker = `rt-prepare-timeout-${process.pid}`;
    // The marker rides a shell COMMENT (a bare `sleep <marker>` would
    // exit instantly as an invalid interval, never time out).
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      prepare: { command: `sleep 60 # ${marker}`, timeoutSeconds: 1 },
    };
    const started = Date.now();
    const failure = await prepareRuntime(root, root, runtime, io, join(root, 'state')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeBlockError);
    expect((failure as RuntimeBlockError).causeCode).toBe('RUNTIME_PREPARATION_FAILED');
    expect((failure as Error).message).toContain('exceeded 1s');
    expect(Date.now() - started).toBeLessThan(10_000);
    await stopRuntimeChildren();
    expect(orphanCount(marker)).toBe(0);
  });

  it('a service that exits before readiness is typed and names the log', async () => {
    const root = tempDir();
    const marker = `rt-early-exit-${process.pid}`;
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      services: [
        {
          id: 'app',
          command: `node -e "console.log('${marker}'); process.exit(7)"`,
          ready: { log: 'never-matches', timeoutSeconds: 10 },
        },
      ],
    };
    const failure = await startRuntimeServices(root, runtime, io, join(root, 'state')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeBlockError);
    expect((failure as RuntimeBlockError).causeCode).toBe('RUNTIME_READINESS_FAILED');
    expect((failure as Error).message).toContain('exited');
    expect((failure as Error).message).toContain('7');
    const logDir = join(root, 'state/runtime');
    expect(readdirSync(logDir)).toContain('app.log');
  });

  it('a never-ready service times out typed and its process group is cleaned up', async () => {
    const root = tempDir();
    const marker = `rt-never-ready-${process.pid}`;
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      services: [
        {
          id: 'app',
          command: `node -e "/* ${marker} */ setTimeout(() => undefined, 60000)"`,
          ready: { log: 'ready', timeoutSeconds: 1 },
        },
      ],
    };
    const started = Date.now();
    const failure = await startRuntimeServices(root, runtime, io, join(root, 'state')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeBlockError);
    expect((failure as RuntimeBlockError).causeCode).toBe('RUNTIME_READINESS_FAILED');
    expect((failure as Error).message).toContain('not ready within 1s');
    expect(Date.now() - started).toBeLessThan(10_000);
    // The readiness failure path stops every already-started service
    // before the error propagates — no detached orphan survives.
    expect(orphanCount(marker)).toBe(0);
  });

  it('a successful runtime stops its services (idempotent) with no orphans', async () => {
    const root = tempDir();
    const marker = `rt-success-${process.pid}`;
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      services: [
        {
          id: 'app',
          command: `node -e "/* ${marker} */ console.log('ready'); setTimeout(() => undefined, 60000)"`,
          ready: { log: 'ready', timeoutSeconds: 15 },
        },
      ],
    };
    const running = await startRuntimeServices(root, runtime, io, join(root, 'state'));
    expect(running.targetBaseUrl).toBeNull(); // no attested target declared
    await waitFor(() => orphanCount(marker) === 1);
    await running.stop();
    await waitFor(() => orphanCount(marker) === 0);
    expect(orphanCount(marker)).toBe(0);
    await running.stop(); // idempotent
    expect(orphanCount(marker)).toBe(0);
  });

  it('an attested target publishes its proxy URL and marker', async () => {
    const root = tempDir();
    const marker = `rt-attested-${process.pid}`;
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      services: [
        {
          id: 'app',
          command:
            `node -e "/* ${marker} */ require('http').createServer((q,s)=>s.end('ok'))` +
            `.listen(Number(process.env.GATEFORGE_SERVICE_PORT_APP),'127.0.0.1',()=>console.log('ready'))"`,
          attested: true,
          fingerprint: 'rt-marker-v1',
          target: true,
          ready: { log: 'ready', timeoutSeconds: 15 },
        },
      ],
    };
    const running = await startRuntimeServices(root, runtime, io, join(root, 'state'));
    expect(running.targetBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.targetFingerprint).toBe('rt-marker-v1');
    // The proxy fronts the service: it serves the fingerprint header.
    const response = await fetch(running.targetBaseUrl as string).catch(() => null);
    expect(response).not.toBeNull();
    expect(response?.headers.get('x-gateforge-env-fingerprint')).toBe('rt-marker-v1');
    await running.stop();
    expect(orphanCount(marker)).toBe(0);
  });

  it('starts services declared after the attested target and waits for each', async () => {
    const root = tempDir();
    const appMarker = `rt-target-first-${process.pid}`;
    const workerMarker = `rt-after-target-${process.pid}`;
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      services: [
        {
          id: 'app',
          command: `node -e "/* ${appMarker} */ console.log('app-ready'); setTimeout(() => undefined, 60000)"`,
          attested: true,
          fingerprint: 'rt-target-first-v1',
          target: true,
          ready: { log: 'app-ready', timeoutSeconds: 15 },
        },
        {
          id: 'worker',
          command: `node -e "/* ${workerMarker} */ console.log('worker-ready'); setTimeout(() => undefined, 60000)"`,
          ready: { log: 'worker-ready', timeoutSeconds: 15 },
        },
      ],
    };
    const running = await startRuntimeServices(root, runtime, io, join(root, 'state'));
    expect(running.targetBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(readFileSync(join(root, 'state/runtime/worker.log'), 'utf8')).toContain('worker-ready');
    await waitFor(() => orphanCount(appMarker) === 1 && orphanCount(workerMarker) === 1);
    await running.stop();
    await waitFor(() => orphanCount(appMarker) === 0 && orphanCount(workerMarker) === 0);
  });

  it('does not accept a stale readiness line copied from an earlier run', async () => {
    const root = tempDir();
    const logDir = join(root, 'state/runtime');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'app.log'), 'ready-from-an-earlier-run\n', 'utf8');
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      services: [
        {
          id: 'app',
          command: `node -e "setTimeout(() => undefined, 60000)"`,
          ready: { log: 'ready-from-an-earlier-run', timeoutSeconds: 1 },
        },
      ],
    };
    const failure = await startRuntimeServices(root, runtime, io, join(root, 'state')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeBlockError);
    expect((failure as RuntimeBlockError).causeCode).toBe('RUNTIME_READINESS_FAILED');
    expect((failure as Error).message).toContain('not ready within 1s');
  });

  it('binds reused dependency bytes to a deterministic digest', () => {
    const root = tempDir();
    mkdirSync(join(root, 'node_modules', 'fixture'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'fixture', 'index.js'), 'export const value = 1;\n', 'utf8');
    const runtime: RuntimeConfig = { schemaVersion: 1, prepare: { reuse: ['node_modules'] } };
    const first = runtimeReuseDigest(root, runtime);
    writeFileSync(join(root, 'node_modules', 'fixture', 'index.js'), 'export const value = 2;\n', 'utf8');
    const second = runtimeReuseDigest(root, runtime);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it('binds the bytes after the tracked prepare command completes', async () => {
    const sourceRoot = tempDir();
    const checkoutRoot = tempDir();
    mkdirSync(join(sourceRoot, 'reused'), { recursive: true });
    writeFileSync(join(sourceRoot, 'reused', 'dependency.js'), 'export const value = 1;\n', 'utf8');
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      prepare: {
        reuse: ['reused'],
        command: `node -e "require('fs').writeFileSync('reused/dependency.js', 'export const value = 2;\\n')"`,
      },
    };
    const prepared = await prepareRuntime(sourceRoot, checkoutRoot, runtime, io, join(checkoutRoot, 'state'));
    expect(readFileSync(join(sourceRoot, 'reused', 'dependency.js'), 'utf8')).toContain('value = 2');
    expect(prepared.reuseDigest).toBe(runtimeReuseDigest(sourceRoot, runtime));
  });

  it('rejects absolute, dot, and traversal reuse paths in the schema', () => {
    for (const path of ['/tmp/deps', '.', '..', './node_modules', 'node_modules/../deps', 'node_modules\\deps']) {
      const parsed = RuntimeConfigSchema.safeParse({ schemaVersion: 1, prepare: { reuse: [path] } });
      expect(parsed.success, path).toBe(false);
    }
    expect(
      RuntimeConfigSchema.safeParse({ schemaVersion: 1, prepare: { reuse: ['node_modules/packages'] } }).success,
    ).toBe(true);
  });

  it('rejects a traversal even when a caller bypasses the schema', async () => {
    const root = tempDir();
    const runtime = {
      schemaVersion: 1,
      prepare: { reuse: ['../outside'] },
    } as unknown as RuntimeConfig;
    const failure = await prepareRuntime(root, join(root, 'checkout'), runtime, io, join(root, 'state')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeBlockError);
    expect((failure as Error).message).toContain('normalized repository-relative path');
  });

  it('stopRuntimeChildren reaps the interruption path (registry only)', async () => {
    const root = tempDir();
    const marker = `rt-interrupt-${process.pid}`;
    const runtime: RuntimeConfig = {
      schemaVersion: 1,
      prepare: { command: `node -e "/* ${marker} */ setTimeout(() => undefined, 60000)"`, timeoutSeconds: 30 },
    };
    // prepareRuntime awaits its child; kick it off and interrupt "the
    // process" the way the pre-commit SIGINT handler does.
    const pending = prepareRuntime(root, root, runtime, io, join(root, 'state'));
    await waitFor(() => orphanCount(marker) === 1);
    await stopRuntimeChildren();
    await pending.catch(() => undefined); // resolves as a typed timeout/kill
    await waitFor(() => orphanCount(marker) === 0);
    expect(orphanCount(marker)).toBe(0);
  });

  it('SIGINT to a real pre-commit CLI child tears the candidate runtime down', async () => {
    // Real Git repo + real CLI child (bin/gateforge.js): the gate must
    // die from the signal AND take the candidate's detached service
    // process group with it — the operator's shell never orphans it.
    const marker = `rt-sigint-cli-${process.pid}`;
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        '.gateforge.yml': [
          'schemaVersion: 1',
          'project:',
          '  languages: [javascript]',
          '  paths: { include: ["src/**"], exclude: [] }',
          'plugins: []',
          'policies: .gateforge/policies.yml',
          'classificationPolicy: .gateforge/classification-policy.yml',
          'adapters: .gateforge/adapters',
          'waivers: .gateforge/waivers',
          'baselines: .gateforge/baselines/obligations.json',
          'changed: { provider: auto }',
          'witness: { maxDurationSeconds: 5 }',
          "clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }",
          'runtime: .gateforge/runtime.yml',
        ].join('\n'),
        '.gateforge/runtime.yml': [
          'schemaVersion: 1',
          'services:',
          '  - id: app',
          `    command: node -e "/* ${marker} */ setTimeout(() => undefined, 120000)"`,
          '    ready:',
          '      log: never-matches',
          '      timeoutSeconds: 120',
          'envAllowlist: []',
        ].join('\n'),
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies: []\n',
        '.gateforge/classification-policy.yml':
          'schemaVersion: 1\nscanRoots: []\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations: {}\nvolatileFields: []\n',
        'src/accounts.js': '// fixture source.\n',
      });
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'runtime fixture']);
      repo.writeFiles({ 'src/accounts.js': '// staged change.\n' });
      repo.git(['add', 'src/accounts.js']);

      const child = spawn(process.execPath, [CLI_BIN, 'pre-commit', '--scope', 'staged'], {
        cwd: repo.root,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
      // The readiness wait is running once the service process exists.
      await waitFor(() => orphanCount(marker) === 1);
      child.kill('SIGINT');
      const code = await exited;
      expect(code === null || code !== 0).toBe(true);
      await waitFor(() => orphanCount(marker) === 0);
      expect(orphanCount(marker)).toBe(0);
    });
  });

  describe('runtime document loading', () => {
    const load = (cwd: string, runtimePath: string | undefined) => (): unknown =>
      loadRuntimeConfigAt(cwd, runtimePath);

    it('returns null when no document is configured (runtime off)', () => {
      expect(loadRuntimeConfigAt(tempDir(), undefined)).toBeNull();
    });

    it('a configured-but-missing document is a typed preparation failure', () => {
      const root = tempDir();
      expect(load(root, '.gateforge/runtime.yml')).toThrow(RuntimeBlockError);
      expect(load(root, '.gateforge/runtime.yml')).toThrow(/configured but missing/);
    });

    it('unparsable YAML is a typed preparation failure', () => {
      const root = tempDir();
      writeFileSync(join(root, 'runtime.yml'), 'services: [broken\n', 'utf8');
      expect(() => loadRuntimeConfigAt(root, 'runtime.yml')).toThrow(RuntimeBlockError);
      expect(() => loadRuntimeConfigAt(root, 'runtime.yml')).toThrow(/not parsable YAML/);
    });

    it('schema violations are typed and name the offending path', () => {
      const root = tempDir();
      writeFileSync(
        join(root, 'runtime.yml'),
        [
          'schemaVersion: 1',
          'services:',
          '  - id: app',
          '    command: node server.js',
          '    attested: true',
          '    ready:',
          '      log: ready',
        ].join('\n'),
        'utf8',
      );
      let message = '';
      try {
        loadRuntimeConfigAt(root, 'runtime.yml');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("violates its schema at 'services.0.");
      expect(message).toContain('fingerprint');
    });
  });
});
