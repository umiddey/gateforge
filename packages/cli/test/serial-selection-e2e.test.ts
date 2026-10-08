/**
 * Serial-group selection through the actual CLI (the real consumer
 * failure): a serial describe of three dependent steps — step 1 writes a
 * record, step 3 reads the record step 1 created — where ONLY step 3 is
 * mapped. Before the fix a named selection of step 3 executes exactly
 * that `file:line`, so the journey runs without its own first step and
 * fails by construction; after the fix the run selects the WHOLE serial
 * group in file order, prints one expansion line per group, records the
 * expansion in the report, and never expands a NON-serial describe in
 * the same file.
 *
 * Nothing is mocked: a real loopback app answers the journey's writes
 * and reads, the real witness observes the proxied session traffic, and
 * the selection facts come from the real CLI process.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { endpointResourceName } from '@gate-forge/http-contract';
import { withTempRepo } from '@gate-forge/core';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt } from '../src/commands/common.js';
import {
  cleanupWitnessedFixture,
  installStrictFixture,
  operatorEnvironment,
  ROOT,
  FINGERPRINT,
  GATEFORGE_YML,
} from './witnessed-run-fixture.js';

const GROUP = 'journey';
const STEP_WRITE = 'writes the journey record';
const STEP_LIST = 'lists the journey record';
const STEP_READ = 'reads the journey record';
const STANDALONE_FIRST = 'a standalone check';
const STANDALONE_SECOND = 'another standalone check';

/** The read endpoint the policy requires and step 3 claims. */
const RECORDS_RESOURCE = endpointResourceName('GET', '/api/records/{}');
const RECORDS_REQUEST = `tenant.${RECORDS_RESOURCE}:http:request-observed`;
const RECORDS_STATUS = `tenant.${RECORDS_RESOURCE}:http:response-status-ok`;

const STEP3_KEY = `playwright:chromium:specs/journey.spec.js:${GROUP}>${STEP_READ}`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: 'specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { headless: true, trace: 'off', baseURL: process.env.TEST_SERVICE_URL },
  timeout: 30_000,
});
`;

const SPEC = `import { test as base, expect } from '@gate-forge/pack-playwright';

const test = base.extend({});

// The journey's shared state: the record id step 1 mints and step 3
// reads. Serial steps share module state by construction.
let createdId = '';

test.describe.serial('${GROUP}', () => {
  test('${STEP_WRITE}', async ({ request }) => {
    const response = await request.post('/api/records', { data: { name: 'journey-row' } });
    expect(response.status()).toBe(201);
    const body = await response.json();
    createdId = body.id;
  });

  test('${STEP_LIST}', async ({ request }) => {
    expect(createdId, 'step 1 must have run first').not.toBe('');
    const response = await request.get('/api/records');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.records.map((record) => record.id)).toContain(createdId);
  });

  test('${STEP_READ}', async ({ request }) => {
    expect(createdId, 'step 1 must have run first').not.toBe('');
    const response = await request.get('/api/records/' + createdId);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.record.name).toBe('journey-row');
  });
});

test.describe('standalone', () => {
  test('${STANDALONE_FIRST}', async ({ request }) => {
    const response = await request.get('/api/setup');
    expect(response.status()).toBe(200);
  });

  test('${STANDALONE_SECOND}', async ({ request }) => {
    const response = await request.get('/api/setup');
    expect(response.status()).toBe(200);
  });
});
`;

/**
 * The endpoint inventory: ONLY the read endpoint is classified, so the
 * policy owes exactly its two observation contracts and step 3 is the
 * only test that can prove them. The write and list routes stay plain
 * app behavior — the journey's own scaffolding.
 */
const API_DETECTOR = `import { endpointResourceName } from '@gate-forge/http-contract';

export default {
  async discover() {
    const at = (file, line) => ({ file, line, col: 0 });
    const resourceName = endpointResourceName('GET', '/api/records/{}');
    const resources = [{
      schemaVersion: 1,
      id: 'http.endpoint:records_read',
      kind: 'http.endpoint',
      source: 'src/api-routes.js',
      location: at('src/api-routes.js', 12),
      detectorVersion: '1.0.0',
      attributes: { resourceName, method: 'GET', canonicalPath: '/api/records/{}', identity: 'GET /api/records/{}' },
    }];
    const classificationSignals = [];
    for (const signal of [
      { dimension: 'plane', assertion: 'tenant' },
      { dimension: 'identity', assertion: ['GET', '/api/records/{}'] },
    ]) {
      classificationSignals.push({
        schemaVersion: 1,
        target: { resourceName },
        ...signal,
        basis: 'declaration',
        source: 'gateforge.fixture',
        location: at('src/api-routes.js', 12),
        detector: { id: 'gateforge.fixture', version: '1.0.0' },
      });
    }
    return { resources, unresolved: [], findings: [], classificationSignals };
  },
};
`;

/** The fixture app: the journey's write/list/read routes plus an unclaimed setup route. */
async function startJourneyApp(): Promise<{
  url: string;
  requestsByPath: Map<string, number>;
  stop: () => Promise<void>;
}> {
  const requestsByPath = new Map<string, number>();
  const records = new Map<string, string>();
  let seq = 0;
  const app = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    requestsByPath.set(path, (requestsByPath.get(path) ?? 0) + 1);
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-gateforge-env-fingerprint', FINGERPRINT);
    const readMatch = /^\/api\/records\/([^/]+)$/.exec(path);
    if (request.method === 'POST' && path === '/api/records') {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        const fields = JSON.parse(body || '{}') as { name?: string };
        seq += 1;
        const id = `rec-${String(seq)}`;
        records.set(id, fields.name ?? '');
        response.statusCode = 201;
        response.end(JSON.stringify({ id, name: fields.name ?? '' }));
      });
      return;
    }
    if (request.method === 'GET' && path === '/api/records') {
      response.end(JSON.stringify({ records: [...records.entries()].map(([id, name]) => ({ id, name })) }));
      return;
    }
    if (request.method === 'GET' && readMatch !== null) {
      const id = decodeURIComponent(readMatch[1] ?? '');
      if (!records.has(id)) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'absent' }));
        return;
      }
      response.end(JSON.stringify({ record: { id, name: records.get(id) } }));
      return;
    }
    if (request.method === 'GET' && path === '/api/setup') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => app.listen(0, 'localhost', resolve));
  const address = app.address() as AddressInfo;
  return {
    url: `http://localhost:${String(address.port)}`,
    requestsByPath,
    stop: () => new Promise<void>((resolve) => app.close(() => resolve())),
  };
}

async function runCliProcess(cwd: string, env: Record<string, string>, args: readonly string[]) {
  const child = spawn(process.execPath, [join(ROOT, 'packages/cli/bin/gateforge.js'), ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    // The only real-timer here is the bounded KILL GUARD for a spawned
    // CLI child process: a fake clock cannot control another process, and
    // the awaited condition is the child's own 'close' event, never a
    // fixed wait (same deliberate pattern as api-request-e2e.test.ts).
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`test-gates child timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 180_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (exitCode) => { clearTimeout(timeout); resolve(exitCode); });
  });
  return { code: code ?? 1, stdout, stderr };
}

/** The additive expansion record one serial group contributes to the report. */
interface SerialExpansionRecord {
  describe: string | null;
  file: string;
  added: number;
  logicalKeys: string[];
}

/** The JSON projection of a supervised run report this suite reads. */
interface RunReport {
  selectors?: Array<{ selector: string; logicalKeys: string[] }>;
  serialExpansions?: SerialExpansionRecord[];
  verdicts: Array<{ obligationId: string; verdict: string }>;
  execution?: {
    selectedTests?: { selected: number; passed: number; failed?: number };
  };
  summary: { blocking: number };
}

describe('serial-group selection through the actual CLI', () => {
  it('a named step of a serial journey selects the whole group and never the standalone describe', async () => {
    const app = await startJourneyApp();
    try {
      await withTempRepo({}, async (repo) => {
        installStrictFixture(repo, { 'specs/journey.spec.js': SPEC });
        repo.writeFiles({
          // Transport contracts only: the strict fixture's accounts
          // adapter would be a stale reference, so the config points at
          // an EMPTY adapters directory instead.
          '.gateforge.yml': `${GATEFORGE_YML.replace('adapters: .gateforge/adapters', 'adapters: .gateforge/adapters-api')}runtime: .gateforge/runtime.yml\n`,
          '.gateforge/adapters-api/.gitkeep': '',
          '.gateforge/runtime.yml': 'schemaVersion: 1\nenvAllowlist: [TEST_SERVICE_URL]\n',
          '.gateforge/fixture-detector.mjs': API_DETECTOR,
          '.gateforge/policies.yml': `schemaVersion: 1
policies:
  - id: records-read
    when:
      kind: http.endpoint
    require: [http:request-observed, http:response-status-ok]
`,
          'src/api-routes.js': '// fixture source: the records endpoint lives here.\n',
          'playwright.config.mjs': PLAYWRIGHT_CONFIG,
          // ONLY step 3 is mapped — the consumer's exact situation.
          '.gateforge/test-map.yml': `schemaVersion: 1
tests:
  - key: ${STEP3_KEY}
    selector:
      runner: playwright
      project: chromium
      file: specs/journey.spec.js
      titlePath: ['${GROUP}', '${STEP_READ}']
    kind: observed-e2e
    claims: ['${RECORDS_REQUEST}', '${RECORDS_STATUS}']
    reason: The serial journey's read step drives GET /api/records/{id} through the session proxy.
`,
        });
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'serial journey fixture']);
        const { env } = operatorEnvironment();
        const runEnv = {
          ...env,
          TEST_SERVICE_URL: app.url,
          GATEFORGE_APP_BASE_URL: app.url,
          GATEFORGE_TARGET_BASE_URL: app.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        };

        const named = await runCliProcess(
          repo.root,
          runEnv,
          ['test-gates', '--test', STEP3_KEY, '--result-only', '--format', 'json'],
        );
        const observed = `named run stdout:\n${named.stdout}\nstderr:\n${named.stderr}`;
        expect(named.code, observed).toBe(0);
        const report = JSON.parse(named.stdout) as RunReport;
        // The selector still resolves to exactly the named test.
        expect(report.selectors, observed).toEqual([{ selector: STEP3_KEY, logicalKeys: [STEP3_KEY] }]);
        // The WHOLE serial group ran: steps 1-3, in file order, green.
        expect(report.execution?.selectedTests, observed).toMatchObject({ selected: 3, passed: 3, failed: 0 });
        // Step 3's claims are graded and satisfied.
        for (const obligationId of [RECORDS_REQUEST, RECORDS_STATUS]) {
          expect(report.verdicts.find((verdict) => verdict.obligationId === obligationId), observed).toMatchObject({
            verdict: 'satisfied',
          });
        }
        // The run names each expansion on its output, and the report
        // records it.
        expect(
          named.stderr,
          `expansion line missing from the run output:\n${observed}`,
        ).toContain(`selection: added 2 tests of serial group '${GROUP}' (specs/journey.spec.js)`);
        expect(report.serialExpansions, observed).toEqual([
          { describe: GROUP, file: 'specs/journey.spec.js', added: 2, logicalKeys: [expect.any(String), expect.any(String)] },
        ]);
        // The expansion is the serial group ONLY: the two added keys are
        // the journey's own steps, never the standalone describe.
        const addedTitles = (report.serialExpansions?.[0]?.logicalKeys ?? []).join('\n');
        expect(addedTitles).toContain(STEP_WRITE);
        expect(addedTitles).toContain(STEP_LIST);
        expect(addedTitles).not.toContain(STANDALONE_FIRST);
        expect(addedTitles).not.toContain(STANDALONE_SECOND);
        // A non-serial describe is never expanded and never selected:
        // the standalone tests never reached the app.
        expect(app.requestsByPath.get('/api/setup'), observed).toBeUndefined();
        // A hand-picked selection never seals a gate receipt.
        expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
      });
    } finally {
      await app.stop();
    }
  }, 300_000);

  it('a changed-slice run keeps the whole file green and never prints a spurious expansion', async () => {
    const app = await startJourneyApp();
    try {
      await withTempRepo({}, async (repo) => {
        installStrictFixture(repo, { 'specs/journey.spec.js': SPEC });
        repo.writeFiles({
          '.gateforge.yml': `${GATEFORGE_YML.replace('adapters: .gateforge/adapters', 'adapters: .gateforge/adapters-api')}runtime: .gateforge/runtime.yml\n`,
          '.gateforge/adapters-api/.gitkeep': '',
          '.gateforge/runtime.yml': 'schemaVersion: 1\nenvAllowlist: [TEST_SERVICE_URL]\n',
          '.gateforge/fixture-detector.mjs': API_DETECTOR,
          '.gateforge/policies.yml': `schemaVersion: 1
policies:
  - id: records-read
    when:
      kind: http.endpoint
    require: [http:request-observed, http:response-status-ok]
`,
          'src/api-routes.js': '// fixture source: the records endpoint lives here.\n',
          'playwright.config.mjs': PLAYWRIGHT_CONFIG,
          '.gateforge/test-map.yml': `schemaVersion: 1
tests:
  - key: ${STEP3_KEY}
    selector:
      runner: playwright
      project: chromium
      file: specs/journey.spec.js
      titlePath: ['${GROUP}', '${STEP_READ}']
    kind: observed-e2e
    claims: ['${RECORDS_REQUEST}', '${RECORDS_STATUS}']
    reason: The serial journey's read step drives GET /api/records/{id} through the session proxy.
`,
        });
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'serial journey changed fixture']);
        repo.writeFiles({ 'src/api-routes.js': '// fixture source: the records endpoint lives here.\n// changed source\n' });
        repo.git(['add', 'src/api-routes.js']);
        const { env } = operatorEnvironment();
        const runEnv = {
          ...env,
          TEST_SERVICE_URL: app.url,
          GATEFORGE_APP_BASE_URL: app.url,
          GATEFORGE_TARGET_BASE_URL: app.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        };

        const changed = await runCliProcess(
          repo.root,
          runEnv,
          ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
        );
        const observed = `changed run stdout:\n${changed.stdout}\nstderr:\n${changed.stderr}`;
        expect(changed.code, observed).toBe(0);
        const report = JSON.parse(changed.stdout) as RunReport;
        // The changed slice is FILE-granular for playwright (the
        // required file's whole catalog runs), so the serial journey
        // runs complete and the receipt seals. The serial expansion
        // must add nothing here — every group member is already in the
        // plan — so no expansion line is printed and the report records
        // no expansion.
        expect(report.execution?.selectedTests, observed).toMatchObject({ selected: 5, passed: 5, failed: 0 });
        for (const obligationId of [RECORDS_REQUEST, RECORDS_STATUS]) {
          expect(report.verdicts.find((verdict) => verdict.obligationId === obligationId), observed).toMatchObject({
            verdict: 'satisfied',
          });
        }
        expect(changed.stderr, `expansion line printed for a whole-file slice:\n${observed}`).not.toContain(
          'selection: added',
        );
        expect(report.serialExpansions, observed).toBeUndefined();
        // The sealing run of the slice seals its receipt.
        expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json')), observed).toBe(true);
      });
    } finally {
      await app.stop();
    }
  }, 300_000);
});

afterEach(cleanupWitnessedFixture);
