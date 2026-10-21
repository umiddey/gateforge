/**
 * Session open must cost about the SLOWEST single observe snapshot,
 * never the sum (plan 20261021_0030_gf_infra_visibility, P1).
 *
 * `/sessions/open` takes every observe-declared resource's
 * before-snapshot itself (`takeObserveSnapshots`) and answers only
 * once they are stored — the before-state must exist before the test
 * acts. Those per-resource snapshots ran serially (one adapter
 * `list()` after another), so a session claiming N slow resources
 * paid N × list-time before the runner saw a session. The plan's
 * contract: the snapshots run CONCURRENTLY (Promise.all over the
 * sorted resource ids) and land in the stored map in the same sorted
 * order, so the map is byte-identical — only the wall clock moves.
 *
 * 4 observe resources whose adapter `list()` each waits 1.5 s:
 * serial ≈ 6 s, concurrent ≈ 1.5 s. This gate: open answers < 3 s,
 * AND the wait really happened (elapsed ≥ the single list delay —
 * open never returns before every snapshot is stored), AND every
 * resource's before-snapshot really completed (`/observe/finalize`
 * must reach the traffic check, never report a missing snapshot).
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import { ENV_FINGERPRINT_HEADER, RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

/** A started loopback fingerprint target and its closer. */
interface FingerprintTarget {
  url: string;
  stop: () => Promise<void>;
}

const RUN_ID = 'run-open-concurrency';
const RUN_BEARER = 'token-open-concurrency';
const VERIFIER_KEY = 'verifier-open-concurrency';
const RESOURCES = ['r1', 'r2', 'r3', 'r4'];
const OBLIGATIONS = RESOURCES.map((resource) => `${resource}:persistence:create`);
const LIST_DELAY_MS = 1_500;
const FINGERPRINT = 'fp-open-concurrency';

/** Loopback target every adapter reads: answers GET with the marker header. */
async function startFingerprintTarget(): Promise<FingerprintTarget> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      [ENV_FINGERPRINT_HEADER]: FINGERPRINT,
    });
    res.end('{}');
  });
  // Node 20 and the project's ES2023 lib do not provide
  // Promise.withResolvers (see packages/cli/src/commands/enforcement.ts).
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fingerprint target failed to bind');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

/** One slow-list adapter per resource, as the registry loads `.mjs` files. */
function adapterSource(resourceId: string, baseUrl: string): string {
  return `
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
export default {
  read: async () => null,
  normalize: (body) => ({
    entityId: body === null || body === undefined ? null : body.id,
    fields: {},
  }),
  deletion: 'hard',
  environmentFingerprint: ${JSON.stringify(FINGERPRINT)},
  baseUrl: ${JSON.stringify(baseUrl)},
  list: async () => {
    await delay(${JSON.stringify(LIST_DELAY_MS)});
    return [];
  },
  observe: { create: { method: 'POST', path: ${JSON.stringify(`/api/${resourceId}`)} } },
};
`;
}

describe('session open: observe snapshots run concurrently (plan P1)', () => {
  const adaptersDir = join(mkdtempSync(join(tmpdir(), 'gf-open-concurrency-')), 'adapters');
  let target: FingerprintTarget;
  let witness: WitnessHandle;

  afterAll(async () => {
    await witness?.stop();
    await target?.stop();
    rmSync(join(adaptersDir, '..'), { recursive: true, force: true });
  });

  it('answers a 4-slow-resource open in under one serial round (and stores every snapshot)', async () => {
    target = await startFingerprintTarget();
    mkdirSync(adaptersDir, { recursive: true });
    for (const resource of RESOURCES) {
      writeFileSync(join(adaptersDir, `${resource}.mjs`), adapterSource(resource, target.url));
    }
    witness = await startWitness({
      runId: RUN_ID,
      token: RUN_BEARER,
      verifierKey: VERIFIER_KEY,
      adaptersDir,
    });
    const supervisorHeaders = {
      [RUN_HEADER]: RUN_BEARER,
      [VERIFIER_HEADER]: VERIFIER_KEY,
      'content-type': 'application/json',
    };

    const bound = await fetch(`${witness.url}/runs/observe-declarations`, {
      method: 'POST',
      headers: supervisorHeaders,
      body: JSON.stringify({ obligations: OBLIGATIONS }),
    });
    expect(bound.status).toBe(200);

    // The gate: 4 × 1.5 s serial ≈ 6 s today; concurrent ≈ 1.5 s.
    // < 3 s admits one full list time plus scheduling slack, and
    // still fails while the snapshots run one after another.
    // Real wall-clock time is the SUBJECT here (a real end-to-end
    // open latency against real adapter delays, measured across a
    // live HTTP round trip) — deterministic fake timers cannot
    // produce it (rule exception, named per the test-timer rule).
    const openedAt = performance.now();
    const open = await fetch(`${witness.url}/sessions/open`, {
      method: 'POST',
      headers: supervisorHeaders,
      body: JSON.stringify({ testId: 'open-concurrency', workerIndex: 0, claims: OBLIGATIONS }),
    });
    const openElapsedMs = performance.now() - openedAt;
    expect(open.status).toBe(200);
    const session = (await open.json()) as { sessionId: string };

    // The wait really happened: open never returns before every
    // before-snapshot is stored, so it can never beat one list delay.
    expect(openElapsedMs).toBeGreaterThanOrEqual(LIST_DELAY_MS - 100);
    expect(openElapsedMs).toBeLessThan(3_000);

    // Every resource's before-snapshot completed: finalize must reach
    // its traffic check ("no POST … exchange"), never report a
    // missing or failed before-snapshot.
    const finalize = await fetch(`${witness.url}/observe/finalize`, {
      method: 'POST',
      headers: supervisorHeaders,
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    expect(finalize.status).toBe(200);
    const report = (await finalize.json()) as { finalized: unknown[]; notes: string[] };
    expect(report.finalized).toEqual([]);
    expect(report.notes).toHaveLength(RESOURCES.length);
    for (const resource of RESOURCES) {
      const note = report.notes.find((entry) => entry.startsWith(`observe '${resource}:persistence:create': `));
      expect(note, `finalize note for '${resource}'`).toBeDefined();
      expect(note).toMatch(new RegExp(`no POST /api/${resource} exchange`));
      expect(note).not.toMatch(/before-snapshot/);
    }
  });
});
