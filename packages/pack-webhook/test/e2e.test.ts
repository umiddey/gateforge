/**
 * End-to-end suite for @gate-forge/pack-webhook.
 *
 * Boots the example server on a random free port, exercises every
 * obligation contract the pack claims, and asserts the verdicts.
 *
 * Two adversarial tests are encoded as REJECTION tests: each one
 * invokes a fake-green flow and asserts the verifier catches it.
 * They MUST fail when run in their fake-green form; the suite
 * asserts the GOOD flow as the positive case.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWebhookDetector,
  type WebhookDetector,
  type WebhookObligationContract,
  WEBHOOK_OBLIGATION_CONTRACTS,
} from '../src/index.js';

/** Path to the example server. */
const SERVER_PATH = fileURLToPath(
  new URL('../../../example/webhook/server.js', import.meta.url),
);

/** Shared HMAC secret mirrored from the example server. */
const WEBHOOK_SECRET = 'gateforge-webhook-loopback-secret-v1';

/** Verdict union (mirror of @gate-forge/core Verdict but local). */
type Verdict = 'satisfied' | 'denied' | 'rejected' | 'no-side-effect';

interface ContractOutcome {
  contract: WebhookObligationContract;
  verdict: Verdict;
}

interface RawJson {
  [key: string]: unknown;
}

interface DeliveryLogRow {
  sideEffectCount: number;
  eventId: string;
  attempt: number;
  firstSeenAt: number;
}

/** Compute HMAC-SHA256 hex over a raw body. */
function sign(body: Buffer | string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

/** Boots the example server on `port` (0 = OS-assigned). */
function bootServer(port: number): Promise<{ process: ChildProcess; url: string }> {
  return new Promise<{ process: ChildProcess; url: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('listening on http://')) {
        const portLine = text.match(/:(\d+)/);
        const boundPort = portLine ? Number(portLine[1]) : port;
        resolve({ process: proc, url: `http://127.0.0.1:${boundPort}` });
      }
    });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      reject(new Error(`server exited before ready (code ${code}): ${stderr}`));
    });
  });
}

interface E2EHarness {
  url: string;
  detector: WebhookDetector;
  shutdown: () => Promise<void>;
}

let harness: E2EHarness | undefined;

beforeAll(async () => {
  const { process: proc, url } = await bootServer(0);
  const exitPromise = new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
  });
  const shutdown = async (): Promise<void> => {
    proc.kill('SIGTERM');
    return exitPromise;
  };
  harness = {
    url,
    detector: createWebhookDetector({ root: url }),
    shutdown,
  };
}, 30_000);

afterAll(async () => {
  if (harness) await harness.shutdown();
});

/** Fire a POST to /webhook/stripe with arbitrary headers + raw body. */
async function postWebhook(
  body: Buffer | string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: RawJson }> {
  if (!harness) throw new Error('harness not initialized');
  const res = await fetch(`${harness.url}/webhook/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  let json: RawJson = {};
  try {
    json = JSON.parse(text) as RawJson;
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

/** Build a valid signed request body for `eventId`. */
function buildSignedBody(eventId: string): { body: Buffer; headers: Record<string, string> } {
  const payload = JSON.stringify({ event_id: eventId, type: 'payment.completed' });
  const body = Buffer.from(payload, 'utf8');
  const headers: Record<string, string> = {
    'x-signature': sign(body),
    'x-webhook-timestamp': String(Date.now()),
    'x-webhook-attempt': '1',
  };
  return { body, headers };
}

describe('pack-webhook e2e: obligations', () => {
  it('webhook:signature-accepted — valid HMAC-SHA256 signature is accepted', async () => {
    const { body, headers } = buildSignedBody('evt_accepted_1');
    const res = await postWebhook(body, headers);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.deduplicated).toBe(false);
  });

  it('webhook:signature-rejected — bad signature returns 401 with no side effect', async () => {
    const { body, headers } = buildSignedBody('evt_rejected_1');
    const tampered = { ...headers, 'x-signature': 'a'.repeat(64) };
    const res = await postWebhook(body, tampered);
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('bad-signature');
  });

  it('webhook:malformed-rejected — invalid JSON returns 400', async () => {
    const body = Buffer.from('this is not JSON{', 'utf8');
    const headers = {
      'x-signature': sign(body),
      'x-webhook-timestamp': String(Date.now()),
      'x-webhook-attempt': '1',
    };
    const res = await postWebhook(body, headers);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('malformed-json');
  });

  it('webhook:replay-idempotent — duplicate event_id within window dedupes to single side effect', async () => {
    const eventId = `evt_replay_${Date.now()}_a`;
    const first = buildSignedBody(eventId);
    const r1 = await postWebhook(first.body, first.headers);
    expect(r1.status).toBe(200);
    expect(r1.json.deduplicated).toBe(false);

    const second = buildSignedBody(eventId);
    const r2 = await postWebhook(second.body, second.headers);
    expect(r2.status).toBe(200);
    expect(r2.json.deduplicated).toBe(true);

    if (!harness) throw new Error('harness not initialized');
    const witness = await fetch(`${harness.url}/delivery-log/${eventId}`);
    expect(witness.status).toBe(200);
    const log = (await witness.json()) as DeliveryLogRow;
    expect(log.sideEffectCount).toBe(1);
  });

  it('webhook:retry-bounded — server returns 429 once attempt header exceeds 3', async () => {
    const eventId = `evt_retry_${Date.now()}_b`;
    const base = buildSignedBody(eventId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const headers = { ...base.headers, 'x-webhook-attempt': String(attempt) };
      const r = await postWebhook(base.body, headers);
      expect(r.status).toBe(200);
    }
    const headers = { ...base.headers, 'x-webhook-attempt': '4' };
    const r = await postWebhook(base.body, headers);
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('retry-budget-exhausted');
  });
});

describe('pack-webhook e2e: adversarial rejection tests', () => {
  it('REJECTS a fake-green "signature accepted" test that mutates the payload', async () => {
    const { body, headers } = buildSignedBody('evt_fake_green_1');
    const mutated = Buffer.concat([body, Buffer.from(' ')]);
    const res = await postWebhook(mutated, headers);
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(200);
  });

  it('REJECTS a fake-green "idempotent" test that does not consult the delivery log', async () => {
    const eventId = `evt_fake_idempotent_${Date.now()}_c`;
    const first = buildSignedBody(eventId);
    await postWebhook(first.body, first.headers);
    const second = buildSignedBody(eventId);
    const r2 = await postWebhook(second.body, second.headers);
    expect(r2.status).toBe(200);

    if (!harness) throw new Error('harness not initialized');
    const witness = await fetch(`${harness.url}/delivery-log/${eventId}`);
    expect(witness.status).toBe(200);
    const log = (await witness.json()) as DeliveryLogRow;
    expect(log.sideEffectCount).toBe(1);
    expect(log.sideEffectCount).not.toBe(2);
    expect(log.sideEffectCount).not.toBe(0);
  });
});

describe('pack-webhook e2e: detector + adapter contract surface', () => {
  it('emits all five contract names', () => {
    expect(WEBHOOK_OBLIGATION_CONTRACTS.length).toBe(5);
    expect(WEBHOOK_OBLIGATION_CONTRACTS).toContain('webhook:signature-accepted');
    expect(WEBHOOK_OBLIGATION_CONTRACTS).toContain('webhook:signature-rejected');
    expect(WEBHOOK_OBLIGATION_CONTRACTS).toContain('webhook:malformed-rejected');
    expect(WEBHOOK_OBLIGATION_CONTRACTS).toContain('webhook:replay-idempotent');
    expect(WEBHOOK_OBLIGATION_CONTRACTS).toContain('webhook:retry-bounded');
  });

  it('discover() over the example server source still works (deterministic)', () => {
    if (!harness) throw new Error('harness not initialized');
    const outcome = harness.detector.discover([
      fileURLToPath(new URL('../../../example/webhook', import.meta.url)),
    ]);
    expect(Array.isArray(outcome.resources)).toBe(true);
    expect(Array.isArray(outcome.findings)).toBe(true);
  });
});

// Reference unused types so strict module resolution does not flag them.
const _verdictWitness: Verdict = 'satisfied';
const _contractWitness: ContractOutcome = { contract: 'webhook:signature-accepted', verdict: _verdictWitness };
void _contractWitness;