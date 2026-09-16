/**
 * Reporter CJS-shim supervision tests (E22 integration follow-up): the
 * `require` condition of `@gate-forge/pack-playwright/reporter` is the
 * path Playwright ACTUALLY loads for the documented config wiring
 * (`reporter: [['@gate-forge/pack-playwright/reporter']]` resolves
 * through require). The shim buffers every runner callback until the
 * ESM implementation arrives, and these tests pin the two regressions
 * that silently broke receipt-sealed supervised runs:
 *
 * 1. `onTestBegin`/`onTestEnd` (the lifecycle events the TRUSTED CLI's
 *    spool drain turns into witness session open/close — enforcement-
 *    review fix 3) must reach the run-state SPOOL: a dropped event means
 *    the supervisor never opens/seals that session and every evidence
 *    primitive fails closed with "no open witness session".
 * 2. `onEnd(FullResult)` must forward the RESULT — it is the only
 *    source of the outcomes document's final `runStatus` the
 *    supervisor reads (a dropped result fails every run as 'unknown').
 *
 * Runs the BUILT shim (`dist/reporter/reporter.cjs`) against a stub
 * loopback witness; no browsers, no network beyond loopback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPack } from './helpers.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHIM_PATH = join(ROOT, 'packages/pack-playwright/dist/reporter/reporter.cjs');

const CLEANUPS: Array<() => void> = [];

afterAll(() => {
  for (const cleanup of CLEANUPS.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  CLEANUPS.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/** A stub loopback witness: session open/close + ledger reads. */
async function stubWitness(): Promise<{ url: string; calls: Recorded[] }> {
  const calls: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      calls.push({ method: req.method ?? '', path, body });
      const answer = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (path === '/sessions/open') {
        answer(200, {
          sessionId: 'sess-1',
          sessionToken: 'stok-1',
          testId: body['testId'] ?? 'unknown',
          workerIndex: body['workerIndex'] ?? 0,
          openedTick: 1,
          proxyUrl: null,
        });
        return;
      }
      if (path === '/sessions/close') {
        answer(200, { sessionId: body['sessionId'] ?? 'sess-1', outcome: body['outcome'] ?? 'passed' });
        return;
      }
      if (path === '/records') {
        answer(200, { records: [] });
        return;
      }
      if (path === '/classifications') {
        answer(200, { resources: {} });
        return;
      }
      answer(404, { error: `stub witness has no route ${path}` });
    });
  });
  server.listen(0, '127.0.0.1');
  CLEANUPS.push(() => server.close());
  const address = await new Promise<{ address: string; port: number }>((resolveListen, rejectListen) => {
    server.once('listening', () => resolveListen(server.address() as { address: string; port: number }));
    server.once('error', rejectListen);
  });
  if (typeof address === 'string') throw new Error('no stub witness port');
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

/** A playwright-shaped suite hierarchy: root → project → file → describes. */
function suiteHierarchy() {
  const root = { type: 'root' as const, title: '', location: null, parent: null };
  const project = { type: 'project' as const, title: 'chromium', location: null, parent: root };
  const file = {
    type: 'file' as const,
    title: 'accounts.spec.js',
    location: { file: '/tmp/x/specs/accounts.spec.js', line: 1, column: 0 },
    parent: project,
  };
  const outer = {
    type: 'describe' as const,
    title: 'Accounts',
    location: { file: '/tmp/x/specs/accounts.spec.js', line: 2, column: 0 },
    parent: file,
  };
  return { root, project, file, outer };
}

describe('reporter CJS shim (the require-condition entry Playwright loads)', () => {
  beforeAll(() => {
    const build = buildPack();
    expect(build.status, `pack build failed:\n${build.stderr}`).toBe(0);
  });

  it('writes the lifecycle spool events (the supervisor session open/close input survives require)', async () => {
    const witness = await stubWitness();
    const stateDir = tempDir('gateforge-shim-state-');
    mkdirSync(stateDir, { recursive: true });
    const runId = 'shim-run';
    // Enforcement-review fix 3: the runner child holds NO supervisor
    // rights — onTestBegin/onTestEnd append lifecycle events (identities
    // and outcomes, no secrets) to the spool, and the TRUSTED CLI drains
    // them into witness session open/close. The regression this pins:
    // the buffered dispatch must survive the require boundary and land
    // in the spool in order, or the supervisor never opens the session.
    const spoolFile = join(stateDir, 'spool', runId, 'events.jsonl');
    const { GateforgeReporter } = createRequire(import.meta.url)(SHIM_PATH) as {
      GateforgeReporter: new (options: Record<string, unknown>) => {
        onTestBegin: (test: unknown, result: unknown) => void;
        onTestEnd: (test: unknown, result: unknown) => void;
        onEnd: (result?: { status?: string }) => Promise<void>;
      };
    };
    const previous = {
      WITNESS: process.env['GATEFORGE_WITNESS_URL'],
      TOKEN: process.env['GATEFORGE_RUN_TOKEN'],
      STATE: process.env['GATEFORGE_STATE_DIR'],
      RUN: process.env['GATEFORGE_RUN_ID'],
    };
    process.env['GATEFORGE_WITNESS_URL'] = witness.url;
    process.env['GATEFORGE_RUN_TOKEN'] = 'shim-run-token';
    process.env['GATEFORGE_STATE_DIR'] = stateDir;
    process.env['GATEFORGE_RUN_ID'] = runId;
    try {
      const reporter = new GateforgeReporter({});
      const hierarchy = suiteHierarchy();
      // Called IMMEDIATELY after construction: the ESM implementation has
      // not loaded yet, so the call is buffered and replayed in order.
      reporter.onTestBegin(
        {
          id: 't-1',
          title: 'creates an account',
          location: { file: '/tmp/x/specs/accounts.spec.js', line: 9, column: 0 },
          parent: hierarchy.outer,
        },
        { workerIndex: 0 },
      );
      reporter.onTestEnd(
        {
          id: 't-1',
          title: 'creates an account',
          location: { file: '/tmp/x/specs/accounts.spec.js', line: 9, column: 0 },
          parent: hierarchy.outer,
        },
        { status: 'passed', workerIndex: 0, retry: 0 },
      );
      // The buffered calls replay once the ESM implementation arrives;
      // poll for both spool events instead of guessing a sleep.
      const readEvents = (): Array<Record<string, unknown>> => {
        try {
          return readFileSync(spoolFile, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        } catch {
          return [];
        }
      };
      const deadline = Date.now() + 10_000;
      let events = readEvents();
      while (
        !events.some((event) => event['kind'] === 'testBegin') ||
        !events.some((event) => event['kind'] === 'testEnd')
      ) {
        if (Date.now() > deadline) throw new Error(`the shim never wrote the lifecycle spool events: ${spoolFile}`);
        await new Promise((resolveSettle) => setTimeout(resolveSettle, 50));
        events = readEvents();
      }
      // Exactly one begin and one end, in order, carrying the supervisor
      // join identity (the drain opens/seals the session from these).
      const begins = events.filter((event) => event['kind'] === 'testBegin');
      const ends = events.filter((event) => event['kind'] === 'testEnd');
      expect(begins).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(begins[0]).toMatchObject({
        testId: 't-1',
        workerIndex: 0,
        titlePath: ['Accounts', 'creates an account'],
        project: 'chromium',
      });
      // The file is the cwd-relative identity join key (ends with the
      // spec path regardless of where the monorepo is checked out).
      expect(String(begins[0]?.['file'])).toMatch(/specs\/accounts\.spec\.js$/);
      expect(ends[0]).toMatchObject({
        testId: 't-1',
        workerIndex: 0,
        outcome: 'passed',
        attempt: 1,
      });
      expect(events.indexOf(begins[0] as never)).toBeLessThan(events.indexOf(ends[0] as never));
      // The runner performed no privileged witness call at all.
      expect(witness.calls.some((call) => call.path.startsWith('/sessions'))).toBe(false);
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('GATEFORGE_WITNESS_URL', previous.WITNESS);
      restore('GATEFORGE_RUN_TOKEN', previous.TOKEN);
      restore('GATEFORGE_STATE_DIR', previous.STATE);
      restore('GATEFORGE_RUN_ID', previous.RUN);
    }
  });

  it('forwards the onEnd result so the outcomes document carries the final run status + identity', async () => {
    const witness = await stubWitness();
    const stateDir = tempDir('gateforge-shim-outcomes-');
    mkdirSync(stateDir, { recursive: true });
    const outcomesPath = join(stateDir, 'runner-outcomes.json');
    const { GateforgeReporter } = createRequire(import.meta.url)(SHIM_PATH) as {
      GateforgeReporter: new (options: Record<string, unknown>) => {
        onTestEnd: (test: unknown, result: unknown) => void;
        onEnd: (result?: { status?: string }) => Promise<void>;
      };
    };
    const previous = {
      WITNESS: process.env['GATEFORGE_WITNESS_URL'],
      TOKEN: process.env['GATEFORGE_RUN_TOKEN'],
      STATE: process.env['GATEFORGE_STATE_DIR'],
      OBLIGATIONS: process.env['GATEFORGE_OBLIGATIONS'],
      OUTCOMES: process.env['GATEFORGE_OUTCOMES_FILE'],
    };
    process.env['GATEFORGE_WITNESS_URL'] = witness.url;
    process.env['GATEFORGE_RUN_TOKEN'] = 'shim-run-token';
    process.env['GATEFORGE_STATE_DIR'] = stateDir;
    delete process.env['GATEFORGE_OBLIGATIONS'];
    process.env['GATEFORGE_OUTCOMES_FILE'] = outcomesPath;
    try {
      const reporter = new GateforgeReporter({});
      const hierarchy = suiteHierarchy();
      reporter.onTestEnd(
        {
          id: 't-9',
          title: 'archives the account',
          location: { file: '/tmp/x/specs/accounts.spec.js', line: 41, column: 0 },
          parent: hierarchy.outer,
        },
        { status: 'passed', workerIndex: 0, retry: 0 },
      );
      await reporter.onEnd({ status: 'passed' });
      const document = JSON.parse(readFileSync(outcomesPath, 'utf8')) as {
        runStatus: string | null;
        runnerErrors: string[];
        outcomes: Array<{ testId: string; file: string; titlePath: string[]; project: string | null }>;
      };
      // THE regression: the shim must forward the FullResult, or the
      // supervisor reads runStatus 'unknown' and fails every run.
      expect(document.runStatus).toBe('passed');
      expect(document.runnerErrors).toEqual([]);
      // The identity join: catalog-shape titlePath (describes + title,
      // project/file suites stripped) + project from the project suite.
      expect(document.outcomes).toHaveLength(1);
      expect(document.outcomes[0]).toMatchObject({
        testId: 't-9',
        titlePath: ['Accounts', 'archives the account'],
        project: 'chromium',
        status: 'passed',
        attempt: 1,
        expectedFailure: false,
      });
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('GATEFORGE_WITNESS_URL', previous.WITNESS);
      restore('GATEFORGE_RUN_TOKEN', previous.TOKEN);
      restore('GATEFORGE_STATE_DIR', previous.STATE);
      restore('GATEFORGE_OBLIGATIONS', previous.OBLIGATIONS);
      restore('GATEFORGE_OUTCOMES_FILE', previous.OUTCOMES);
    }
  });

  it('throws nothing and delegates cleanly when the pack loads (onEnd resolves)', async () => {
    // The failure mode opposite to the regressions above: a healthy pack
    // load must resolve the awaited callback — evidence is never
    // silently dropped, and a broken load throws (typed, not swallowed).
    const witness = await stubWitness();
    const stateDir = tempDir('gateforge-shim-healthy-');
    const { GateforgeReporter } = createRequire(import.meta.url)(SHIM_PATH) as {
      GateforgeReporter: new (options: Record<string, unknown>) => { onEnd: (result?: { status?: string }) => Promise<void> };
    };
    const previous = {
      WITNESS: process.env['GATEFORGE_WITNESS_URL'],
      TOKEN: process.env['GATEFORGE_RUN_TOKEN'],
      STATE: process.env['GATEFORGE_STATE_DIR'],
    };
    process.env['GATEFORGE_WITNESS_URL'] = witness.url;
    process.env['GATEFORGE_RUN_TOKEN'] = 'shim-run-token';
    process.env['GATEFORGE_STATE_DIR'] = stateDir;
    try {
      const reporter = new GateforgeReporter({});
      await expect(reporter.onEnd({ status: 'passed' })).resolves.toBeUndefined();
    } finally {
      if (previous.WITNESS === undefined) delete process.env['GATEFORGE_WITNESS_URL'];
      else process.env['GATEFORGE_WITNESS_URL'] = previous.WITNESS;
      if (previous.TOKEN === undefined) delete process.env['GATEFORGE_RUN_TOKEN'];
      else process.env['GATEFORGE_RUN_TOKEN'] = previous.TOKEN;
      if (previous.STATE === undefined) delete process.env['GATEFORGE_STATE_DIR'];
      else process.env['GATEFORGE_STATE_DIR'] = previous.STATE;
    }
  });
});
