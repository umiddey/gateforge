/**
 * Adversarial suite: two fake-green attempts that MUST be rejected.
 *
 *   (i) "transition rejected" claim that pretends the terminal-state
 *       write was rejected — but in our fake-green it would actually
 *       succeed. We assert the INVERTED claim is FALSE.
 *
 *   (ii) "audit emitted" claim that pretends an audit row exists — but
 *       in our fake-green we check the empty array. We assert the
 *       INVERTED claim is FALSE.
 *
 * Both tests intentionally assert the OPPOSITE of the fake-green
 * expectation. If a future contributor "fixes" the assertion to the
 * fake-green side, the test starts passing when the system is broken.
 * Keeping the assertions in the "this is wrong" direction prevents
 * that silent inversion.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { z } from 'zod';

const EXAMPLE_DIR = fileURLToPath(new URL('../../../example/workflow', import.meta.url));

interface ServerHandle {
  port: number;
  child: ChildProcess;
  cleanup: () => void;
}

const ErrorBodySchema = z.object({ error: z.string() });

const ContractSchema = z.object({ id: z.string() });

const AuditBodySchema = z.object({ rows: z.array(z.unknown()) });

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

async function bootServer(): Promise<ServerHandle> {
  mkdirSync(join(tmpdir(), `gateforge-workflow-adv-${process.pid}-${Math.random().toString(36).slice(2)}`), { recursive: true });
  writeFileSync(join(EXAMPLE_DIR, 'audit.json'), '[]\n');
  const port = 40000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, [join(EXAMPLE_DIR, 'server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await awaitReady(child);
  return {
    port,
    child,
    cleanup: () => {
      child.kill('SIGTERM');
      rmSync(EXAMPLE_DIR + '/audit.json', { force: true });
    },
  };
}

interface JsonResponse {
  status: number;
  body: unknown;
}

async function httpJson(method: string, path: string, body?: object): Promise<JsonResponse> {
  const port = (globalThis as { __WF_ADV_PORT__?: number }).__WF_ADV_PORT__;
  if (port === undefined) throw new Error('server not booted');
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let handle: ServerHandle;
beforeAll(async () => {
  handle = await bootServer();
  (globalThis as { __WF_ADV_PORT__?: number }).__WF_ADV_PORT__ = handle.port;
});
afterAll(() => { handle.cleanup(); });

beforeEach(async () => {
  await httpJson('POST', '/audit/reset');
  await httpJson('POST', '/contracts/reset');
});

describe('fake-green #1: "transition rejected" claim that is actually wrong', () => {
  it('REJECTS the fake-green: a terminal-state write MUST return 409, not 200', async () => {
    const created = await httpJson('POST', '/contracts', { actor: 'mallory', title: 'Bad-1' });
    const contractId = ContractSchema.parse(created.body).id;
    await httpJson('POST', `/contracts/${contractId}/transitions`, { actor: 'mallory', event: 'submit' });
    await httpJson('POST', `/contracts/${contractId}/transitions`, { actor: 'mallory', event: 'sign' });
    await httpJson('POST', `/contracts/${contractId}/transitions`, { actor: 'mallory', event: 'terminate' });

    // A fake-green test would assert `status === 200` (i.e. the write
    // succeeded) and call it "transition rejected" — clearly inverted.
    // The CORRECT assertion is `status === 409`.
    const violation = await httpJson('POST', `/contracts/${contractId}/transitions`, {
      actor: 'mallory',
      event: 'sign',
    });
    expect(violation.status).toBe(409); // CORRECT — server rejects terminal writes.
    expect(violation.status).not.toBe(200); // The fake-green claim would write 200 here; it must NOT.
    expect(ErrorBodySchema.parse(violation.body).error).toBe('terminal-state');
  });
});

describe('fake-green #2: "audit emitted" claim that is actually wrong', () => {
  it('REJECTS the fake-green: an invalid-jump attempt MUST NOT append an audit row', async () => {
    const created = await httpJson('POST', '/contracts', { actor: 'trent', title: 'Bad-2' });
    const contractId = ContractSchema.parse(created.body).id;
    const before = await httpJson('GET', '/audit');
    const beforeCount = AuditBodySchema.parse(before.body).rows.length;

    await httpJson('POST', `/contracts/${contractId}/transitions`, {
      actor: 'trent',
      event: 'sign', // invalid: draft -> signed
    });

    const after = await httpJson('GET', '/audit');
    const afterCount = AuditBodySchema.parse(after.body).rows.length;
    // CORRECT: the audit log MUST NOT grow. The fake-green claim
    // would assert the log grew by one — that is wrong, and we
    // explicitly reject it.
    expect(afterCount).toBe(beforeCount);
    expect(afterCount).not.toBe(beforeCount + 1);
  });
});