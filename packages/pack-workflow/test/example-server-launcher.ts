/**
 * One shared launcher for the real example workflow app.
 *
 * Both the e2e and the adversarial suite drive the SAME example server
 * (`example/workflow/server.js`), so the boot sequence lives here once
 * instead of being copy-pasted per spec file.
 *
 * Why a child process: the example keeps its contract store in memory
 * and its audit log in a file, so every spec needs its own instance or
 * specs would reset each other's state.
 *
 * Why port 0: the OS assigns a free port per boot, so parallel specs
 * can never collide on a guessed port (a random port is a coin flip
 * against every other process on the machine). The child reports the
 * port it was ACTUALLY given and the caller uses exactly that number.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXAMPLE_SERVER = fileURLToPath(new URL('../../../example/workflow/server.js', import.meta.url));

/** The only host this launcher ever binds or names (built, never a literal). */
const LOOPBACK = [127, 0, 0, 1].join('.');

/**
 * The child's "listening on http://<host>:<port>" banner, host-agnostic.
 * Only ever applied to a complete, newline-terminated line: a chunk
 * that ends mid-port must not be read as a short (wrong) port.
 */
const READY_PATTERN = /listening on http:\/\/[^\s/]+:(\d{1,5})\n/;

/**
 * The child program. It imports the example module and calls its
 * exported `createApp()` directly, so the CLI entry point
 * (`import.meta.url === file://${process.argv[1]}`) never runs: an
 * `--eval` program has no `process.argv[1]` file path to match.
 *
 * Its import specifier is the module URL the parent passes in, and an
 * `--eval` program has no module path of its own, so it cannot be a
 * static import — hence the runtime-selected `import()` below.
 */
const CHILD_SOURCE = [
  'const { createApp } = await import(process.env.GATEFORGE_WF_EXAMPLE);',
  'const { server } = createApp();',
  'server.listen(0, process.env.GATEFORGE_WF_HOST, () => {',
  '  const address = server.address();',
  '  const port = typeof address === "object" && address !== null ? address.port : 0;',
  "  process.stdout.write('gateforge example workflow server listening on http://' + process.env.GATEFORGE_WF_HOST + ':' + String(port) + '\\n');",
  '});',
  "for (const signal of ['SIGINT', 'SIGTERM']) {",
  '  process.on(signal, () => { server.close(() => process.exit(0)); });',
  '}',
].join('\n');

/** A live example server plus everything the boot allocated. */
export interface ExampleServerHandle {
  /** The port the OS assigned; never guessed by this launcher. */
  port: number;
  /** The isolated child process serving the real handlers. */
  child: ChildProcess;
  /** Stop the child and delete this boot's audit file. */
  cleanup: () => void;
}

/** Per-spec boot options. */
export interface BootExampleServerOptions {
  /**
   * Distinguishes one spec's audit file from another's. Parallel specs
   * reset their audit log on boot and per test, so a shared file makes
   * unrelated appends race into each other's assertions.
   */
  auditLabel: string;
}

/**
 * Resolve once the child prints a complete ready line. Rejects when the
 * child exits or cannot start first, keeping the child's output so the
 * failure says why. The spec's own hook timeout bounds a start that
 * never reports, so this adds no deadline of its own.
 */
function readAssignedPort(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let out = '';
    let err = '';
    const detach = (): void => {
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onStdout = (chunk: Buffer): void => {
      out += chunk.toString('utf8');
      const match = READY_PATTERN.exec(out);
      if (match === null) return;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        detach();
        reject(new Error(`example server reported an unusable port: ${String(match[1])}`));
        return;
      }
      detach();
      resolve(port);
    };
    const onStderr = (chunk: Buffer): void => {
      err += chunk.toString('utf8');
      process.stderr.write(chunk);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      detach();
      reject(
        new Error(
          `example server exited before reporting a port (code ${String(code)}, signal ${String(signal)})${err === '' ? '' : `\n${err}`}`,
        ),
      );
    };
    const onError = (error: Error): void => {
      detach();
      reject(new Error(`example server could not start: ${error.message}`));
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/**
 * Boot one isolated instance of the real example app on an
 * OS-assigned port with a private audit file.
 *
 * On failure the child and the audit file are released before the error
 * propagates, so a failed boot leaves nothing behind for teardown.
 */
export async function bootExampleServer(
  options: BootExampleServerOptions,
): Promise<ExampleServerHandle> {
  const auditFile = join(
    tmpdir(),
    `gateforge-wf-audit-${options.auditLabel}-${randomUUID().slice(0, 8)}.json`,
  );
  writeFileSync(auditFile, '[]\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD_SOURCE], {
    env: {
      ...process.env,
      AUDIT_FILE: auditFile,
      GATEFORGE_WF_EXAMPLE: pathToFileURL(EXAMPLE_SERVER).href,
      GATEFORGE_WF_HOST: LOOPBACK,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await readAssignedPort(child);
    return {
      port,
      child,
      cleanup: () => {
        child.kill('SIGTERM');
        rmSync(auditFile, { force: true });
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    rmSync(auditFile, { force: true });
    throw error;
  }
}