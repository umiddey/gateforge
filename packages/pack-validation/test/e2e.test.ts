/**
 * E2E suite: boots the example validation server, exercises every
 * obligation contract the pack claims, and asserts the verdicts.
 *
 *   - validation:boundary-accepted        — a valid payload returns 201
 *   - validation:boundary-rejected        — an invalid payload returns 400
 *   - validation:no-side-effect-on-reject — a rejected payload leaves the
 *                                              in-memory store unchanged
 *   - validation:error-message-explicit   — the 400 names the failing field
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER_PATH = fileURLToPath(
  new URL('../../../example/validation/server.js', import.meta.url),
);

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, 'localhost', () => {
      const addr = probe.address();
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port;
        probe.close(() => resolve(port));
      } else {
        reject(new Error('no port'));
      }
    });
  });
}

async function awaitReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.includes('listening on')) {
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c: Buffer) => process.stderr.write(c));
    child.once('exit', (code) => reject(new Error(`server exited prematurely (code ${String(code)})`)));
  });
}

let baseUrl = '';
let child: ChildProcess | undefined;

beforeAll(async () => {
  const port = await pickFreePort();
  child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await awaitReady(child);
  baseUrl = `http://localhost:${port}`;
}, 30_000);

afterAll(() => {
  if (child !== undefined) child.kill('SIGTERM');
});

describe('e2e: validation:boundary-accepted', () => {
  it('valid payload returns 201', async () => {
    const res = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('e2e: validation:boundary-rejected', () => {
  it('too-long first_name returns 400', async () => {
    const res = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'x'.repeat(51), last_name: 'Lovelace', email: 'ada@example.com' }),
    });
    expect(res.status).toBe(400);
  });

  it('missing email returns 400', async () => {
    const res = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'Ada', last_name: 'Lovelace' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('e2e: validation:no-side-effect-on-reject', () => {
  it('a rejected payload does not create a row', async () => {
    // Snapshot current count
    const before = await fetch(`${baseUrl}/accounts`);
    const beforeList = (await before.json()) as { accounts: unknown[] };
    const beforeCount = beforeList.accounts.length;

    // Reject: invalid email
    const rejected = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'Bad', last_name: 'Request', email: 'not-an-email' }),
    });
    expect(rejected.status).toBe(400);

    // Count must not change
    const after = await fetch(`${baseUrl}/accounts`);
    const afterList = (await after.json()) as { accounts: unknown[] };
    expect(afterList.accounts.length).toBe(beforeCount);
  });
});

describe('e2e: validation:error-message-explicit', () => {
  it('the 400 body names the failing field', async () => {
    const res = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'Ada' }), // missing last_name + email
    });
    const body = (await res.json()) as { errors: Array<{ field: string }> };
    expect(res.status).toBe(400);
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
    const fields = body.errors.map((e) => e.field).sort();
    expect(fields).toContain('last_name');
  });
});
