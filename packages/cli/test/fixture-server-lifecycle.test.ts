import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER = join(TEST_DIR, 'fixtures/race-app/server.mjs');
const PARENT_SOURCE = `
const { spawn } = require('node:child_process');
const server = spawn(process.execPath, [process.argv[1]], { stdio: ['pipe', 'pipe', 'ignore'] });
let output = '';
let reported = false;
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  output += chunk;
  if (!reported && output.includes('race fixture app listening on ')) {
    reported = true;
    process.stdout.write(String(server.pid) + '\\n');
  }
});
server.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Promise.withResolvers is not present in the repository's ES2023 lib. */
function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// This integration test observes an orphaned OS process from a second
// process; fake timers cannot advance the kernel's process exit, so polling
// against the real five-second contract is intentional.
async function waitForPidExit(pid: number, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return;
    const delay = withResolvers<void>();
    setTimeout(delay.resolve, 25);
    await delay.promise;
  }
  throw new Error(`fixture server PID ${pid} survived parent death`);
}

describe('fixture server parent lifetime', () => {
  it('exits within five seconds when its parent is SIGKILLed', async () => {
    const parent = spawn(process.execPath, ['-e', PARENT_SOURCE, SERVER], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let fixturePid: number | undefined;
    let parentStderr = '';
    parent.stderr?.setEncoding('utf8').on('data', (chunk: string) => { parentStderr += chunk; });

    try {
      const ready = withResolvers<number>();
      let stdout = '';
      let settled = false;
      // This deadline is wall-clock by design: the test must prove a
      // real child process starts and exits within the owner's five seconds.
      const timer = setTimeout(() => {
        finish(new Error(`parent did not start the fixture server\n${parentStderr}`));
      }, 5_000);
      const finish = (error: Error | null, pid?: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== null) ready.reject(error);
        else if (pid === undefined) ready.reject(new Error('parent reported no fixture PID'));
        else ready.resolve(pid);
      };
      parent.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        const match = /(?:^|\n)(\d+)\r?\n/.exec(stdout);
        if (match !== null) finish(null, Number(match[1]));
      });
      parent.once('error', (error) => finish(error));
      parent.once('exit', (code, signal) => {
        finish(new Error(`parent exited before fixture readiness (code ${String(code)}, signal ${String(signal)})\n${parentStderr}`));
      });
      const pid = await ready.promise;
      fixturePid = pid;

      const deadline = Date.now() + 5_000;
      const parentExit = once(parent, 'exit');
      parent.kill('SIGKILL');
      await parentExit;
      await waitForPidExit(pid, deadline);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        const parentExit = once(parent, 'exit');
        parent.kill('SIGKILL');
        await parentExit;
      }
      if (fixturePid !== undefined && pidExists(fixturePid)) {
        process.kill(fixturePid, 'SIGKILL');
        await waitForPidExit(fixturePid, Date.now() + 1_000);
      }
    }

    const pid = fixturePid;
    if (pid === undefined) throw new Error('fixture PID was not captured');
    expect(pidExists(pid)).toBe(false);
  }, 15_000);
});
