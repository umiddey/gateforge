/**
 * Engine-level end-to-end proof for the `auth` namespace (plan
 * 2026-09-25 Phase 2): the real CLI over a real fixture repository, the
 * pack's own example auth server (`example/auth/server.js`) behind the
 * loopback attestation proxy, the witness `test-gates` spawns itself,
 * and post-suite verdict evaluation through `check --require-e2e`.
 *
 * The point of this suite is the PATH, not the pack: nothing here
 * exercises the detector or the example server's own tests. The
 * principal is the ENGINE — it mints the actor's credential from the
 * approved fixture provider, sends the request, and reads the refund
 * ledger back through the reviewed adapter. A test body only names one
 * approved case id; it cannot assert its own way to a green gate.
 *
 * The two graded obligations are the plan's cross-tenant pair:
 *   - role-allowed      — tenant A's own admin credential on tenant A's
 *     refund is accepted (201) and the engine-read ledger gains exactly
 *     that row (the positive control);
 *   - tenant-isolated   — tenant A's credential on tenant B's refund is
 *     rejected (403), the response body carries NONE of tenant B's
 *     fields, and the engine-read ledger is UNCHANGED.
 *
 * The fail variant runs the SAME example server with one documented
 * defect patched into the copy the engine scans: the tenant equality
 * check is gone, so tenant A's credential writes tenant B's row and
 * gets it back. The engine must block it, and the credential must never
 * reach a sealed record.
 */
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Canonical, withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy } from '@gate-forge/pack-playwright';
// The example server is an untyped checked-in fixture (not a workspace package).
// @ts-expect-error: no declaration file for the example fixture
import { createAuthApp, createMemoryLedger } from '../../../example/auth/server.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { runCli } from './helpers.js';

/** Repo root (the example auth server lives here). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** The fingerprint the example server stamps on every response. */
const FINGERPRINT = 'auth-loopback-v1';
/** The detector-emitted resource id of the guarded refund endpoint. */
const ENDPOINT = 'global.http-post-billing-refund-7c1de903';
/** The refund-ledger entity the reviewed adapter witnesses. */
const REFUNDS = 'global.refunds';
/** The refund that already belongs to the other tenant. */
const TENANT_B_REFUND = 'rfn-900';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const GATEFORGE_YML = `schemaVersion: 1
project:
  languages: [javascript]
  paths:
    include: ['src/**', 'specs/**']
    exclude: []
plugins:
  - id: gateforge.auth-fixture
    version: 1.0.0
    transport: in-process
    module: ./.gateforge/fixture-detector.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['src/**']
  declarations:
    internality: gateforge:internal
  volatileFields: []
behaviorPolicy: .gateforge/behavior.yml
changed: { provider: auto }
witness: { maxDurationSeconds: 5 }
clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }
`;

const POLICIES_YML = `schemaVersion: 1
policies:
  - id: auth-tenant-boundary
    when:
      kind: http.endpoint
    require:
      - auth:role-allowed
      - auth:tenant-isolated
`;

const CLASSIFICATION_POLICY_YML = `schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
`;

/**
 * The fixture detector: the guarded refund endpoint plus the refund
 * ledger the reviewed adapter witnesses. The tenancy the endpoint
 * declares is the fact the cross-tenant case turns on.
 */
const DETECTOR = `const SOURCE = 'src/auth-server.js';
const LOCATION = { file: SOURCE, line: 1, col: 0 };
const DETECTOR = { id: 'gateforge.auth-fixture', version: '1.0.0' };
const ENDPOINT = ${JSON.stringify(ENDPOINT)};
const REFUNDS = ${JSON.stringify(REFUNDS)};

function signal(resourceName, dimension, assertion) {
  return {
    schemaVersion: 1,
    target: { resourceName },
    dimension,
    assertion,
    basis: 'declaration',
    source: 'gateforge.auth-fixture',
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
            resourceName: 'http-post-billing-refund-7c1de903',
            method: 'POST',
            canonicalPath: '/billing/refund',
            identity: 'POST /billing/refund',
            tenancy: 'tenant-bound',
          },
        },
        {
          schemaVersion: 1,
          id: 'refunds',
          kind: 'fixture.entity',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: { resourceName: 'refunds', updateableFields: ['tenant_id', 'amount_cents', 'status'] },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [
        signal('http-post-billing-refund-7c1de903', 'plane', 'global'),
        signal('http-post-billing-refund-7c1de903', 'identity', ['method', 'path']),
        signal('refunds', 'plane', 'global'),
        signal('refunds', 'identity', ['id']),
        signal('refunds', 'adapter-binding', REFUNDS),
        signal('refunds', 'lifecycle.create', true),
        signal('refunds', 'lifecycle.read', true),
        signal('refunds', 'lifecycle.update', true),
        signal('refunds', 'lifecycle.delete', true),
        signal('refunds', 'delete-semantics', 'hard'),
      ],
    };
  },
};
`;

/**
 * Reviewed evidence adapter. Entity reads use the app's own read-only
 * endpoint; the SCOPE snapshot the engine compares before/after a case
 * is read from the trusted file the harness mirrors out of the refund
 * ledger — the witness deliberately refuses the candidate GET
 * transport there, so a scope can never be the app's own answer.
 *
 * Args:
 *   scopeFile: absolute path of the mirrored refund ledger.
 *
 * Returns:
 *   string: the adapter module source.
 */
function adapterSource(scopeFile: string): string {
  return `import { existsSync, readFileSync } from 'node:fs';
const FINGERPRINT = ${JSON.stringify(FINGERPRINT)};
const SCOPE_FILE = ${JSON.stringify(scopeFile)};

export default {
  async read(ctx, id) {
    const res = await ctx.get('/api/billing/refund/' + encodeURIComponent(String(id)));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error('adapter read failed: HTTP ' + res.status);
    return res.json();
  },
  normalize(body) {
    return {
      entityId: body.id,
      fields: {
        id: body.id,
        amount_cents: body.amount_cents,
        tenant_id: body.tenant_id,
        requested_by: body.requested_by,
        status: body.status,
      },
    };
  },
  deletion: 'hard',
  environmentFingerprint: FINGERPRINT,
  async snapshotScope(ctx, input) {
    const stored = existsSync(SCOPE_FILE)
      ? JSON.parse(readFileSync(SCOPE_FILE, 'utf8'))
      : { checkpoint: 'r0', entities: [] };
    return {
      scope: input.scope,
      fixtureNamespace: input.fixtureNamespace,
      complete: true,
      checkpoint: stored.checkpoint,
      entities: stored.entities,
      exhausted: true,
    };
  },
};
`;
}

/**
 * The owner-declared behavior document: the accepted same-tenant
 * refund (the cross-tenant case's positive control) and the denied
 * cross-tenant write, which additionally declares that NONE of tenant
 * B's fields may appear in the response body.
 */
const BEHAVIOR_YML = `schemaVersion: 1
endpoints:
  - resourceId: ${ENDPOINT}
    effects:
      - id: refunds
        resourceId: ${REFUNDS}
        adapter: refunds
        scope: refunds
        identityFields: [id]
        fields: [id, amount_cents, tenant_id, requested_by, status]
        completion: immediate
    cases:
      - id: same-tenant-allowed
        contract: auth:role-allowed
        channel: engine-http
        fixture: auth-refunds
        actor: admin-a
        action:
          kind: request
          method: POST
          pathTemplate: /billing/refund
          path: {}
          query: {}
          body:
            encoding: json
            fields:
              tenant_id: {from: literal, value: tenant-a}
              amount_cents: {from: literal, value: 4200}
          credentialVariant: valid
        expect:
          statuses: [201]
          response: []
          state:
            - kind: created
              scope: refunds
              rows:
                - fields:
                    tenant_id: {from: literal, value: tenant-a}
                    amount_cents: {from: literal, value: 4200}
                    requested_by: {from: literal, value: admin-a}
                    status: {from: literal, value: refunded}
      - id: cross-tenant-denied
        contract: auth:tenant-isolated
        controlCase: same-tenant-allowed
        channel: engine-http
        fixture: auth-refunds
        actor: admin-a
        action:
          kind: request
          method: POST
          pathTemplate: /billing/refund
          path: {}
          query: {}
          body:
            encoding: json
            fields:
              tenant_id: {from: literal, value: tenant-b}
              amount_cents: {from: literal, value: 9900}
          credentialVariant: valid
        expect:
          statuses: [403]
          response:
            - kind: absent
              pointer: tenant_id
            - kind: absent
              pointer: amount_cents
            - kind: absent
              pointer: requested_by
            - kind: absent
              pointer: status
          state:
            - kind: unchanged
              scope: refunds
resources: []
`;

/**
 * The operator-provided trusted fixture/actor provider
 * (`GATEFORGE_FIXTURE_PROVIDER`): the engine-side-only source of actor
 * credentials. It mints the actor's own HS256 token with the
 * application secret the harness generated for this run, so the
 * principal is a real authenticated identity and the secret never
 * reaches the suite or any sealed record.
 *
 * Args:
 *   secret: the run's application signing secret.
 *
 * Returns:
 *   string: the provider module source.
 */
function fixtureProviderSource(secret: string): string {
  return `import { createHmac, randomUUID } from 'node:crypto';

const SECRET = ${JSON.stringify(secret)};
const ACTORS = { 'admin-a': { principalId: 'admin-a', tenantId: 'tenant-a', roles: ['admin'] } };

function b64url(buf) {
  return buf.toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}

/** Mints the actor's own credential with the application's secret. */
function token(claims) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(createHmac('sha256', SECRET).update(header + '.' + payload).digest());
  return header + '.' + payload + '.' + signature;
}

const live = new Map();
let counter = 0;

export default {
  prepare(input) {
    counter += 1;
    const leaseId = randomUUID();
    const actors = {};
    const exp = Math.floor(Date.now() / 1000) + 3600;
    for (const [name, template] of Object.entries(ACTORS)) {
      actors[name] = {
        ...template,
        roles: [...template.roles],
        credentialRef: 'credref:' + leaseId + ':' + name,
        headers: { authorization: 'Bearer ' + token({ sub: template.principalId, role: 'admin', tenantId: template.tenantId, exp }) },
      };
    }
    live.set(leaseId, { actors });
    return {
      leaseId,
      namespace: ('fixture-' + input.runId + '-' + input.caseId + '-' + String(counter)).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      subjects: {},
      actors: Object.fromEntries(Object.entries(actors).map(([name, actor]) => [name, { principalId: actor.principalId, tenantId: actor.tenantId, roles: actor.roles, credentialRef: actor.credentialRef }])),
    };
  },
  release(leaseId) {
    live.delete(leaseId);
  },
  resolveCredential(credentialRef) {
    const match = /^credref:([^:]+):(.+)$/.exec(credentialRef);
    if (match === null || !live.has(match[1])) return null;
    const headers = live.get(match[1]).actors[match[2]].headers;
    return { headers: { ...headers } };
  },
};
`;
}

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

// The order is the control-then-probe contract: the accepted same-tenant
// refund runs first, so the denied case's ledger already holds a row and
// "unchanged" cannot be satisfied by an empty ledger.
test('the tenant own admin credential is accepted', async ({ evidence }) => {
  const sealed = await evidence.prove(CASES['same-tenant-allowed']);
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});

test('another tenant refund is refused and leaks nothing', async ({ evidence }) => {
  const sealed = await evidence.prove(CASES['cross-tenant-denied']);
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});
`;

const CASE_IDS_JS = `export const CASES = ${JSON.stringify(
  {
    'same-tenant-allowed': caseIdOf('same-tenant-allowed'),
    'cross-tenant-denied': caseIdOf('cross-tenant-denied'),
  },
  null,
  2,
)};
`;

const TEST_MAP_YML = `schemaVersion: 1
tests:
  - key: playwright:chromium:specs/auth.spec.js:the tenant own admin credential is accepted
    selector:
      runner: playwright
      project: chromium
      file: specs/auth.spec.js
      titlePath:
        - the tenant own admin credential is accepted
    kind: browser-e2e
    claims:
      - ${ENDPOINT}:auth:role-allowed
    caseIds:
      - ${caseIdOf('same-tenant-allowed')}
    reason: the engine mints the admin credential and reads the refund ledger back itself
  - key: playwright:chromium:specs/auth.spec.js:another tenant refund is refused and leaks nothing
    selector:
      runner: playwright
      project: chromium
      file: specs/auth.spec.js
      titlePath:
        - another tenant refund is refused and leaks nothing
    kind: browser-e2e
    claims:
      - ${ENDPOINT}:auth:tenant-isolated
    caseIds:
      - ${caseIdOf('cross-tenant-denied')}
    reason: the engine drives the cross-tenant write; the ledger must be unchanged and the body must leak nothing
`;

/** The two obligations the behavior document compiles. */
const AUTH_IDS: readonly string[] = [
  `${ENDPOINT}:auth:role-allowed`,
  `${ENDPOINT}:auth:tenant-isolated`,
];

/**
 * Patches the tenant equality check out of the example server: the
 * fail-variant application under test. This is the defect class the
 * auth pack exists to catch — the handler runs for a principal whose
 * tenant is not the tenant it is writing for, and answers with the other
 * tenant's row.
 *
 * Args:
 *   source: the pristine example server source.
 *
 * Returns:
 *   string: the same server with the tenant guard removed.
 */
function withoutTenantGuard(source: string): string {
  const guard = `    if (claims.tenantId !== requestedTenant) {
      sendJson(res, 403, { error: 'forbidden', detail: 'cross-tenant request rejected' });
      return;
    }
`;
  if (!source.includes(guard)) throw new Error('the example auth server no longer holds the tenant guard under test');
  return source.replace(guard, '');
}

/**
 * Boots the auth app over a harness-owned refund ledger that already
 * holds one OTHER tenant's refund, mirroring every write into the
 * trusted scope file the reviewed adapter snapshots (the file-mediated
 * trust boundary: the engine never reads a scope back out of the app it
 * is grading, and "unchanged" is measured against a ledger that is not
 * empty).
 *
 * Args:
 *   scopeFile: absolute path the mirrored ledger is written to.
 *   secret: the run's application signing secret.
 *   defective: when true, boot the guard-less copy instead.
 *
 * Returns:
 *   Promise<{url, stop}>: the running server's loopback URL and stop.
 */
async function startAuthApp(
  scopeFile: string,
  secret: string,
  defective: boolean,
): Promise<{ url: string; stop: () => Promise<void> }> {
  let createApp: typeof createAuthApp;
  if (defective) {
    const directory = mkdtempSync(join(tmpdir(), 'gateforge-auth-defect-'));
    tempDirectories.push(directory);
    const file = join(directory, 'auth-server.mjs');
    writeFileSync(file, withoutTenantGuard(readFileSync(join(ROOT, 'example/auth/server.js'), 'utf8')));
    createApp = ((await import(pathToFileURL(file).href)) as { createAuthApp: typeof createAuthApp }).createAuthApp;
  } else {
    createApp = createAuthApp;
  }
  // The example's OWN in-memory ledger does the id assignment; the
  // harness only wraps its writes so the trusted scope file mirrors
  // them (a hand-rolled ledger would silently drop the id the example
  // assigns at save time, and every snapshot would fail closed).
  const ledger = createMemoryLedger();
  type RefundRow = Record<string, unknown>;
  type MirrorEntity = { entityId: unknown; fields: Record<string, unknown> };
  const mirror = (): void => {
    const entities: MirrorEntity[] = (ledger.all() as RefundRow[])
      .map((row: RefundRow) => ({
        entityId: row['id'],
        fields: {
          id: row['id'],
          amount_cents: row['amount_cents'],
          tenant_id: row['tenant_id'],
          requested_by: row['requested_by'],
          status: row['status'],
        },
      }))
      .sort((a: MirrorEntity, b: MirrorEntity) => (String(a.entityId) < String(b.entityId) ? -1 : 1));
    writeFileSync(scopeFile, `${JSON.stringify({ checkpoint: `r${String(entities.length)}`, entities })}\n`);
  };
  // Another tenant's refund already exists: "unchanged" is measured
  // against a ledger that is not empty.
  ledger.save({
    id: TENANT_B_REFUND,
    amount_cents: 7777,
    tenant_id: 'tenant-b',
    requested_by: 'admin-b',
    status: 'refunded',
    created_at: '2026-08-31T00:00:00.000Z',
  });
  mirror();
  const server: Server = createApp({
    secret,
    ledger: {
      find: (id: string) => ledger.find(id),
      all: () => ledger.all(),
      save: (record: Record<string, unknown>) => {
        const stored = ledger.save(record);
        mirror();
        return stored;
      },
    },
  }) as Server;
  await new Promise<void>((resolveListen) => server.listen(0, ['127', '0', '0', '1'].join('.'), resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no auth server port');
  return {
    url: `http://${['127', '0', '0', '1'].join('.')}:${String(address.port)}`,
    stop: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/**
 * Writes the fixture repository: the example server as the scanned
 * source, the detector, the reviewed adapter, the behavior document and
 * the suite that names one approved case per test.
 *
 * Args:
 *   repo: the temporary candidate repository.
 *   scopeFile: absolute path of the mirrored refund ledger.
 *   secret: the run's application signing secret.
 *   defective: install the guard-less copy of the example server.
 */
function installFixture(repo: TempRepo, scopeFile: string, secret: string, defective: boolean): void {
  mkdirSync(join(repo.root, 'src'), { recursive: true });
  cpSync(join(ROOT, 'example/auth/server.js'), join(repo.root, 'src', 'auth-server.js'));
  repo.writeFiles({
    '.gateforge.yml': GATEFORGE_YML,
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/behavior.yml': BEHAVIOR_YML,
    '.gateforge/adapters/refunds.mjs': adapterSource(scopeFile),
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
    '.gateforge/test-map.yml': TEST_MAP_YML,
    '.gateforge/fixture-provider.mjs': fixtureProviderSource(secret),
    'specs/auth.spec.js': SPEC,
    'specs/case-ids.js': CASE_IDS_JS,
    'playwright.config.mjs': PLAYWRIGHT_CONFIG,
    'package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    '.gitignore': ['node_modules', 'test-results', 'playwright-report', '.playwright', '.gateforge/test-gates', ''].join('\n'),
  });
  if (defective) {
    repo.writeFiles({
      'src/auth-server.js': withoutTenantGuard(readFileSync(join(ROOT, 'example/auth/server.js'), 'utf8')),
    });
  }
  symlinkSync(
    process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'),
    join(repo.root, 'node_modules'),
    'dir',
  );
}

/** A verifier key ring outside the candidate, with its key id. */
function provisionVerifierKey(): { keyFile: string } {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-auth-verifier-'));
  tempDirectories.push(directory);
  const keyFile = join(directory, 'keys.json');
  writeFileSync(
    keyFile,
    `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'auth-key', keys: { 'auth-key': 'auth-engine-e2e-verifier-key' } })}\n`,
    { mode: 0o600 },
  );
  return { keyFile };
}

interface BehaviorReport {
  summary: { obligations: number; blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string; reason?: string }>;
}

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

/** One sealed scope snapshot as the engine read it. */
interface SealedSnapshot {
  scope: string;
  entities: Array<{ entityId: unknown; fields: Record<string, unknown> }>;
}

/**
 * The refund ids the ENGINE read before and after one case — the
 * snapshot the grader compared, not the app's own account of itself.
 *
 * Args:
 *   records: the run's sealed record ledger.
 *   caseId: the compiled case id whose snapshots are wanted.
 *
 * Returns:
 *   {before, after}: the two observed id sets, in snapshot order.
 */
function engineReadRefundIds(
  records: string,
  caseId: string,
): { before: string[]; after: string[] } {
  const sealed = JSON.parse(records) as Array<{
    payload?: { caseId?: string; before?: SealedSnapshot[]; after?: SealedSnapshot[] };
  }>;
  const payload = sealed.find((record) => record.payload?.caseId === caseId)?.payload;
  const idsOf = (snapshot: SealedSnapshot[] | undefined): string[] =>
    (snapshot?.[0]?.entities ?? []).map((entity) => String(entity.entityId));
  const before = idsOf(payload?.before);
  const after = idsOf(payload?.after);
  if (before.length === 0) throw new Error(`case ${caseId} sealed no engine-read refund snapshot`);
  return { before, after };
}

/**
 * Runs one full gate over a freshly installed fixture repository: the
 * witnessed suite, then the post-suite `check --require-e2e` that loads
 * the sealed receipt.
 *
 * Args:
 *   defective: install and boot the guard-less application variant.
 *
 * Returns:
 *   Promise<{run, report, check, records}>: the test-gates result, its
 *   parsed report, the check result, and the sealed record ledger.
 */
async function runAuthGate(
  defective: boolean,
): Promise<{
  run: { code: number; stdout: string; stderr: string };
  report: BehaviorReport;
  check: { code: number; stdout: string; stderr: string };
  records: string;
}> {
  const { keyFile } = provisionVerifierKey();
  const scopeDirectory = mkdtempSync(join(tmpdir(), 'gateforge-auth-scope-'));
  tempDirectories.push(scopeDirectory);
  const scopeFile = join(scopeDirectory, 'refunds.json');
  // A per-run secret, generated here: no signing material is ever a
  // literal in the repository or in this file.
  const secret = randomBytes(32).toString('base64url');
  const saved = new Map<string, string | undefined>();
  const setEnv = (values: Record<string, string>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      process.env[key] = value;
    }
  };
  try {
    return await withTempRepo({}, async (repo) => {
      installFixture(repo, scopeFile, secret, defective);
      repo.git(['add', '-A']);
      repo.git([
        'commit',
        '--no-gpg-sign',
        '--quiet',
        '-m',
        defective ? 'auth fixture (defective app)' : 'auth fixture',
      ]);
      const app = await startAuthApp(scopeFile, secret, defective);
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const config = loadConfigAt(repo.root);
        const env: Record<string, string> = {
          [VERIFIER_KEY_FILE_ENV]: keyFile,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
          // The approved fixture/actor provider is engine-side input:
          // without it every strong case blocks fail-closed.
          GATEFORGE_FIXTURE_PROVIDER: join(repo.root, '.gateforge/fixture-provider.mjs'),
        };
        setEnv(env);
        // The change under test: one audited line of the server source.
        repo.writeFiles({
          'src/auth-server.js': `${readFileSync(join(repo.root, 'src', 'auth-server.js'), 'utf8')}\n// audited change: the tenant guard is unchanged.\n`,
        });
        const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        const report = parseReport(run);
        const check = await runCli(repo, ['check', '--require-e2e'], env);
        const records = readFileSync(join(repo.root, '.gateforge/test-gates/records.json'), 'utf8');
        return { run, report, check, records };
      } finally {
        await proxy.stop();
        await app.stop();
      }
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('auth namespace: engine-level end-to-end (plan 2026-09-25 Phase 2)', () => {
  it('seals the cross-tenant obligation through the real CLI run when the app refuses the other tenant', async () => {
    const { run, report, check, records } = await runAuthGate(false);
    const byId = new Map(report.verdicts.map((entry) => [entry.obligationId, entry]));
    const truth = AUTH_IDS.map(
      (id) => `${id} -> ${byId.get(id)?.verdict ?? '<absent>'}: ${byId.get(id)?.reason ?? '<no verdict>'}`,
    );
    expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
    // The engine minted the admin credential, drove both requests and
    // read the refund ledger back itself: the tenant's own refund is
    // accepted and recorded, the other tenant's is refused (403) with
    // no field of it in the body and the ledger UNCHANGED.
    for (const id of AUTH_IDS) {
      expect(byId.get(id), `${id} is missing from the report:\n${truth.join('\n')}`).toBeDefined();
      expect(byId.get(id)?.verdict, truth.join('\n')).toBe('satisfied');
    }
    // The engine-read ledger, not the app's word: the refused write left
    // exactly the rows that were there before it (the accepted refund
    // plus the other tenant's pre-existing one).
    const refused = engineReadRefundIds(records, caseIdOf('cross-tenant-denied'));
    expect(refused.before).toHaveLength(2);
    expect(refused.after).toEqual(refused.before);
    expect(run.stdout).not.toContain('RUN_INCOMPLETE');
    // The sealed receipt is exactly what `check --require-e2e` loads.
    expect(check.code, `stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).toBe(0);
    // Neither the signing secret nor the minted credential reaches a
    // sealed record.
    expect(records).not.toContain('eyJ');
  }, 300_000);

  it('blocks the cross-tenant obligation when the app serves the other tenant', async () => {
    const { run, report, check, records } = await runAuthGate(true);
    const byId = new Map(report.verdicts.map((entry) => [entry.obligationId, entry]));
    const truth = AUTH_IDS.map(
      (id) => `${id} -> ${byId.get(id)?.verdict ?? '<absent>'}: ${byId.get(id)?.reason ?? '<no verdict>'}`,
    );
    // The positive control still passes — the app still accepts the
    // tenant's own refund — so what blocks is exactly the isolation.
    expect(byId.get(`${ENDPOINT}:auth:role-allowed`)?.verdict, truth.join('\n')).toBe('satisfied');
    const isolated = byId.get(`${ENDPOINT}:auth:tenant-isolated`);
    expect(isolated, `${AUTH_IDS[1]} is missing from the report:\n${truth.join('\n')}`).toBeDefined();
    expect(isolated?.verdict, truth.join('\n')).toBe('invalid');
    expect(isolated?.reason, truth.join('\n')).toContain('BEHAVIOR_EFFECT_MISMATCH');
    // …and the engine's own after-snapshot shows a row for the OTHER
    // tenant that the app should never have written.
    const served = engineReadRefundIds(records, caseIdOf('cross-tenant-denied'));
    expect(served.after.length).toBeGreaterThan(served.before.length);
    expect(served.after.some((id) => !served.before.includes(id))).toBe(true);
    expect(report.summary.blocking, truth.join('\n')).toBeGreaterThan(0);
    expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).not.toBe(0);
    expect(check.code, `stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).not.toBe(0);
  }, 300_000);
});
