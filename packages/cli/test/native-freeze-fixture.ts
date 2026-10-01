/**
 * Shared fixture for the real-CLI GLOBAL native preparation freeze suites
 * (`native-freeze-e2e.test.ts`, `native-freeze-candidate.test.ts`,
 * `native-freeze-reseal.test.ts`).
 *
 * Everything here is REAL. The workspace is a git repository with a real
 * consumer Playwright suite (eight projects: two uneven-depth preparation
 * chains, one independent body, one more chain consumer), the engine's own
 * Chromium, the real witness the CLI spawns itself, and the example app
 * behind the real attestation proxy. There is no stub runner and no mocked
 * controller: the engine's generated preparation-freeze controller project
 * is the worker that performs the handshake, exactly as it is for a
 * consumer.
 *
 * The detector, the evidence adapter, the policy documents and the
 * attestation fingerprint are the SHARED validated ones from
 * `witnessed-run-fixture.ts`, so these suites bind to the same resource
 * schema, the same adapter contract and the same signals every other
 * witnessed-run test uses — never a second drifting copy.
 *
 * The preparation stages write GENUINE browser session state (a real
 * context, a real cookie, the real `storageState` serialization) into the
 * git-ignored `.auth/` directory, and every body project reads that state
 * back through its own context and proves the session is PROTECTED: a
 * test-only loopback route the fixture starts answers 401 to a caller with
 * no credential and 200 only to the MAC a preparation stage signed over its
 * own cookie name and session part. The session is a credential, not
 * decorative bytes.
 *
 * The environment assertions live INSIDE the specs on purpose: a worker's
 * environment is produced by real worker processes, so the only honest
 * place to measure what a body actually inherited is the body itself. A
 * wrong environment therefore fails the run, and the suites' outcome
 * assertions are the evidence that the projection was right.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type TempRepo } from '@gate-forge/core';
import {
  FREEZE_CONTROL_DIR,
  FREEZE_CONTROL_SPEC_FILE,
  FREEZE_CONTROLLER_PROJECT,
  FREEZE_RELEASE_FILE,
  FREEZE_REQUEST_FILE,
  FREEZE_REFUSAL_FILE,
  startAttestationProxy,
} from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadCacheExclusions } from '../src/cache-exclusions.js';
import { loadDocsExclusions } from '../src/docs-exclusions.js';
import { DEFAULT_STATE_DIR, resolveStateDir } from '../src/state.js';
import { computeCandidateTreeId, resolveGitDir } from '../src/candidate-tree.js';
import { runCli as runWorkspaceCli } from './helpers.js';
import {
  ADAPTER,
  CLASSIFICATION_POLICY_YML,
  DETECTOR,
  FINGERPRINT,
  POLICIES_YML,
} from './witnessed-run-fixture.js';

/** Repo root (example app + surface descriptor live here). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The witness verifier key these supervised runs are bound to. */
export const NATIVE_VERIFIER_KEY = 'native-freeze-supervised-key';

/** The engine-owned controller project name (never a consumer's). */
export const CONTROL_PROJECT = FREEZE_CONTROLLER_PROJECT;

/** The attestation fingerprint every fixture app and adapter shares. */
export { FINGERPRINT };

/** The name the operator's own whole-run session cookie carries. */
export const OPERATOR_COOKIE = 'operator-session';

/** The ordinary baseline variable a preparation stage revokes. */
const DELETED_BASELINE_KEY = 'SHOP_LEGACY';

/** The ordinary variable NO baseline has and preparation introduces. */
const INTRODUCED_KEY = 'SHOP_TICKET';

/**
 * One planned consumer project of the fixture suite: its name, the file
 * its `testMatch` selects, and the exact test titles it contributes. The
 * project list, the generated specs and the catalog identities the suites
 * assert are all derived from THIS table, so a title can never drift away
 * from the case identity the run actually plans.
 */
interface ConsumerProject {
  /** The Playwright project name. */
  name: string;
  /** Repo-relative spec file the project's `testMatch` selects. */
  file: string;
  /** Every test title the project contributes, in file order. */
  titles: readonly string[];
}

/** The three claim-bearing journeys only the delta body carries. */
const DELTA_CLAIM_TITLES: readonly string[] = [
  'creates an account through the rendered UI',
  'updates the account through the rendered UI',
  'archives the account through the rendered UI',
];

/**
 * The preparation projects: two uneven-depth chains (`alpha-auth` →
 * `beta-auth` → `gamma-auth`, plus the independent `omega-auth`). The
 * chain is what makes the closure non-trivial — a body must re-execute the
 * whole upstream stage, not just the project that names it.
 */
const PREPARATION_PROJECTS: readonly ConsumerProject[] = [
  {
    name: 'alpha-auth',
    file: 'specs/alpha-auth.setup.js',
    titles: ['prepares the alpha session state'],
  },
  {
    name: 'beta-auth',
    file: 'specs/beta-auth.setup.js',
    titles: ['prepares the beta session state from the alpha stage'],
  },
  {
    name: 'gamma-auth',
    file: 'specs/gamma-auth.setup.js',
    titles: ['prepares the gamma session state from the beta stage'],
  },
  {
    name: 'omega-auth',
    file: 'specs/omega-auth.setup.js',
    titles: ['prepares the omega session state'],
  },
];

/** The preparation projects, by name. */
export const PREREQUISITE_PROJECTS: readonly string[] = PREPARATION_PROJECTS.map((project) => project.name);

/**
 * The body projects: one that depends on both chains, one on the
 * independent chain, one with NO edges of its own, and one more consumer
 * of the deepest chain's generated state. Every one of them receives the
 * engine's controller as its first dependency, which is what makes the
 * edge-less project the honest measure of the projection.
 */
const BODY_PROJECTS_TABLE: readonly ConsumerProject[] = [
  {
    name: 'delta-body',
    file: 'specs/delta-body.spec.js',
    titles: ['delta observes its own chains only', ...DELTA_CLAIM_TITLES],
  },
  {
    name: 'epsilon-body',
    file: 'specs/epsilon-body.spec.js',
    titles: ['epsilon observes its own chain and an untouched baseline'],
  },
  {
    name: 'zeta-body',
    file: 'specs/zeta-body.spec.js',
    titles: ['zeta observes the frozen candidate with no preparation environment at all'],
  },
  {
    name: 'eta-body',
    file: 'specs/eta-body.spec.js',
    titles: ['eta observes the deepest chain it depends on'],
  },
];

/** The body projects, by name. */
export const BODY_PROJECTS: readonly string[] = BODY_PROJECTS_TABLE.map((project) => project.name);

/**
 * Every consumer case the fixture suite plans, in the catalog identity
 * form the sealed execution result reports: four preparation cases and
 * seven body cases.
 */
export const CONSUMER_CASES: readonly string[] = [...PREPARATION_PROJECTS, ...BODY_PROJECTS_TABLE].flatMap((project) =>
  project.titles.map((title) => `playwright:${project.name}:${project.file}:${title}`),
);

/** How many of those cases belong to a body project. */
export const BODY_CASE_COUNT: number = BODY_PROJECTS_TABLE.reduce(
  (total, project) => total + project.titles.length,
  0,
);

/** The body spec files, one per body project, in project order. */
export const BODY_SPEC_FILES: readonly string[] = BODY_PROJECTS_TABLE.map((project) => project.file);

/** One generated session state file and the session cookie it carries. */
interface GeneratedState {
  /** Repo-relative posix path the project declares as its `storageState`. */
  path: string;
  /** The cookie name the preparation stage signs into that file. */
  cookie: string;
  /** The project that declares it (its consumer). */
  consumer: string;
}

/**
 * The generated state the four preparation stages really produce, and the
 * consumer each one belongs to. Every path is git-ignored workspace bytes
 * that no commit ever carries.
 */
const GENERATED_STATE_TABLE: readonly GeneratedState[] = [
  { path: '.auth/alpha.json', cookie: 'alpha-session', consumer: 'zeta-body' },
  { path: '.auth/beta.json', cookie: 'beta-session', consumer: 'delta-body' },
  { path: '.auth/gamma.json', cookie: 'gamma-session', consumer: 'eta-body' },
  { path: '.auth/omega.json', cookie: 'omega-session', consumer: 'epsilon-body' },
];

/** The generated state files the preparation stages really produce. */
export const GENERATED_STATE: readonly string[] = GENERATED_STATE_TABLE.map((state) => state.path);

/**
 * The session cookie name one generated state file carries.
 *
 * @param statePath: the repo-relative generated state path.
 *
 * @returns
 *   string: the cookie name the file really contains.
 */
export function sessionCookieFor(statePath: string): string {
  const state = GENERATED_STATE_TABLE.find((entry) => entry.path === statePath);
  if (state === undefined) throw new Error(`no generated state is declared at '${statePath}'`);
  return state.cookie;
}

/**
 * The consumer project one generated state file belongs to.
 *
 * @param statePath: the repo-relative generated state path.
 *
 * @returns
 *   string: the project that declares it as its `use.storageState`.
 */
export function consumerOf(statePath: string): string {
  const state = GENERATED_STATE_TABLE.find((entry) => entry.path === statePath);
  if (state === undefined) throw new Error(`no generated state is declared at '${statePath}'`);
  return state.consumer;
}

/** Repo-relative path of the generated controller spec, when armed. */
export function controlSpecPath(): string {
  return `${DEFAULT_STATE_DIR}/${FREEZE_CONTROL_DIR}/${FREEZE_CONTROL_SPEC_FILE}`;
}

/** Repo-relative path of the controller's request document. */
export function controlRequestPath(): string {
  return `${DEFAULT_STATE_DIR}/${FREEZE_CONTROL_DIR}/${FREEZE_REQUEST_FILE}`;
}

/** Repo-relative path of the CLI's signed release document. */
export function controlReleasePath(): string {
  return `${DEFAULT_STATE_DIR}/${FREEZE_CONTROL_DIR}/${FREEZE_RELEASE_FILE}`;
}

/** Repo-relative path of the CLI's failure-only refusal document. */
export function controlRefusalPath(): string {
  return `${DEFAULT_STATE_DIR}/${FREEZE_CONTROL_DIR}/${FREEZE_REFUSAL_FILE}`;
}

/** One JSONL line of the runner's lifecycle spool (written in append order). */
export interface SpoolLine {
  kind: string;
  project?: string | null;
  file?: string | null;
  testId?: string;
  titlePath?: string[];
  outcome?: string;
  attempt?: number;
  preparedTreeId?: string;
  specDigest?: string;
}

/**
 * `Promise.withResolvers` for Node 20 (the supported floor), which lacks
 * it: typed resolvers, no callback nesting inside the caller.
 *
 * @returns
 *   { promise, resolve, reject }: the one-shot completion triple.
 */
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

/**
 * Runs the workspace CLI in-process, or an explicitly provisioned physical
 * CLI package. The physical launcher is what CI uses, and the physical
 * module directory is what the fixture links as `node_modules`.
 *
 * @param repo: the disposable repository the command runs in.
 * @param argv: the CLI command and its arguments.
 * @param env: operator values to add or remove from the child environment.
 *
 * @returns
 *   Promise<{ code, stdout, stderr }>: the process result.
 */
export async function runNativeCli(
  repo: TempRepo,
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const physicalBin = process.env['GATEFORGE_PHYSICAL_CLI_BIN'];
  if (physicalBin === undefined) return runWorkspaceCli(repo, argv, env);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const { promise, resolve, reject } = withResolvers<{ code: number; stdout: string; stderr: string }>();
  const child = spawn(process.execPath, [physicalBin, ...argv], {
    cwd: repo.root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.once('error', reject);
  child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  return promise;
}

/**
 * The credential one preparation stage mints: the session PART (the commit
 * the state was minted for, or the literal `value`) and the MAC the
 * protected route recomputes. Both halves are computed by this one
 * function on the fixture side and by the route below, so the route
 * authenticates a session instead of pattern-matching its name.
 *
 * @param cookieName: the session cookie name.
 * @param sessionPart: the value half (a commit sha or `value`).
 * @param secret: the per-run secret only the fixture and the route know.
 *
 * @returns
 *   string: the signed cookie value.
 */
function signedSessionValue(cookieName: string, sessionPart: string, secret: string): string {
  return `${sessionPart}.${createHash('sha256').update(`${cookieName}|${sessionPart}|${secret}`).digest('hex')}`;
}

/**
 * Starts a test-only PROTECTED route on loopback: `/session` answers 401 to
 * every caller that does not present a credential this run signed, and 200
 * to one that does. This is the auth semantics a body proves — the
 * generated session is not decorative bytes, it is the credential the
 * route demands.
 *
 * @param secret: the per-run MAC secret the preparation stages sign with.
 *
 * @returns
 *   Promise<{ url, stop }>: the base URL and the shutdown.
 */
async function startProtectedRoute(secret: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const loopback = [127, 0, 0, 1].join('.');
  const server: Server = createServer((request, response) => {
    const authenticated = (request.headers.cookie ?? '')
      .split(';')
      .map((pair) => pair.trim())
      .filter((pair) => pair !== '')
      .some((pair) => {
        const separator = pair.indexOf('=');
        if (separator < 0) return false;
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        if (!name.endsWith('-session')) return false;
        const dot = value.indexOf('.');
        if (dot <= 0) return false;
        const sessionPart = value.slice(0, dot);
        const presented = value.slice(dot + 1);
        if (!/^[0-9a-z]{1,64}$/.test(sessionPart)) return false;
        const expected = Buffer.from(signedSessionValue(name, sessionPart, secret).split('.')[1] as string);
        const given = Buffer.from(presented);
        return given.length === expected.length && timingSafeEqual(given, expected);
      });
    if (!authenticated) {
      response.writeHead(401, { 'content-type': 'text/html' });
      response.end('<p id="verdict">a generated session is required</p>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<p id="verdict">session accepted</p>');
  });
  const { promise, resolve } = withResolvers<number>();
  server.listen(0, loopback, () => {
    const address = server.address();
    resolve(typeof address === 'object' && address !== null ? address.port : 0);
  });
  const port = await promise;
  return {
    url: `http://${loopback}:${String(port)}`,
    stop: () => {
      const { promise: closed, resolve: resolveClosed } = withResolvers<void>();
      server.close(() => resolveClosed());
      return closed;
    },
  };
}

/**
 * Starts the real example app, the real attestation proxy in front of it,
 * and the test-only protected route.
 *
 * @returns
 *   Promise<{ url, protectedUrl, sessionSecret, stop }>: the attested base
 *   URL, the protected route's URL, the per-run MAC secret and the
 *   shutdown.
 */
export async function startNativeApp(): Promise<{
  url: string;
  protectedUrl: string;
  sessionSecret: string;
  stop: () => Promise<void>;
}> {
  const child = spawn(process.execPath, [join(ROOT, 'example/server.js')], {
    cwd: join(ROOT, 'example'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  const { promise: appUrlPromise, resolve: resolveAppUrl, reject: rejectAppUrl } = withResolvers<string>();
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    rejectAppUrl(new Error('example app did not report its URL in time'));
  }, 15_000);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    const match = /listening on (http:\/\/\S+)/.exec(stdout);
    if (match !== null) {
      clearTimeout(timer);
      resolveAppUrl(match[1] as string);
    }
  });
  child.once('error', (error) => {
    clearTimeout(timer);
    rejectAppUrl(error);
  });
  child.once('exit', (code) => {
    clearTimeout(timer);
    rejectAppUrl(new Error(`example app exited early (code ${String(code)}): ${stdout}`));
  });
  const appUrl = await appUrlPromise;
  const proxy = await startAttestationProxy(appUrl, FINGERPRINT);
  const sessionSecret = randomBytes(32).toString('hex');
  const protectedRoute = await startProtectedRoute(sessionSecret);
  return {
    url: proxy.url,
    protectedUrl: protectedRoute.url,
    sessionSecret,
    stop: async () => {
      await proxy.stop();
      await protectedRoute.stop();
      child.kill('SIGTERM');
    },
  };
}

/**
 * The operator environment one supervised run needs: the witness key the
 * receipts are MAC'd with, the owner-approved policy digest computed OUTSIDE
 * the candidate flow, and the ORDINARY baseline variables the fixture's
 * runtime allowlist forwards to the runner child. These names are neither
 * Gateforge- nor fixture-prefixed on purpose: the baseline a preparation
 * stage must be projected back to is an ordinary environment.
 *
 * @param repo: the repository whose policy revision is pinned.
 * @param extra: additional operator values (the attested app wiring and the
 *   per-run session secret).
 *
 * @returns
 *   Record<string, string>: the environment shared by the run and the check.
 */
export function nativeRunEnv(repo: TempRepo, extra: Record<string, string> = {}): Record<string, string> {
  const config = loadConfig(repo.path('.gateforge.yml'));
  return {
    GATEFORGE_WITNESS_VERIFIER_KEY: NATIVE_VERIFIER_KEY,
    GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
    SHOP_REGION: 'eu-west',
    SHOP_TIER: 'gold',
    [DELETED_BASELINE_KEY]: 'deprecated',
    ...extra,
  };
}

/** The attested-app wiring the supervised run and its browser need. */
export function attestedEnv(url: string, protectedUrl: string, sessionSecret: string): Record<string, string> {
  return {
    GATEFORGE_APP_BASE_URL: url,
    GATEFORGE_TARGET_BASE_URL: url,
    GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
    SHOP_PROTECTED_URL: protectedUrl,
    SHOP_SESSION_SECRET: sessionSecret,
  };
}

/** What one fixture repository varies to reach one refusal path. */
export interface NativeFixtureOptions {
  /** A preparation stage that FAILS its own work. */
  failingPrerequisite?: boolean;
  /** A preparation stage that SKIPS its own work. */
  skippedPrerequisite?: boolean;
  /** A preparation stage the runner retries once (two sessions, one identity). */
  retriedPrerequisite?: boolean;
  /** A preparation stage that writes an UNDECLARED file beside the targets. */
  unsafePreparation?: boolean;
  /** A preparation stage that moves input-bound bytes the run pinned. */
  inputMovingPreparation?: boolean;
  /** A preparation stage that turns its own target into an escaping symlink. */
  escapingSymlinkTarget?: boolean;
  /** Absolute directory OUTSIDE the repo the escaping target points into. */
  escapingOutsideDir?: string;
  /** A preparation stage that appends a BODY begin before the release exists. */
  queueEarlyBodyBegin?: boolean;
  /** The control document a preparation stage plants before the controller runs. */
  plantedRelease?: 'unsigned' | 'forged' | 'replay';
  /**
   * Absolute path OUTSIDE the repository where a GENUINE signed release is
   * captured and later re-planted byte for byte. It is configured when the
   * repository is installed, so BOTH invocations run the same candidate
   * bytes and only the environment differs; during the first invocation the
   * file simply does not exist yet, so nothing is planted.
   */
  replayCapturePath?: string;
  /** A preparation stage that plants a forged control REQUEST. */
  forgedRequest?: boolean;
  /** A body that rewrites an eligible generated target AFTER the freeze. */
  bodyRewritesGeneratedState?: boolean;
  /** A consumer project that claims the engine's own controller name. */
  reservedProjectName?: boolean;
  /** The generated state embeds the current commit, so it changes per commit. */
  stateTracksCommit?: boolean;
  /** The owner opts this repository into the test-only re-seal path. */
  resealEnabled?: boolean;
  /** An operator whole-run session state outranks every declaration. */
  operatorState?: boolean;
}

/**
 * The runtime document: the ONLY way a candidate forwards an ordinary
 * environment variable to the runner child. The names are deliberately
 * unprefixed, so the baseline a preparation stage must be projected back to
 * is an ordinary environment rather than a Gateforge namespace.
 *
 * The two fixture-carried names are ALWAYS allowlisted, in every variant:
 * a fixture whose allowlist changed between two invocations would change
 * the candidate the second invocation tests, and only the VALUE of an
 * ordinary variable may differ between them.
 *
 * @returns
 *   string: the runtime document source.
 */
function runtimeYml(): string {
  const allow = [
    'SHOP_REGION',
    'SHOP_TIER',
    DELETED_BASELINE_KEY,
    'SHOP_PROTECTED_URL',
    'SHOP_SESSION_SECRET',
    'SHOP_CAPTURED_RELEASE',
    'SHOP_ESCAPING_DIR',
  ];
  return `schemaVersion: 1
envAllowlist: [${allow.join(', ')}]
`;
}

/**
 * The control document one preparation stage plants before the controller
 * reads it.
 *
 * Three genuinely different documents, each failing at a different step of
 * the protocol:
 *
 * - UNSIGNED: this run's real identities and its real control-spec digest,
 *   and NO signature at all. The document is refused because it carries
 *   none.
 * - FORGED: the same payload, plus a signature this invocation's ephemeral
 *   key never made. Every identity is right and only the cryptography is
 *   wrong, which is the only way to prove the release is verified and not
 *   merely inspected.
 * - REPLAY: the GENUINE release an earlier invocation of this same
 *   repository signed, captured OUTSIDE the engine's control directory so
 *   this invocation's arming cannot clear it, and re-planted byte for byte.
 *   A real signature, over identities that belong to a run that is over.
 *
 * All three land in the control directory during the FIRST preparation
 * stage, long before the controller asks and long before the CLI could
 * write a release of its own.
 *
 * @param shape: which document the stage writes.
 *
 * @returns
 *   string: the statements that write the document.
 */
function plantReleaseStatement(shape: 'unsigned' | 'forged' | 'replay'): string {
  const controlDir = `'${DEFAULT_STATE_DIR}/${FREEZE_CONTROL_DIR}'`;
  if (shape === 'replay') {
    return `
  // The GENUINE release an earlier invocation of this repository signed,
  // captured outside the engine's control directory. During the very first
  // invocation nothing has been captured and nothing is planted; from the
  // second invocation on, the operator points this run at the capture and
  // the exact bytes of an earlier, genuinely signed release are re-planted.
  const captured = process.env.SHOP_CAPTURED_RELEASE;
  if (captured !== undefined && existsSync(captured)) {
    mkdirSync(${controlDir}, { recursive: true });
    writeFileSync(${controlDir} + '/${FREEZE_RELEASE_FILE}', readFileSync(captured));
  }`;
  }
  const document =
    shape === 'unsigned'
      ? `{ schemaVersion: 1, payload }`
      : `{ schemaVersion: 1, payload, signature: createHash('sha256').update('a signature this invocation never made').digest('base64') }`;
  return `
  // The identities THIS run armed, read out of the generated controller
  // spec the CLI pinned before it spawned the runner, and the sha256 of
  // that spec's own current bytes.
  const specText = readFileSync(${controlDir} + '/${FREEZE_CONTROL_SPEC_FILE}', 'utf8');
  const armedAt = specText.indexOf('const ARMED = ');
  const armedEnd = specText.indexOf('\\n};', armedAt);
  expect(armedAt >= 0 && armedEnd > armedAt, 'this run armed a freeze controller').toBe(true);
  const armed = JSON.parse(specText.slice(armedAt + 'const ARMED = '.length, armedEnd + 2));
  const payload = {
    schemaVersion: 1,
    project: armed.project,
    runId: armed.runId,
    invocationId: armed.invocationId,
    nonce: armed.nonce,
    preparedTreeId: createHash('sha256').update('a prepared tree this run never froze').digest('hex'),
    specDigest: createHash('sha256').update(readFileSync(armed.specPath)).digest('hex'),
    sealedAt: new Date().toISOString(),
  };
  mkdirSync(${controlDir}, { recursive: true });
  writeFileSync(${controlDir} + '/${FREEZE_RELEASE_FILE}', JSON.stringify(${document}) + '\\n');`;
}

/**
 * One preparation stage. It drives a REAL browser context against the
 * attested app, saves the genuine storage state into the git-ignored
 * `.auth/` directory, and produces the ordinary environment its dependents
 * inherit (the runner reports a worker's `process.env` mutations to the
 * projects that depend on it).
 *
 * @param input: the stage's identity, the state it writes and the session
 *   cookie it signs.
 * @param input.requires: state files that must already exist (chain order).
 * @param input.produces: environment the stage sets for its dependents.
 * @param input.deletes: environment the stage revokes for its dependents.
 * @param input.unsafe: write an undeclared file beside the generated targets.
 * @param input.inputMoving: move input-bound bytes the run pinned.
 * @param input.queueEarlyBodyBegin: append a body begin before the release.
 * @param input.plantedRelease: plant a control document before the controller.
 * @param input.plantedRequest: plant a forged request document.
 * @param input.skip: decline to run at all.
 * @param input.fail: fail before producing anything.
 * @param input.retry: fail the first attempt so the runner retries it.
 * @param input.trackCommit: embed the current commit in the saved session.
 * @param input.escapingSymlink: make this stage's own target escape the
 *   root AFTER the storage state was serialized.
 *
 * @returns
 *   string: the spec source of one preparation stage.
 */
function preparationSpec(input: {
  title: string;
  statePath: string;
  cookie: string;
  requires?: readonly { path: string; cookie: string }[];
  produces?: Readonly<Record<string, string>>;
  deletes?: readonly string[];
  skip?: boolean;
  fail?: boolean;
  retry?: boolean;
  unsafe?: boolean;
  inputMoving?: boolean;
  escapingSymlink?: boolean;
  queueEarlyBodyBegin?: boolean;
  plantedRelease?: 'unsigned' | 'forged' | 'replay';
  plantedRequest?: boolean;
  trackCommit?: boolean;
}): string {
  const requires = (input.requires ?? [])
    .map(
      (requirement) =>
        `  expect(readFileSync(${JSON.stringify(requirement.path)}, 'utf8'), ${JSON.stringify(requirement.path)}).toContain(${JSON.stringify(requirement.cookie)});`,
    )
    .join('\n');
  const produces = Object.entries(input.produces ?? {})
    .map(([name, value]) => `  process.env[${JSON.stringify(name)}] = ${JSON.stringify(value)};`)
    .join('\n');
  const deletes = (input.deletes ?? [])
    .map((name) => `  delete process.env[${JSON.stringify(name)}];`)
    .join('\n');
  const unsafe =
    input.unsafe === true
      ? `
  // An UNDECLARED file beside the generated targets: the declared storage
  // states are the only paths preparation may write, so this one must be
  // refused by name at the candidate diff.
  mkdirSync('.auth', { recursive: true });
  writeFileSync('.auth/undeclared.json', '{"undeclared":true}\\n');`
      : '';
  const inputMoving =
    input.inputMoving === true
      ? `
  // Preparation moved INPUT-BOUND bytes the run pinned at discovery: a
  // tracked source file, a tracked file it deleted, and an undeclared
  // file outside the generated directory.
  writeFileSync('src/accounts.js', '// fixture source: rewritten by preparation.\\n');
  rmSync('src/orders.js', { force: true });
  mkdirSync('tmp', { recursive: true });
  writeFileSync('tmp/undeclared.txt', 'undeclared output\\n');`
      : '';
  const escapingSymlink =
    input.escapingSymlink === true
      ? `
  // This stage's OWN target becomes a symlink to bytes outside the
  // candidate root. The swap happens AFTER the storageState
  // serialization, so the target really is still a symlink when the
  // freeze inspects the workspace, and the bytes it points at belong to
  // this fixture alone.
  const outside = join(String(process.env.SHOP_ESCAPING_DIR), 'escaping-session.json');
  writeFileSync(outside, '{"cookies":[],"origins":[],"ownedBy":"the escaping fixture"}\\n');
  rmSync('${input.statePath}', { force: true });
  symlinkSync(outside, '${input.statePath}');`
      : '';
  const queueEarlyBodyBegin =
    input.queueEarlyBodyBegin === true
      ? `
  // A body project's begin reaches THIS invocation's lifecycle spool
  // BEFORE the accepted release exists. The runner may only process it
  // later, behind a busy slot; the ordering audit reads file order, so
  // this must be refused however late it is graded.
  const spoolDir = '${DEFAULT_STATE_DIR}/spool';
  const runs = readdirSync(spoolDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(spoolDir, entry.name, 'events.jsonl')))
    .map((entry) => entry.name)
    .sort(
      (left, right) =>
        statSync(join(spoolDir, right, 'events.jsonl')).mtimeMs -
        statSync(join(spoolDir, left, 'events.jsonl')).mtimeMs,
    );
  expect(runs.length, 'this invocation already spooled its own lifecycle').toBeGreaterThan(0);
  appendFileSync(
    join(spoolDir, String(runs[0]), 'events.jsonl'),
    JSON.stringify({
      kind: 'testBegin',
      testId: 'queued-before-the-accepted-release',
      workerIndex: 0,
      file: 'specs/zeta-body.spec.js',
      titlePath: ['${(BODY_PROJECTS_TABLE[2] as ConsumerProject).titles[0] as string}'],
      project: 'zeta-body',
    }) + '\\n',
  );`
      : '';
  const plant =
    input.plantedRelease !== undefined
      ? plantReleaseStatement(input.plantedRelease)
      : input.plantedRequest === true
        ? `
  // A REQUEST this run never armed, planted before the controller starts:
  // well-formed, so it is read, and carrying identities that belong to no
  // invocation at all.
  mkdirSync('${DEFAULT_STATE_DIR}/${FREEZE_CONTROL_DIR}', { recursive: true });
  writeFileSync(
    '${DEFAULT_STATE_DIR}/${FREEZE_CONTROL_DIR}/${FREEZE_REQUEST_FILE}',
    JSON.stringify({
      schemaVersion: 1,
      project: '${CONTROL_PROJECT}',
      runId: 'a-run-this-never-was',
      invocationId: 'an-invocation-this-never-was',
      nonce: 'a-nonce-this-never-was',
      requestedAt: new Date().toISOString(),
    }) + '\\n',
  );`
        : '';
  const skip = input.skip === true ? `  test.skip(true, 'this preparation stage declined to run');\n` : '';
  const fail =
    input.fail === true ? `  throw new Error('preparation stage failed before it produced its state');\n` : '';
  const retry =
    input.retry === true
      ? `
  if (testInfo.retry === 0) {
    throw new Error('first attempt failed; the runner retries it, so this identity gets two sessions');
  }`
      : '';
  const commit = input.trackCommit === true
    ? `  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();\n`
    : '';
  const sessionPart = input.trackCommit === true ? 'commit' : "'value'";
  return `import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@gate-forge/pack-playwright';
${input.retry === true ? '\ntest.describe.configure({ retries: 1 });\n' : ''}
test('${input.title}', async ({ browser }, testInfo) => {
${skip}${requires}${commit}
${fail}${retry}${unsafe}${inputMoving}${queueEarlyBodyBegin}${plant}
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(new URL('/', String(process.env.GATEFORGE_APP_BASE_URL)).toString());
  expect(page.url()).toContain('/');
  // The session this stage saves is a CREDENTIAL the protected route
  // accepts: a session part plus a MAC over this cookie name, this part
  // and the run's own secret.
  const sessionPart = ${sessionPart};
  const value =
    sessionPart +
    '.' +
    createHash('sha256')
      .update('${input.cookie}|' + sessionPart + '|' + String(process.env.SHOP_SESSION_SECRET))
      .digest('hex');
  await context.addCookies([
    { name: '${input.cookie}', value, url: new URL('/', page.url()).toString() },
  ]);
  mkdirSync('.auth', { recursive: true });
  await context.storageState({ path: '${input.statePath}' });
  expect(readFileSync('${input.statePath}', 'utf8')).toContain('${input.cookie}');
${input.trackCommit === true ? "  expect(readFileSync('${input.statePath}', 'utf8')).toContain(commit);\n" : ''}
  await context.close();
${escapingSymlink}
${produces}
${deletes}
});
`;
}

/** The alpha preparation stage: the head of the deepest chain. */
function alphaSpec(options: NativeFixtureOptions): string {
  return preparationSpec({
    title: (PREPARATION_PROJECTS[0] as ConsumerProject).titles[0] as string,
    statePath: '.auth/alpha.json',
    cookie: 'alpha-session',
    // An ordinary baseline variable CHANGED, and one that did not exist at
    // baseline at all CREATED.
    produces: { SHOP_REGION: 'alpha-region', [INTRODUCED_KEY]: 'alpha-created' },
    fail: options.failingPrerequisite === true,
    skip: options.skippedPrerequisite === true,
    retry: options.retriedPrerequisite === true,
    unsafe: options.unsafePreparation === true,
    inputMoving: options.inputMovingPreparation === true,
    escapingSymlink: options.escapingSymlinkTarget === true,
    queueEarlyBodyBegin: options.queueEarlyBodyBegin === true,
    ...(options.plantedRelease !== undefined ? { plantedRelease: options.plantedRelease } : {}),
    ...(options.replayCapturePath !== undefined ? { plantedRelease: 'replay' as const } : {}),
    plantedRequest: options.forgedRequest === true,
    trackCommit: options.stateTracksCommit === true,
  });
}

/** The beta preparation stage: reads alpha's state, overrides its scope. */
function betaSpec(): string {
  return preparationSpec({
    title: (PREPARATION_PROJECTS[1] as ConsumerProject).titles[0] as string,
    statePath: '.auth/beta.json',
    cookie: 'beta-session',
    requires: [{ path: '.auth/alpha.json', cookie: 'alpha-session' }],
    // The conflicting value for the key alpha changed, plus a DELETION of
    // an ordinary key that WAS part of the baseline.
    produces: { SHOP_REGION: 'beta-region' },
    deletes: [DELETED_BASELINE_KEY],
  });
}

/** The gamma preparation stage: the tail of the deepest chain. */
function gammaSpec(): string {
  return preparationSpec({
    title: (PREPARATION_PROJECTS[2] as ConsumerProject).titles[0] as string,
    statePath: '.auth/gamma.json',
    cookie: 'gamma-session',
    requires: [{ path: '.auth/beta.json', cookie: 'beta-session' }],
    produces: { SHOP_TIER: 'gamma-tier' },
  });
}

/** The omega preparation stage: the independent chain (its name sorts last). */
function omegaSpec(options: NativeFixtureOptions): string {
  return preparationSpec({
    title: (PREPARATION_PROJECTS[3] as ConsumerProject).titles[0] as string,
    statePath: '.auth/omega.json',
    cookie: 'omega-session',
    produces: { SHOP_REGION: 'omega-region', [INTRODUCED_KEY]: 'omega-created' },
    fail: options.failingPrerequisite === true,
  });
}

/** The three claim-bearing journeys of the delta body. */
const DELTA_CLAIMS = `let createdId = '';

test('creates an account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:create' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.create({ fields: { first_name: 'Ada', last_name: 'Lovelace' } });
  createdId = receipt.entityId;
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts' });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});

test('updates the account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:update' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.update({
    entityId: createdId,
    fields: { first_name: 'Ada King', last_name: 'Lovelace' },
  });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts/' + createdId });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});

test('archives the account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:delete' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.archive({ entityId: createdId });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts/' + createdId + '/archive' });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});
`;

/**
 * One body project. Every assertion measures something only the body
 * itself can observe: the environment its own worker started with, the
 * session state it inherited through the frozen candidate, and that the
 * route really refuses an unauthenticated caller.
 *
 * @param input: the body project, its state, its own chain, the
 *   environment it must see, and the environment that must be gone.
 *
 * @returns
 *   string: the spec source of one body project.
 */
function bodySpec(input: {
  title: string;
  ownCookie: string;
  fileCookie: string;
  statePath: string;
  expectEnv: Readonly<Record<string, string>>;
  absentEnv: readonly string[];
  claims?: string;
  rewriteState?: boolean;
}): string {
  const expectEnv = Object.entries(input.expectEnv)
    .map(
      ([name, value]) =>
        `  expect(process.env[${JSON.stringify(name)}], ${JSON.stringify(name)}).toBe(${JSON.stringify(value)});`,
    )
    .join('\n');
  const absentEnv = input.absentEnv
    .map((name) => `  expect(process.env[${JSON.stringify(name)}], ${JSON.stringify(name)}).toBeUndefined();`)
    .join('\n');
  const rewrite =
    input.rewriteState === true
      ? `
  // The body writes an ADMISSIBLE generated target AFTER the freeze: the
  // bytes the candidate was frozen over are no longer the bytes on disk,
  // and no later body may launder them into the sealed candidate.
  writeFileSync('${input.statePath}', '{"cookies":[],"origins":[],"rewritten":"after the freeze"}\\n');`
      : '';
  const claims = input.claims ?? '';
  return `import { readFileSync, writeFileSync } from 'node:fs';
import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { accountsSurface } from './accounts-surface.js';
const test = gateforgeTest.extend({ surface: accountsSurface });

test('${input.title}', async ({ browser, context, page }) => {
${expectEnv}
${absentEnv}
  // The session this body started from is the generated one, and it is a
  // signed credential rather than arbitrary bytes.
  const own = (await context.cookies()).find((cookie) => cookie.name === '${input.ownCookie}');
  expect(own, 'this body started from its generated session state').toBeDefined();
  expect(own?.value ?? '', 'the generated session is signed').toMatch(/^[0-9a-z]{1,64}\\.[0-9a-f]{64}$/);
  const saved = readFileSync('${input.statePath}', 'utf8');
  const savedCookie = JSON.parse(saved).cookies.find((cookie) => cookie.name === '${input.fileCookie}');
  expect(savedCookie, '${input.statePath} really carries the ${input.fileCookie} session').toBeDefined();

  // The protected route is the authority: it answers 401 to a caller with
  // no credential at all, and 200 only to the credential this run signed.
  const anonymous = await browser.newContext();
  const denied = await anonymous.newPage().goto(String(process.env.SHOP_PROTECTED_URL) + '/session');
  expect(denied?.status(), 'the route refuses an unauthenticated caller').toBe(401);
  await anonymous.close();
  const granted = await page.goto(String(process.env.SHOP_PROTECTED_URL) + '/session');
  expect(granted?.status(), 'the route accepts the generated session').toBe(200);
${rewrite}
});

${claims}`;
}

/**
 * The consumer's Playwright config. Two uneven-depth preparation chains
 * (`alpha-auth` → `beta-auth` → `gamma-auth`, plus the independent
 * `omega-auth`) and four bodies: one that depends on both chains, one on
 * the independent chain, one with NO edges of its own, and one more
 * consumer of the deepest chain's generated state. Every generated state
 * file is declared as some project's `use.storageState`, so the engine's
 * sealed native config nominates all four as generated targets.
 *
 * @param options: the fixture variant (a consumer may claim the engine's
 *   own controller name, which is a conflict the freeze must refuse).
 *
 * @returns
 *   string: the consumer config source.
 */
function playwrightConfig(options: NativeFixtureOptions): string {
  const reserved =
    options.reservedProjectName === true
      ? `    { name: '${CONTROL_PROJECT}', testMatch: 'alpha-auth.setup.js' },\n`
      : '';
  return `import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: 'specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  projects: [
    { name: 'alpha-auth', testMatch: 'alpha-auth.setup.js' },
    { name: 'beta-auth', testMatch: 'beta-auth.setup.js', dependencies: ['alpha-auth'] },
    { name: 'gamma-auth', testMatch: 'gamma-auth.setup.js', dependencies: ['beta-auth'] },
    { name: 'omega-auth', testMatch: 'omega-auth.setup.js' },
    { name: 'delta-body', testMatch: 'delta-body.spec.js', dependencies: ['beta-auth', 'gamma-auth'], use: { storageState: '.auth/beta.json' } },
    { name: 'epsilon-body', testMatch: 'epsilon-body.spec.js', dependencies: ['omega-auth'], use: { storageState: '.auth/omega.json' } },
    { name: 'zeta-body', testMatch: 'zeta-body.spec.js', use: { storageState: '.auth/alpha.json' } },
    { name: 'eta-body', testMatch: 'eta-body.spec.js', dependencies: ['gamma-auth'], use: { storageState: '.auth/gamma.json' } },
${reserved}  ],
  use: { headless: true, trace: 'off', browserName: 'chromium' },
  timeout: 60_000,
});
`;
}

/**
 * Installs the fixture repository and commits it: a real consumer project
 * whose eight Playwright projects prepare real session state and consume it
 * through four bodies.
 *
 * @param repo: the temporary repository to build.
 * @param options: which refusal path this fixture must reach.
 *
 * @returns
 *   void.
 */
export function installNativeFreezeFixture(repo: TempRepo, options: NativeFixtureOptions = {}): void {
  const gateforgeConfig = `schemaVersion: 1
project:
  languages: [javascript]
  paths: { include: ['src/**', 'specs/**'], exclude: [] }
plugins:
  - id: gateforge.fixture
    version: 1.0.0
    transport: in-process
    module: ./.gateforge/fixture-detector.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
runtime: .gateforge/runtime.yml
changed: { provider: auto }
witness: { maxDurationSeconds: 5 }
clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }
enforcement:
  strictE2E: true${options.resealEnabled === true ? '\n  reseal: true' : ''}
`;
  // With an operator whole-run session state, no declared project state
  // ever reaches a body: the operator's session is what every body starts
  // from, and the generated files are only read, never served.
  const ownCookie = options.operatorState === true ? OPERATOR_COOKIE : null;
  repo.writeFiles({
    '.gateforge.yml': gateforgeConfig,
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/adapters/tenant.accounts.mjs': ADAPTER,
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
    '.gateforge/runtime.yml': runtimeYml(),
    'src/accounts.js': '// fixture source: the accounts resource lives here.\n',
    'src/orders.js': '// fixture source: the orders resource lives here.\n',
    'specs/accounts-surface.js': readFileSync(join(ROOT, 'example/e2e/accounts-surface.js'), 'utf8'),
    'specs/alpha-auth.setup.js': alphaSpec(options),
    'specs/beta-auth.setup.js': betaSpec(),
    'specs/gamma-auth.setup.js': gammaSpec(),
    'specs/omega-auth.setup.js': omegaSpec(options),
    'specs/delta-body.spec.js': bodySpec({
      title: (BODY_PROJECTS_TABLE[0] as ConsumerProject).titles[0] as string,
      ownCookie: ownCookie ?? 'beta-session',
      fileCookie: 'beta-session',
      statePath: '.auth/beta.json',
      // Its OWN chains' values win over the baseline the controller
      // projected back: that is only true while the controller is the
      // FIRST dependency, ahead of the body's original edges.
      expectEnv: { SHOP_REGION: 'beta-region', SHOP_TIER: 'gamma-tier' },
      // The baseline key its own chain revoked, and the key that chain
      // created two hops up: neither may survive the projection.
      absentEnv: [DELETED_BASELINE_KEY, INTRODUCED_KEY],
      claims: DELTA_CLAIMS,
    }),
    'specs/epsilon-body.spec.js': bodySpec({
      title: (BODY_PROJECTS_TABLE[1] as ConsumerProject).titles[0] as string,
      ownCookie: ownCookie ?? 'omega-session',
      fileCookie: 'omega-session',
      statePath: '.auth/omega.json',
      // Its own chain's values, plus the baseline values another chain
      // never touched and another chain DID revoke: both come back
      // untouched here, because they were projected back to the baseline.
      expectEnv: {
        SHOP_REGION: 'omega-region',
        [INTRODUCED_KEY]: 'omega-created',
        SHOP_TIER: 'gold',
        [DELETED_BASELINE_KEY]: 'deprecated',
      },
      absentEnv: [],
    }),
    'specs/zeta-body.spec.js': bodySpec({
      title: (BODY_PROJECTS_TABLE[2] as ConsumerProject).titles[0] as string,
      ownCookie: ownCookie ?? 'alpha-session',
      fileCookie: 'alpha-session',
      statePath: '.auth/alpha.json',
      // An independent project has no edge of its own, so EVERY ordinary
      // baseline value is back exactly as it was and nothing a preparation
      // stage produced survives.
      expectEnv: { SHOP_REGION: 'eu-west', SHOP_TIER: 'gold', [DELETED_BASELINE_KEY]: 'deprecated' },
      absentEnv: [INTRODUCED_KEY],
      rewriteState: options.bodyRewritesGeneratedState === true,
    }),
    'specs/eta-body.spec.js': bodySpec({
      title: (BODY_PROJECTS_TABLE[3] as ConsumerProject).titles[0] as string,
      ownCookie: ownCookie ?? 'gamma-session',
      fileCookie: 'gamma-session',
      statePath: '.auth/gamma.json',
      // Only the project this body depends on produces environment for it:
      // gamma changed the tier, and every other value is the baseline the
      // controller projected back — including the key beta revoked one hop
      // earlier, which never travelled a second hop.
      expectEnv: { SHOP_TIER: 'gamma-tier', SHOP_REGION: 'eu-west', [DELETED_BASELINE_KEY]: 'deprecated' },
      absentEnv: [INTRODUCED_KEY],
    }),
    'playwright.config.mjs': playwrightConfig(options),
    'package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    // `.auth/` is gitignored: the preparation stages write their genuine
    // session state there, so it exists as ignored workspace bytes and
    // never in a commit.
    '.gitignore': ['node_modules', '.auth/', `${DEFAULT_STATE_DIR}`, ''].join('\n'),
  });
  symlinkSync(
    process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'),
    join(repo.root, 'node_modules'),
    'dir',
  );
  repo.git(['add', '-A']);
  repo.commit('native preparation fixture');
}

/**
 * Writes an operator-provided whole-run browser state into the repository
 * (tracked bytes, so it is a real input of the candidate). The cookie's
 * domain is the REAL host of the attested origin, never a literal, and its
 * value is a credential this run's protected route really accepts.
 *
 * @param repo: the repository to write into.
 * @param origin: the attested base URL the session belongs to.
 * @param secret: the per-run MAC secret.
 * @param cookie: the cookie name the operator session carries.
 *
 * @returns
 *   string: the repo-relative path of the operator state.
 */
export function installOperatorState(
  repo: TempRepo,
  origin: string,
  secret: string,
  cookie: string = OPERATOR_COOKIE,
): string {
  const path = '.gateforge/operator-state.json';
  repo.writeFiles({
    [path]: `${JSON.stringify(
      {
        cookies: [
          {
            name: cookie,
            value: signedSessionValue(cookie, 'value', secret),
            domain: new URL(origin).hostname,
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      },
      null,
      2,
    )}\n`,
  });
  repo.git(['add', '-A']);
  repo.commit('operator whole-run session state');
  return path;
}

/** The sealed execution result of the run that just finished. */
export interface SealedExecution {
  planned: Array<{ logicalKey: string; project: string | null; file: string; titlePath: string[] }>;
  outcomes: Array<{ logicalKey: string; project: string | null; file: string; status: string; attempt: number }>;
  complete: boolean;
  sessionTrace?: Array<{
    file: string;
    titlePath: string[];
    sessions: Array<{ outcome: string | null; sealedTick: number | null; activity: number }>;
  }>;
}

/**
 * The subset of a sealed gate receipt these suites bind to.
 */
export interface SealedReceipt {
  receiptId: string;
  runId: string;
  inputDigest: string;
  candidateTreeId: string;
  changedPaths?: string[];
  resealDisregarded?: string[];
  carriedTests?: number;
  rerunTests?: number;
  resealedFrom?: string;
  resealedFromKind?: string;
}

/**
 * Reads the sealed execution result the run left behind.
 *
 * @param repo: the repository the run sealed into.
 *
 * @returns
 *   SealedExecution: the parsed result, or null when the run sealed none.
 */
export function sealedExecution(repo: TempRepo): SealedExecution | null {
  const path = join(resolveStateDir(repo.root), 'execution-result.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as SealedExecution;
}

/**
 * Reads the sealed gate receipt, or null when the run left none.
 *
 * @param repo: the repository the run sealed into.
 *
 * @returns
 *   SealedReceipt | null: the sealed bindings.
 */
export function sealedReceipt(repo: TempRepo): SealedReceipt | null {
  const path = join(resolveStateDir(repo.root), 'receipt.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as SealedReceipt;
}

/**
 * How many re-seal chain hops the run state currently retains.
 *
 * @param repo: the repository the chain lives in.
 *
 * @returns
 *   number: the retained hop count (0 when the chain was cleared).
 */
export function resealChainHops(repo: TempRepo): number {
  const directory = join(resolveStateDir(repo.root), 'reseal-chain');
  try {
    return readdirSync(directory).length;
  } catch {
    return 0;
  }
}

/**
 * Re-reads ONE run's lifecycle spool in FILE order — the same evidence the
 * freeze ordering audit grades — and returns one entry per line. The lines
 * share one ordinary local file, so file order is append order and nothing
 * here claims physical immutability. The run is the one the current receipt
 * binds, or the most recent run directory when the last run sealed no
 * receipt (a refusal).
 *
 * @param repo: the repository the run spooled into.
 * @param runIdOverride: read exactly this run instead (a suite that inspects
 *   a refusal which followed an earlier sealed run).
 *
 * @returns
 *   SpoolLine[]: every line of that run's spool, in file order.
 */
export function spoolLines(repo: TempRepo, runIdOverride?: string): SpoolLine[] {
  const spoolDir = join(resolveStateDir(repo.root), 'spool');
  if (!existsSync(spoolDir)) return [];
  const runs = readdirSync(spoolDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(spoolDir, name, 'events.jsonl')));
  const bound = runIdOverride ?? sealedReceipt(repo)?.runId;
  const runId =
    bound !== undefined && runs.includes(bound)
      ? bound
      : runs.sort(
          (left, right) =>
            statSync(join(spoolDir, right, 'events.jsonl')).mtimeMs -
            statSync(join(spoolDir, left, 'events.jsonl')).mtimeMs,
        )[0];
  if (runId === undefined) return [];
  const lines: SpoolLine[] = [];
  for (const line of readFileSync(join(spoolDir, runId, 'events.jsonl'), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    lines.push(JSON.parse(line) as SpoolLine);
  }
  return lines;
}

/**
 * Reads the MOST RECENT run's spool in file order, regardless of which
 * receipt is currently on disk. A suite that runs a genuine run and then
 * a refusal in the same repository inspects the refusal this way.
 *
 * @param repo: the repository the runs spooled into.
 *
 * @returns
 *   SpoolLine[]: every line of the newest run's spool, in file order.
 */
export function newestSpoolLines(repo: TempRepo): SpoolLine[] {
  const spoolDir = join(resolveStateDir(repo.root), 'spool');
  if (!existsSync(spoolDir)) return [];
  const runs = readdirSync(spoolDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(spoolDir, name, 'events.jsonl')))
    .sort(
      (left, right) =>
        statSync(join(spoolDir, right, 'events.jsonl')).mtimeMs -
        statSync(join(spoolDir, left, 'events.jsonl')).mtimeMs,
    );
  return runs[0] === undefined ? [] : spoolLines(repo, runs[0]);
}

/**
 * Recomputes the raw candidate tree of a workspace exactly the way the
 * freeze, the receipt and the broker do, so a test can tell a PREPARED
 * tree (which contains the generated state) from the pre-run one.
 *
 * @param repo: the workspace to walk.
 *
 * @returns
 *   string | null: the candidate tree id, or null without a Git directory.
 */
export function candidateTreeIdOf(repo: TempRepo): string | null {
  const gitDir = resolveGitDir(repo.root, process.env);
  if (gitDir === null) return null;
  const config = loadConfig(repo.path('.gateforge.yml'));
  return computeCandidateTreeId(
    gitDir,
    repo.root,
    process.env,
    resolveStateDir(repo.root),
    'record',
    [],
    loadDocsExclusions(repo.root, config),
    loadCacheExclusions(repo.root, config),
  );
}

/**
 * The commit-only candidate change every positive run grades: a comment
 * added to the resource source the obligations bind. It is UNSTAGED, so a
 * `check --changed` grades exactly these working-tree bytes and the run
 * seals a receipt over the tree that contains them.
 *
 * @param repo: the fixture repository.
 *
 * @returns
 *   void.
 */
export function writeCandidateChange(repo: TempRepo): void {
  repo.writeFiles({
    'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited comment.\n',
  });
}