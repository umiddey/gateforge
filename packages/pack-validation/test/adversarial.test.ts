/**
 * Adversarial: fake-green rejection. Encodes the WRONG expectation;
 * vitest must catch the fake-green and fail the test. Uses .fails so
 * the suite reads as "expected fake-green caught" rather than
 * "broken test".
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, it } from 'vitest';

const SERVER_PATH = fileURLToPath(
  new URL('../../../example/validation/server.js', import.meta.url),
);

let baseUrl = '';
let child: ChildProcess | undefined;

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, 'localhost', () => {
      const addr = probe.address();
      if (typeof addr === 'object' && addr !== null) {
        const p = addr.port;
        probe.close(() => resolve(p));
      } else reject(new Error('no port'));
    });
  });
  child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.includes('listening on')) {
        child!.stdout?.off('data', onData);
        resolve();
      }
    };
    child!.stdout?.on('data', onData);
    child!.stderr?.on('data', (c: Buffer) => process.stderr.write(c));
    child!.once('exit', (code) => reject(new Error(`server exited (code ${String(code)})`)));
  });
  baseUrl = `http://localhost:${port}`;
}, 30_000);

afterAll(() => {
  if (child !== undefined) child.kill('SIGTERM');
});

it.fails('REJECTS fake-green: 200 to an invalid email payload', async () => {
  // Fake-green: claim the server accepts an invalid email with 200.
  // The CORRECT response is 400.
  const res = await fetch(`${baseUrl}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ first_name: 'X', last_name: 'Y', email: 'not-an-email' }),
  });
  // The fake-green assertion: status 200. Server returns 400 -> test fails -> caught.
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
});
