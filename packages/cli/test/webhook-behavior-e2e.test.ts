/**
 * Engine-level end-to-end proof for the `webhook` namespace (plan
 * 2026-09-25 Phase 0/Phase 1): the real CLI over a real fixture
 * repository, the pack's own example webhook receiver
 * (`example/webhook/server.js`) behind the loopback attestation proxy,
 * the witness `test-gates` spawns itself, and post-suite verdict
 * evaluation through `check --require-e2e`.
 *
 * The point of this suite is the PATH, not the pack: nothing here
 * exercises the detector or the example server directly. Every case is
 * driven by the witness from the owner-declared behavior document, and
 * the only thing the test body does is name one approved case id. A
 * test cannot assert its own way to a green gate.
 *
 * The three cases are the plan's webhook demo:
 *   - signature-accepted  — a valid HMAC-SHA256 over the exact raw bytes
 *     is accepted and the receiver's delivery log gains exactly one row;
 *   - signature-rejected  — a forged signature is rejected (401) and the
 *     delivery log snapshot is UNCHANGED (no row);
 *   - replay-idempotent   — re-delivering the already-accepted event
 *     leaves the delivery log unchanged (still exactly one row).
 *
 * `truth table` case: the same pipeline shape for the five semantic
 * namespaces, observed through the real grader with no suite at all, so
 * the per-namespace "what happens today" claim is measured, not assumed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Canonical, withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { runCli } from './helpers.js';

/** Repo root (the example webhook receiver lives here). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** The env fingerprint the example receiver stamps on every response. */
const FINGERPRINT = 'example-webhook-v1';
/** The detector-emitted resource id of the example receiver's endpoint. */
const ENDPOINT = 'global.http-post-webhook-stripe-1fd2bace';
/** The delivery-log entity the reviewed adapter witnesses. */
const DELIVERIES = 'global.deliveries';

const keyDirectories: string[] = [];

afterEach(() => {
  for (const directory of keyDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const GATEFORGE_YML = `schemaVersion: 1
project:
  languages: [javascript]
  paths:
    include: ['src/**', 'specs/**']
    exclude: []
plugins:
  - id: gateforge.webhook-fixture
    version: 1.0.0
    transport: in-process
    module: ./.gateforge/fixture-detector.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
behaviorPolicy: .gateforge/behavior.yml
changed: { provider: auto }
witness: { maxDurationSeconds: 5 }
clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }
`;

const POLICIES_YML = `schemaVersion: 1
policies:
  - id: webhook-signatures
    when:
      kind: http.endpoint
    require:
      - webhook:signature-accepted
      - webhook:signature-rejected
      - webhook:replay-idempotent
`;

const CLASSIFICATION_POLICY_YML = `schemaVersion: 1
scanRoots: ['src/**']
trustedInternalEntryPoints: []
internalRules: []
declarations:
  internality: gateforge:internal
volatileFields: []
`;

/**
 * The fixture detector: the compiled http.endpoint inventory (so the
 * principal's own route can be attributed) plus the delivery-log entity
 * and its classification facts. Route discovery over the real receiver
 * source is delegated to the bundled HTTP detector; this declares the
 * two facts a generic detector cannot infer.
 */
const DETECTOR = `const SOURCE = 'src/webhook-server.js';
const LOCATION = { file: SOURCE, line: 1, col: 0 };
const DETECTOR = { id: 'gateforge.webhook-fixture', version: '1.0.0' };
const ENDPOINT = ${JSON.stringify(ENDPOINT)};
const DELIVERIES = ${JSON.stringify(DELIVERIES)};

function signal(resourceName, dimension, assertion) {
  return {
    schemaVersion: 1,
    target: { resourceName },
    dimension,
    assertion,
    basis: 'declaration',
    source: 'gateforge.webhook-fixture',
    location: LOCATION,
    detector: DETECTOR,
  };
}

export default {
  async discover() {
    return {
      resources: [
        {
          schemaVersion: 1,
          id: ENDPOINT,
          kind: 'http.endpoint',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: {
            resourceName: 'http-post-webhook-stripe-1fd2bace',
            method: 'POST',
            canonicalPath: '/webhook/stripe',
            identity: 'POST /webhook/stripe',
          },
        },
        {
          schemaVersion: 1,
          id: 'deliveries',
          kind: 'fixture.entity',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: { resourceName: 'deliveries', updateableFields: ['eventId', 'sideEffectCount'] },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [
        signal('http-post-webhook-stripe-1fd2bace', 'plane', 'global'),
        signal('http-post-webhook-stripe-1fd2bace', 'identity', ['method', 'path']),
        signal('deliveries', 'plane', 'global'),
        signal('deliveries', 'identity', ['eventId']),
        signal('deliveries', 'adapter-binding', DELIVERIES),
        signal('deliveries', 'lifecycle.create', true),
        signal('deliveries', 'lifecycle.read', true),
        signal('deliveries', 'lifecycle.update', true),
        signal('deliveries', 'lifecycle.delete', true),
        signal('deliveries', 'delete-semantics', 'hard'),
      ],
    };
  },
};
`;

/**
 * Reviewed evidence adapter: the delivery log is a server-side table, so
 * the engine reads it back over the app's own read-only endpoint and
 * never trusts the request's own response.
 */
const ADAPTER = `const FINGERPRINT = ${JSON.stringify(FINGERPRINT)};

export default {
  async read(ctx, id) {
    const res = await ctx.get('/delivery-log/' + encodeURIComponent(String(id)));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error('adapter read failed: HTTP ' + res.status);
    return res.json();
  },
  async list(ctx) {
    const res = await ctx.get('/delivery-log');
    if (res.status !== 200) throw new Error('adapter list failed: HTTP ' + res.status);
    return (await res.json()).deliveries;
  },
  normalize(body) {
    return {
      entityId: body.eventId,
      fields: { eventId: body.eventId, sideEffectCount: body.sideEffectCount },
    };
  },
  deletion: 'hard',
  environmentFingerprint: FINGERPRINT,
  async snapshotScope(ctx, input) {
    const res = await ctx.get('/delivery-log');
    if (res.status !== 200) throw new Error('scope read failed: HTTP ' + res.status);
    const rows = (await res.json()).deliveries;
    return {
      scope: input.scope,
      fixtureNamespace: input.fixtureNamespace,
      complete: true,
      checkpoint: String(rows.length),
      entities: rows.map((row) => ({ identity: { eventId: row.eventId }, fields: row })),
      exhausted: true,
    };
  },
};
`;

/**
 * The owner-declared behavior document. Three required cases on ONE
 * endpoint, all engine-http: a valid signature, a forged signature, and
 * a replay of the already-accepted event.
 */
const BEHAVIOR_YML = `schemaVersion: 1
endpoints:
  - resourceId: ${ENDPOINT}
    effects:
      - id: deliveries
        resourceId: ${DELIVERIES}
        adapter: deliveries
        scope: deliveries
        identityFields: [eventId]
        fields: [eventId, sideEffectCount]
        completion: immediate
    cases:
      - id: signature-accepted
        contract: webhook:signature-accepted
        channel: engine-http
        fixture: webhook-deliveries
        actor: provider
        action:
          kind: request
          method: POST
          pathTemplate: /webhook/stripe
          path: {}
          query: {}
          body:
            encoding: raw
            fixture: accepted-event
          credentialVariant: valid
          signatureProfile: hmac-sha256
        expect:
          statuses: [200]
          response: []
          state:
            - kind: created
              scope: deliveries
              rows:
                - fields:
                    eventId: {from: literal, value: evt-accepted}
                    sideEffectCount: {from: literal, value: 1}
      - id: signature-rejected
        contract: webhook:signature-rejected
        controlCase: signature-accepted
        channel: engine-http
        fixture: webhook-deliveries
        actor: provider
        action:
          kind: request
          method: POST
          pathTemplate: /webhook/stripe
          path: {}
          query: {}
          body:
            encoding: raw
            fixture: accepted-event
          credentialVariant: corrupted
          signatureProfile: hmac-sha256
        expect:
          statuses: [401]
          response: []
          state:
            - kind: unchanged
              scope: deliveries
      - id: replay-idempotent
        contract: webhook:replay-idempotent
        channel: engine-http
        fixture: webhook-deliveries
        actor: provider
        action:
          kind: request
          method: POST
          pathTemplate: /webhook/stripe
          path: {}
          query: {}
          body:
            encoding: raw
            fixture: accepted-event
          credentialVariant: valid
          signatureProfile: hmac-sha256
        expect:
          statuses: [200]
          response: []
          state:
            - kind: unchanged
              scope: deliveries
resources: []
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: 'specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { headless: true, trace: 'off' },
  timeout: 60_000,
});
`;

/** Canonical case id (same recipe the compiler uses). */
function caseIdOf(slug: string): string {
  return sha256Canonical({ domain: 'gateforge.case.v1', resourceId: ENDPOINT, id: slug });
}

const SPEC = `import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { CASES } from './case-ids.js';

const test = gateforgeTest;

// The order is the replay contract: the accepted delivery must happen
// before the duplicate one, in the same receiver process.
test('a validly signed delivery is accepted and recorded', async ({ evidence }) => {
  const sealed = await evidence.prove(CASES['signature-accepted']);
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});

test('a forged signature is rejected and records nothing', async ({ evidence }) => {
  const sealed = await evidence.prove(CASES['signature-rejected']);
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});

test('a replayed delivery leaves exactly one row', async ({ evidence }) => {
  const sealed = await evidence.prove(CASES['replay-idempotent']);
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});
`;

const CASE_IDS_JS = `export const CASES = ${JSON.stringify(
  {
    'signature-accepted': caseIdOf('signature-accepted'),
    'signature-rejected': caseIdOf('signature-rejected'),
    'replay-idempotent': caseIdOf('replay-idempotent'),
  },
  null,
  2,
)};
`;

const TEST_MAP_YML = `schemaVersion: 1
tests:
  - key: playwright:chromium:specs/webhook.spec.js:a validly signed delivery is accepted and recorded
    selector:
      runner: playwright
      project: chromium
      file: specs/webhook.spec.js
      titlePath:
        - a validly signed delivery is accepted and recorded
    kind: browser-e2e
    claims:
      - ${ENDPOINT}:webhook:signature-accepted
    caseIds:
      - ${caseIdOf('signature-accepted')}
    reason: the engine drives the valid-signature case and reads the delivery log back itself
  - key: playwright:chromium:specs/webhook.spec.js:a forged signature is rejected and records nothing
    selector:
      runner: playwright
      project: chromium
      file: specs/webhook.spec.js
      titlePath:
        - a forged signature is rejected and records nothing
    kind: browser-e2e
    claims:
      - ${ENDPOINT}:webhook:signature-rejected
    caseIds:
      - ${caseIdOf('signature-rejected')}
    reason: the engine drives the forged-signature case; the delivery log must be unchanged
  - key: playwright:chromium:specs/webhook.spec.js:a replayed delivery leaves exactly one row
    selector:
      runner: playwright
      project: chromium
      file: specs/webhook.spec.js
      titlePath:
        - a replayed delivery leaves exactly one row
    kind: browser-e2e
    claims:
      - ${ENDPOINT}:webhook:replay-idempotent
    caseIds:
      - ${caseIdOf('replay-idempotent')}
    reason: the engine drives the duplicate delivery; the delivery log must still hold one row
`;

/** Starts the example webhook receiver as a child; resolves its URL. */
async function startReceiver(): Promise<{ url: string; stop: () => void }> {
  const child: ChildProcess = spawn(
    process.execPath,
    [join(ROOT, 'example/webhook/server.js'), '--port', '0'],
    { cwd: join(ROOT, 'example/webhook'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectUrl(new Error('example webhook receiver did not report its URL in time'));
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /listening on (http:\/\/\S+)/.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolveUrl((match[1] as string).replace('[IP_ADDRESS]', '127.0.0.1'));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectUrl(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`example webhook receiver exited early (code ${String(code)}): ${stdout}`));
    });
  });
  return { url, stop: () => child.kill('SIGTERM') };
}
function installFixture(repo: TempRepo): void {
  mkdirSync(join(repo.root, 'src'), { recursive: true });
  cpSync(join(ROOT, 'example/webhook/server.js'), join(repo.root, 'src', 'webhook-server.js'), {
    recursive: true,
  });
  repo.writeFiles({
    '.gateforge.yml': GATEFORGE_YML,
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/behavior.yml': BEHAVIOR_YML,
    '.gateforge/adapters/deliveries.mjs': ADAPTER,
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
    '.gateforge/test-map.yml': TEST_MAP_YML,
    'specs/webhook.spec.js': SPEC,
    'specs/case-ids.js': CASE_IDS_JS,
    'playwright.config.mjs': PLAYWRIGHT_CONFIG,
    'package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    '.gitignore': ['node_modules', 'test-results', 'playwright-report', '.playwright', '.gateforge/test-gates', ''].join('\n'),
  });
  symlinkSync(
    process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'),
    join(repo.root, 'node_modules'),
    'dir',
  );
}

/** A verifier key ring outside the candidate, with its key id. */
function provisionVerifierKey(): { keyFile: string } {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-webhook-verifier-'));
  keyDirectories.push(directory);
  const keyFile = join(directory, 'keys.json');
  writeFileSync(
    keyFile,
    `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'webhook-key', keys: { 'webhook-key': 'webhook-engine-e2e-verifier-key' } })}\n`,
    { mode: 0o600 },
  );
  return { keyFile };
}

interface BehaviorReport {
  summary: { obligations: number; blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string; reason?: string }>;
}

/** The three webhook obligations the behavior document compiles. */
const WEBHOOK_IDS: readonly string[] = [
  `${ENDPOINT}:webhook:signature-accepted`,
  `${ENDPOINT}:webhook:signature-rejected`,
  `${ENDPOINT}:webhook:replay-idempotent`,
];

/**
 * Parses the run's JSON report, failing with both streams when the CLI
 * answered with a diagnostic instead (a config error must never read as
 * a verdict).
 */
function parseReport(run: { code: number; stdout: string; stderr: string }): BehaviorReport {
  if (!run.stdout.trimStart().startsWith('{')) {
    throw new Error(
      `test-gates exited ${String(run.code)} without a report\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  }
  return JSON.parse(run.stdout) as BehaviorReport;
}

describe('webhook namespace: engine-level end-to-end (plan 2026-09-25)', () => {
  it('reaches the verifier through the real CLI and blocks at the named missing supervisor bind', async () => {
    const { keyFile } = provisionVerifierKey();
    const saved = new Map<string, string | undefined>();
    const setEnv = (values: Record<string, string>): void => {
      for (const [key, value] of Object.entries(values)) {
        if (!saved.has(key)) saved.set(key, process.env[key]);
        process.env[key] = value;
      }
    };
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'webhook fixture']);
        const receiver = await startReceiver();
        const proxy = await startAttestationProxy(receiver.url, FINGERPRINT);
        try {
          const config = loadConfigAt(repo.root);
          const env: Record<string, string> = {
            [VERIFIER_KEY_FILE_ENV]: keyFile,
            GATEFORGE_APP_BASE_URL: proxy.url,
            GATEFORGE_TARGET_BASE_URL: proxy.url,
            GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
            GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
          };
          setEnv(env);
          // The change under test: one line of the receiver's source.
          repo.writeFiles({
            'src/webhook-server.js': `${readFileSync(join(repo.root, 'src', 'webhook-server.js'), 'utf8')}\n// audited change: the signature check is unchanged.\n`,
          });
          const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
          const report = parseReport(run);
          const byId = new Map(report.verdicts.map((entry) => [entry.obligationId, entry]));
          const truth = WEBHOOK_IDS.map((id) => `${id} -> ${byId.get(id)?.verdict ?? '<absent>'}: ${byId.get(id)?.reason ?? '<no verdict>'}`);
          expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(1);
          // PHASE 0 TRUTH (measured, not assumed): the owner-declared
          // behavior document compiles three real webhook obligations
          // and the grader reaches them — none is `satisfied`, and each
          // names the case that produced no evidence.
          for (const id of WEBHOOK_IDS) {
            expect(byId.get(id), `${id} is missing from the report:\n${truth.join('\n')}`).toBeDefined();
            expect(byId.get(id)?.verdict, truth.join('\n')).toBe('missing');
            expect(byId.get(id)?.reason).toContain('BEHAVIOR_CASE_MISSING');
          }
          // The suite itself could not prove: the witness it was pointed
          // at has no behavior catalog, because no supervisor code path
          // binds the compiled one. That is the named missing piece, and
          // the run's own failure artifact says so in words.
          expect(run.stdout).toContain('RUN_INCOMPLETE');
          const failures = readFileSync(join(repo.root, '.gateforge/test-gates/failures.json'), 'utf8');
          expect(failures).toContain('no behavior catalog is bound to this run');
          expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
        } finally {
          await proxy.stop();
          receiver.stop();
        }
      });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 300_000);
});
