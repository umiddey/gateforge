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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type TempRepo } from '@gate-forge/core';
import {
  FREEZE_CONTROL_DIR,
  FREEZE_CONTROL_SPEC_FILE,
  FREEZE_CONTROLLER_PROJECT,
  FREEZE_RELEASE_FILE,
  FREEZE_REQUEST_FILE,
  FREEZE_REFUSAL_FILE,
  TRUSTED_REPORTER_OPTIONS_FILE,
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

/**
 * The ordinary baseline variable a preparation stage revokes. Both
 * meaningful fixture names are ordinary, non-reserved and carry no
 * shared prefix: the controller's projection is proved over names that
 * are not a namespace of the engine's own, not over a family that
 * happens to look alike.
 */
const DELETED_BASELINE_KEY = 'LEGACY_ACCOUNT_SCOPE';

/** The ordinary variable NO baseline has and preparation introduces. */
const INTRODUCED_KEY = 'SESSION_TICKET';

/**
 * The ordinary variable a revision-driven preparation stage mints its
 * session for. It is an operator value like every other baseline name in
 * this fixture, and it is forwarded to the runner child only through the
 * repository's own runtime allowlist — never by a Gateforge-private channel.
 */
export const SESSION_REVISION_ENV = 'SHOP_STATE_REVISION';

/**
 * The three names a plain object's prototype already carries. No prefix
 * restriction is available for them and none is invented here: the
 * variable the operator really owns may be named `constructor`, `toString`
 * or `__proto__`, and an environment projection has to carry all three.
 */
const PROTOTYPE_BASELINE_NAMES: readonly string[] = ['constructor', 'toString', '__proto__'];

/**
 * The OWN trusted baseline values of those three names, built with
 * `Object.fromEntries` on purpose. An object literal would hand
 * `__proto__` to the prototype setter instead of defining it, and an
 * ordinary lookup would find an inherited member where the owner set a
 * real value — so the baseline this fixture declares must be constructed
 * the only way that makes all three OWN.
 */
const PROTOTYPE_BASELINE_VALUES: Readonly<Record<string, string>> = Object.fromEntries([
  ['constructor', 'trusted-constructor'],
  ['toString', 'trusted-tostring'],
  ['__proto__', 'trusted-proto'],
]);

/**
 * What the alpha preparation stage sets for its OWN dependents: two of the
 * three names change, and `__proto__` is deliberately left alone. Nothing
 * here guesses what deleting an own `__proto__` should mean downstream —
 * the stage simply does not touch that name.
 */
const PROTOTYPE_ALPHA_VALUES: Readonly<Record<string, string>> = Object.fromEntries([
  ['constructor', 'alpha-constructor'],
  ['toString', 'alpha-tostring'],
]);

/**
 * The prototype-name values a body inherits: the trusted baseline, with
 * the stage's own values layered over the names it changed. Both operands
 * are spread, and a spread defines own properties instead of assigning
 * them, so `__proto__` survives as a real entry here too.
 *
 * @param overrides: the values a preparation stage set for its dependents.
 *
 * @returns
 *   Record<string, string>: the OWN values, one per prototype name.
 */
function prototypeBaselineValues(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { ...PROTOTYPE_BASELINE_VALUES, ...overrides };
}

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
 * One body project of the root-scanning layout: its identity, the session
 * it starts from, and the preparation stages it reads that session behind.
 */
interface RootScanBody extends ConsumerProject {
  /** The session cookie this body starts from. */
  cookie: string;
  /** The generated state this body declares as its own `use.storageState`. */
  statePath: string;
  /** The preparation projects this body depends on, by name. */
  prerequisites: readonly string[];
}

/**
 * The WIDE body project's name: the project that names neither a `testDir`
 * nor a `testMatch`, so Playwright's own default match collects every spec
 * file in the repository. That is the common repository-level shape, and it
 * is the shape in which anything the engine writes INSIDE the candidate
 * becomes one of the consumer's own tests.
 */
export const ROOT_SCAN_BODY_PROJECT = 'chromium';

/** The wide body project: its spec file, its cases, its declared session. */
const ROOT_SCAN_BODY: RootScanBody = {
  name: ROOT_SCAN_BODY_PROJECT,
  file: 'tests/session.spec.js',
  titles: [
    'the prepared session authenticates against the protected route',
    'every preparation chain really ran before this body',
    ...DELTA_CLAIM_TITLES,
  ],
  cookie: 'gamma-session',
  statePath: '.auth/gamma.json',
  prerequisites: ['gamma-auth', 'omega-auth'],
};

/**
 * The ordinary body projects that give the remaining generated states a
 * declaring project.
 *
 * A generated output is admissible only where some project declared it as
 * `use.storageState`, and one project declares one state — so a layout
 * whose wide body project can declare only one of them needs real body
 * projects for the rest. A SETUP project can never be one of them: a
 * project's `use` is applied to every context it opens, including the one a
 * preparation stage opens for itself, and the stage's own state does not
 * exist until that stage has written it.
 */
const ROOT_SCAN_STATE_BODIES: readonly RootScanBody[] = [
  {
    name: 'alpha-body',
    file: 'tests/alpha-session.spec.js',
    titles: ['the alpha session authenticates against the protected route'],
    cookie: 'alpha-session',
    statePath: '.auth/alpha.json',
    prerequisites: ['alpha-auth'],
  },
  {
    name: 'beta-body',
    file: 'tests/beta-session.spec.js',
    titles: ['the beta session authenticates against the protected route'],
    cookie: 'beta-session',
    statePath: '.auth/beta.json',
    prerequisites: ['beta-auth'],
  },
  {
    name: 'omega-body',
    file: 'tests/omega-session.spec.js',
    titles: ['the omega session authenticates against the protected route'],
    cookie: 'omega-session',
    statePath: '.auth/omega.json',
    prerequisites: ['omega-auth'],
  },
];

/**
 * Every consumer case one fixture layout plans, in the catalog identity
 * form the sealed execution result reports: the four preparation cases
 * plus that layout's body cases.
 *
 * @param options: the fixture variant being installed.
 *
 * @returns
 *   string[]: the planned identities.
 */
export function consumerCasesFor(options: NativeFixtureOptions = {}): readonly string[] {
  const bodies =
    options.rootScanningConfig === true ? [ROOT_SCAN_BODY, ...ROOT_SCAN_STATE_BODIES] : BODY_PROJECTS_TABLE;
  return [...PREPARATION_PROJECTS, ...bodies].flatMap((project) =>
    project.titles.map((title) => `playwright:${project.name}:${project.file}:${title}`),
  );
}

/**
 * Every consumer case the DEFAULT layout plans, in the catalog identity
 * form the sealed execution result reports: four preparation cases and
 * seven body cases.
 *
 * The one layout that runs a different body set derives its own through
 * {@link consumerCasesFor}, so no suite ever has to spell a case identity
 * by hand.
 */
export const CONSUMER_CASES: readonly string[] = consumerCasesFor();

/** How many of those cases belong to a body project. */
export const BODY_CASE_COUNT: number = BODY_PROJECTS_TABLE.reduce(
  (total, project) => total + project.titles.length,
  0,
);

/** The body spec files, one per body project, in project order. */
export const BODY_SPEC_FILES: readonly string[] = BODY_PROJECTS_TABLE.map((project) => project.file);

/** One generated session state file: what it carries and who reads it. */
interface GeneratedStateMetadata {
  /** The cookie name the preparation stage signs into that file. */
  cookie: string;
  /** The project that declares it as its `storageState`. */
  consumer: string;
}

/**
 * The generated state the four preparation stages really produce, keyed by
 * the repo-relative path a project declares as its `storageState`, with the
 * session cookie that state carries and the consumer each one belongs to.
 * Every key is git-ignored workspace bytes that no commit ever carries.
 */
const GENERATED_STATE_BY_PATH: Readonly<Record<string, GeneratedStateMetadata>> = {
  '.auth/alpha.json': { cookie: 'alpha-session', consumer: 'zeta-body' },
  '.auth/beta.json': { cookie: 'beta-session', consumer: 'delta-body' },
  '.auth/gamma.json': { cookie: 'gamma-session', consumer: 'eta-body' },
  '.auth/omega.json': { cookie: 'omega-session', consumer: 'epsilon-body' },
};

/**
 * The generated state files the preparation stages really produce, in the
 * order this table declares them.
 */
export const GENERATED_STATE: readonly string[] = Object.keys(GENERATED_STATE_BY_PATH);

/**
 * The session cookie name one generated state file carries.
 *
 * @param statePath: the repo-relative generated state path.
 *
 * @returns
 *   string: the cookie name the file really contains.
 */
export function sessionCookieFor(statePath: string): string {
  // The own-property guard is not decoration: a plain lookup on an object
  // literal also finds INHERITED members — `toString`, `constructor`,
  // `__proto__` — so an unguarded read would hand back one of those instead
  // of the unknown-path error these helpers have always thrown.
  const state: GeneratedStateMetadata | undefined = Object.hasOwn(GENERATED_STATE_BY_PATH, statePath)
    ? GENERATED_STATE_BY_PATH[statePath]
    : undefined;
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
  const state: GeneratedStateMetadata | undefined = Object.hasOwn(GENERATED_STATE_BY_PATH, statePath)
    ? GENERATED_STATE_BY_PATH[statePath]
    : undefined;
  if (state === undefined) throw new Error(`no generated state is declared at '${statePath}'`);
  return state.consumer;
}

/**
 * The generated controller's file NAME, wherever this run placed it.
 *
 * The engine generates that spec into a private per-run directory of its
 * own, OUTSIDE the candidate, and removes it when the run ends: no suite
 * can predict its path, but its name is the engine's own constant, and it
 * is the name a lifecycle record or a filesystem sweep must recognize.
 */
export const CONTROL_SPEC_FILE: string = FREEZE_CONTROL_SPEC_FILE;

/**
 * Repo-relative path of the control directory: the handshake's own
 * documents (request, release, refusal), which the run publishes INSIDE
 * the run-state directory as evidence and never as candidate code.
 *
 * @param stateDir: repo-relative run-state directory the run actually
 *   resolved (`--out`); the configured one when absent.
 *
 * @returns
 *   string: the repo-relative control directory.
 */
export function controlDirPath(stateDir: string = DEFAULT_STATE_DIR): string {
  return `${stateDir}/${FREEZE_CONTROL_DIR}`;
}

/**
 * Every generated controller spec still inside the repository, as
 * repo-relative posix paths.
 *
 * The sweep never follows a link: `node_modules` is a link into the
 * workspace in every fixture variant, and a candidate's own link is not
 * the engine's output. `.git` holds no candidate file of its own.
 *
 * @param repo: the repository to sweep.
 *
 * @returns
 *   string[]: the repo-relative spec paths, empty when the repository
 *   holds no generated controller code.
 */
export function controlSpecsInRepo(repo: TempRepo): readonly string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === FREEZE_CONTROL_SPEC_FILE) {
        found.push(relative(repo.root, path).split(sep).join('/'));
      }
    }
  };
  visit(repo.root);
  return found.sort();
}

/** Repo-relative path of the controller's request document. */
export function controlRequestPath(): string {
  return `${DEFAULT_STATE_DIR}/${FREEZE_CONTROL_DIR}/${FREEZE_REQUEST_FILE}`;
}

/**
 * Repo-relative path of the CLI's signed release document.
 *
 * @param stateDir: repo-relative run-state directory the run actually
 *   resolved (`--out`); the configured one when absent.
 *
 * @returns
 *   string: the repo-relative release path.
 */
export function controlReleasePath(stateDir: string = DEFAULT_STATE_DIR): string {
  return `${stateDir}/${FREEZE_CONTROL_DIR}/${FREEZE_RELEASE_FILE}`;
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
  // A NULL-PROTOTYPE child map. The operator's baseline may really own a
  // key named `__proto__`; on an ordinary object that assignment would
  // reach Object.prototype's setter and the value would never reach the
  // CLI at all. Every value, every removal and every physical-CLI flag
  // below is unchanged — only the container's prototype is.
  const childEnv: NodeJS.ProcessEnv = Object.assign(Object.create(null) as NodeJS.ProcessEnv, process.env);
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

/** One untrusted report node, narrowed to a plain record or to nothing. */
function asRecord(value: unknown): Record<string, unknown> | null {
  // The narrowing boundary for every report read below: `JSON.parse`
  // hands back `any`, so a node is reduced to a plain record here — or to
  // nothing — before any field of it is read.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One untrusted value, narrowed to a list (empty when it is not one). */
function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** One named string field of an untrusted node, or `''` when absent. */
function stringField(node: Record<string, unknown>, field: string): string {
  const value = node[field];
  return typeof value === 'string' ? value : '';
}

/**
 * The cases the CONSUMER'S OWN Playwright lists: its installed CLI, its own
 * config, its own working directory, and no Gateforge process anywhere in
 * the invocation — every `GATEFORGE_*` variable is stripped from the child
 * first. This is exactly the listing an operator gets from `npx playwright
 * test --list` in their own repository, so a file the engine left behind
 * inside that repository shows up here whether or not the engine ever runs
 * again.
 *
 * The report is read from the JSON reporter's own output file rather than
 * from stdout, because a consumer's config routinely prints at load time
 * and stdout is not a document channel.
 *
 * @param repo: the fixture repository.
 *
 * @returns
 *   Promise<{ code, cases, stdout, stderr }>: the CLI result, and one
 *   `playwright:<project>:<file>:<title>` identity per listed test — the
 *   same identity form the sealed execution result reports — sorted.
 */
export async function listConsumerCases(repo: TempRepo): Promise<{
  code: number;
  cases: readonly string[];
  stdout: string;
  stderr: string;
}> {
  const reportDir = mkdtempSync(join(tmpdir(), 'gateforge-consumer-list-'));
  const reportPath = join(reportDir, 'reporter.json');
  // A NULL-PROTOTYPE child map, so stripping one of the engine's own names
  // cannot reach a prototype setter instead of the entry it names.
  const childEnv: NodeJS.ProcessEnv = Object.assign(Object.create(null) as NodeJS.ProcessEnv, process.env);
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('GATEFORGE_')) delete childEnv[key];
  }
  childEnv['PLAYWRIGHT_JSON_OUTPUT_FILE'] = reportPath;
  let stdout = '';
  let stderr = '';
  try {
    const child = spawn(
      process.execPath,
      [join(repo.root, 'node_modules', 'playwright', 'cli.js'), 'test', '--list', '--reporter=json'],
      { cwd: repo.root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number>((settle, fail) => {
      child.once('error', fail);
      // `exit` only means the process ended; the reporter may still be
      // writing, so the captured streams are read only after `close`.
      child.once('close', (closed) => settle(closed ?? 1));
    });
    return { code, cases: consumerCasesFromReport(repo, reportPath, stdout), stdout, stderr };
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

/**
 * The listed identities one Playwright JSON report carries, sorted. Every
 * node in that document is UNTRUSTED input — a runner that reported
 * nothing, or reported a shape this fixture does not know, yields an empty
 * set rather than a plausible-looking guess — and a report the runner
 * never wrote at all leaves nothing to read.
 *
 * The runner reports every file relative to ITS OWN root directory — the
 * config's `testDir`, which is the repository root only for a config that
 * declares none — so each reported file is resolved against that root and
 * then made repo-relative, exactly the identity form the catalog and the
 * sealed execution result speak.
 *
 * @param repo: the repository the listing ran in.
 * @param reportPath: the reporter's own output file.
 * @param fallback: the captured stdout, read only when the reporter wrote
 *   no file of its own.
 *
 * @returns
 *   string[]: `playwright:<project>:<file>:<title>` per listed test.
 */
function consumerCasesFromReport(repo: TempRepo, reportPath: string, fallback: string): readonly string[] {
  let text: string;
  try {
    text = readFileSync(reportPath, 'utf8');
  } catch {
    text = fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  const report = asRecord(parsed);
  if (report === null) return [];
  const config = asRecord(report['config']);
  // A report that names no root directory at all still names files
  // relative to the directory the listing ran in.
  const rootDir = config === null ? repo.root : stringField(config, 'rootDir') || repo.root;
  const cases: string[] = [];
  // The top-level suites are the FILE suites the report merges across
  // projects, so only the suites nested below one carry a describe title.
  const visit = (node: unknown, titlePath: readonly string[]): void => {
    const suite = asRecord(node);
    if (suite === null) return;
    const file = stringField(suite, 'file');
    for (const entry of asList(suite['specs'])) {
      const spec = asRecord(entry);
      if (spec === null) continue;
      const reported = stringField(spec, 'file') || file;
      const specFile = relative(repo.root, isAbsolute(reported) ? reported : resolve(rootDir, reported)).split(sep).join('/');
      const title = stringField(spec, 'title');
      for (const raw of asList(spec['tests'])) {
        const test = asRecord(raw);
        if (test === null) continue;
        cases.push(`playwright:${stringField(test, 'projectName')}:${specFile}:${[...titlePath, title].join('>')}`);
      }
    }
    for (const nested of asList(suite['suites'])) {
      const child = asRecord(nested);
      if (child === null) continue;
      visit(child, [...titlePath, stringField(child, 'title')]);
    }
  };
  for (const suite of asList(report['suites'])) visit(suite, []);
  return cases.sort();
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
 * @param options: the fixture variant; the prototype-name variant adds its
 *   three OWN baseline values here.
 *
 * @returns
 *   Record<string, string>: the environment shared by the run and the check.
 */
export function nativeRunEnv(
  repo: TempRepo,
  extra: Record<string, string> = {},
  options: NativeFixtureOptions = {},
): Record<string, string> {
  const config = loadConfig(repo.path('.gateforge.yml'));
  return {
    GATEFORGE_WITNESS_VERIFIER_KEY: NATIVE_VERIFIER_KEY,
    GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
    SHOP_REGION: 'eu-west',
    SHOP_TIER: 'gold',
    [DELETED_BASELINE_KEY]: 'deprecated',
    ...(options.prototypeEnvironment === true ? prototypeBaselineValues() : {}),
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
  /** A preparation stage that appends a BODY begin before the release exists. */
  queueEarlyBodyBegin?: boolean;
  /** The control document a preparation stage plants before the controller runs. */
  plantedRelease?: 'unsigned' | 'forged' | 'replay';
  /**
   * Absolute path OUTSIDE the repository where a GENUINE signed release is
   * captured and later re-planted byte for byte. It is configured when the
   * repository is installed, so both invocations run the same candidate
   * shape and only ordinary values differ between them; during the first
   * invocation the file simply does not exist yet, so nothing is planted.
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
  /**
   * The generated state mints its session for an OPERATOR revision
   * (`SESSION_REVISION_ENV`) instead of the current commit, so two runs
   * over different commits produce byte-identical state. This is the
   * "preparation restores the parent's own bytes" condition, reached with a
   * genuine session rather than with written bytes.
   */
  stateRevision?: boolean;
  /**
   * A CommonJS-default root package with an ESM spec directory of its own:
   * the root `package.json` declares no module kind, and `specs/` carries
   * `{"type": "module"}`. The native config stays an `.mjs` module, so the
   * engine's generated controller — which lives under the root state
   * directory, and therefore under the root package — has to be interpreted
   * under the root's module rules while every body is not.
   */
  mixedModuleScope?: boolean;
  /**
   * The trusted baseline carries OWN values for `constructor`, `toString`
   * and `__proto__` — the three names a plain object's prototype already
   * carries — and the alpha preparation stage changes the first two for
   * its dependents while leaving `__proto__` alone. This is the uncertain
   * key boundary: an environment projection that only understands
   * ordinary names silently loses real operator values, so every body
   * grades what it really inherited from inside its own worker.
   */
  prototypeEnvironment?: boolean;
  /** The owner opts this repository into the test-only re-seal path. */
  resealEnabled?: boolean;
  /** An operator whole-run session state outranks every declaration. */
  operatorState?: boolean;
  /**
   * The COMMITTED runtime document declares the owner-approved dependency
   * reuse for `node_modules`. A materialized candidate checkout contains
   * TRACKED index bytes only, so an isolated checkout built from this
   * repository would otherwise carry no dependencies at all; the
   * declared reuse is the ONLY sanctioned bridge that hands it the
   * owner's own link. The base commit already carries the declaration
   * and the policy pin is computed after the document exists, so both
   * ownership gates hold by the ordinary install.
   */
  declaredDependencyReuse?: boolean;
  /**
   * The workspace carries a REAL installed dependency closure — ordinary
   * files, no link — instead of the dependency link every other variant
   * uses. A raw candidate ingestion with no reuse-mount support refuses
   * EVERY link, fail closed, so the bytes such a run seals over have to
   * be real files from the start: nothing is ever removed after the seal
   * to make the candidate look unchanged.
   */
  installedDependencies?: boolean;
  /**
   * This repository declares every parseable JavaScript source file
   * (`.js`, `.jsx`, `.mjs`, `.cjs`, at any depth) as a scan input —
   * exactly what `init` writes for a JavaScript project — instead of
   * only its `src` and `specs` directories, and its run-state directory
   * is ordinary untracked workspace bytes rather than a gitignored one.
   *
   * That is the shape of a real consumer project: the template's own
   * `.gitignore` never hid `.gateforge/test-gates/`. It is exactly the
   * shape in which the run's OWN generated files sit inside the configured
   * scan scope of every LATER command. The first real native E2E opts in,
   * so its second run and the strict checks around it exercise that
   * repeat-use of one workspace.
   */
  initLikeScanInputs?: boolean;
  /**
   * The consumer's Playwright config declares NO `testDir` at all, and its
   * WIDE body project (`chromium`) declares neither a `testDir` nor a
   * `testMatch`: the directory it collects from is its config's own
   * directory — the REPOSITORY ROOT — and Playwright's default match
   * selects every spec file there. That is the common repository-level
   * Playwright shape, and it is the shape in which the engine's OWN
   * generated code, wherever the engine happens to write it, becomes one
   * of the consumer's own tests.
   *
   * The four preparation projects are the very same ones every other
   * layout runs — same chains, same `testMatch`, same states — and they
   * declare no browser state at all, because a project's `use` reaches
   * every context it opens and a preparation stage's own state does not
   * exist until that stage has written it. The other generated states are
   * declared by ordinary body projects beside the wide one, which ignores
   * exactly their spec files (see `rootScanningConfig`). This layout's own
   * case identities are derived through {@link consumerCasesFor}.
   *
   * It also leaves the run-state directory OUT of `.gitignore`, like
   * `initLikeScanInputs` does: a config that names no `testDir` makes
   * Playwright honour `.gitignore` by default, so a hidden state directory
   * would take the engine's own files out of the tree this layout exists to
   * exercise.
   */
  rootScanningConfig?: boolean;
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
 * ordinary variable may differ between them. The session revision is the
 * same kind of fixture-carried name, allowlisted for EXACTLY the variant
 * that reads it, so every other variant's runtime document stays the byte
 * it always was.
 *
 * The three prototype names are allowlisted for EXACTLY the variant that
 * declares them, for the same reason: every other variant's runtime
 * document stays the byte it always was.
 *
 * The document's OTHER half is the owner-approved dependency reuse, and
 * it is declared for EXACTLY the variant whose isolated checkout needs
 * one: a checkout is materialized from tracked index bytes, so without
 * the declaration it would carry no dependencies at all. Every other
 * variant keeps the runtime document byte for byte.
 *
 * @param options: the fixture variant.
 *
 * @returns
 *   string: the runtime document source.
 */
function runtimeYml(options: NativeFixtureOptions): string {
  const allow = [
    'SHOP_REGION',
    'SHOP_TIER',
    DELETED_BASELINE_KEY,
    'SHOP_PROTECTED_URL',
    'SHOP_SESSION_SECRET',
    'SHOP_CAPTURED_RELEASE',
    'SHOP_ESCAPING_DIR',
    ...(options.stateRevision === true ? [SESSION_REVISION_ENV] : []),
    ...(options.prototypeEnvironment === true ? [...PROTOTYPE_BASELINE_NAMES] : []),
  ];
  return `schemaVersion: 1
envAllowlist: [${allow.join(', ')}]
${options.declaredDependencyReuse === true ? `prepare:
  reuse: [node_modules]
` : ''}`;
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
  // spec, and the sha256 of that spec's own current bytes. The engine
  // generates that spec into a private per-run directory of its own, so
  // this stage asks the engine's own run record where it went: the
  // synthesized runner config pins the absolute path, and that document
  // is written before any worker process exists. The armed document is
  // emitted as one escaped JSON literal inside a JSON.parse call — the
  // only shape that can carry an own '__proto__' key or a value holding a
  // quote — so the slice is read between the call's open paren and its
  // closing ');' and parsed twice: once to the literal, once to the
  // document.
  const pinned = JSON.parse(readFileSync('${DEFAULT_STATE_DIR}/${TRUSTED_REPORTER_OPTIONS_FILE}', 'utf8'));
  const specPath = String(pinned?.reporterOptions?.controlSpecPath ?? '');
  expect(specPath.length > 0, 'this run pinned a controller spec').toBe(true);
  const specText = readFileSync(specPath, 'utf8');
  const armedAt = specText.indexOf('const ARMED = JSON.parse(');
  const armedEnd = specText.indexOf('\\n', armedAt);
  expect(armedAt >= 0 && armedEnd > armedAt, 'this run armed a freeze controller').toBe(true);
  const armedLiteral = specText.slice(armedAt + 'const ARMED = JSON.parse('.length, armedEnd).trim();
  expect(armedLiteral.endsWith(');'), 'the armed document is one escaped JSON literal').toBe(true);
  const armed = JSON.parse(JSON.parse(armedLiteral.slice(0, -2)));
  // The identities are REAL: a planted document built from an undefined
  // field would carry no identity at all, and the refusal it is meant to
  // provoke would then prove nothing.
  expect(
    ['project', 'runId', 'invocationId', 'nonce', 'specPath'].every(
      (field) => typeof armed[field] === 'string' && armed[field].length > 0,
    ),
    'this run armed a freeze controller with real identities',
  ).toBe(true);
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
 * @param input.revision: mint the session for an operator revision instead
 *   of the commit or the fixed literal.
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
  revision?: boolean;
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
  // freeze inspects the workspace.
  //
  // The bytes it points at are this fixture's own, and they are the REAL
  // session this stage just serialized: every dependent stage can still
  // authenticate against them, so the run really reaches the freeze with
  // a live credential and what the freeze refuses is the containment
  // boundary rather than a broken upstream stage.
  const outside = join(String(process.env.SHOP_ESCAPING_DIR), 'escaping-session.json');
  const serialized = JSON.parse(readFileSync('${input.statePath}', 'utf8'));
  writeFileSync(outside, JSON.stringify({ ...serialized, ownedBy: 'the escaping fixture' }, null, 2) + '\\n');
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
  // A revision-driven stage mints its session for an OPERATOR value, so
  // the very same revision yields byte-identical state on every run: the
  // preparation a second run performs restores what the parent sealed.
  const revision = input.revision === true
    ? `  const revision = String(process.env[${JSON.stringify(SESSION_REVISION_ENV)}]);
  expect(revision, 'the operator named the revision this session is minted for').toMatch(/^[0-9a-z]{1,64}$/);\n`
    : '';
  const sessionPart = input.revision === true ? 'revision' : input.trackCommit === true ? 'commit' : "'value'";
  return `import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@gate-forge/pack-playwright';
${input.retry === true ? '\ntest.describe.configure({ retries: 1 });\n' : ''}
test('${input.title}', async ({ browser }, testInfo) => {
${skip}${requires}${commit}${revision}
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
${input.trackCommit === true ? `  expect(readFileSync(${JSON.stringify(input.statePath)}, 'utf8')).toContain(commit);\n` : ''}${input.revision === true ? `  expect(readFileSync(${JSON.stringify(input.statePath)}, 'utf8')).toContain(revision);\n` : ''}
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
    // An ordinary baseline variable CHANGED, one that did not exist at
    // baseline at all CREATED, and — in the prototype-name variant only —
    // two of the three prototype names CHANGED for this stage's dependents
    // while the third is left exactly as the trusted baseline declared it.
    produces: {
      SHOP_REGION: 'alpha-region',
      [INTRODUCED_KEY]: 'alpha-created',
      ...(options.prototypeEnvironment === true ? { ...PROTOTYPE_ALPHA_VALUES } : {}),
    },
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
    revision: options.stateRevision === true,
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
    revision: options.stateRevision === true,
    // The independent chain's state tracks the commit exactly like the
    // deepest chain's does, so "every commit changes the generated state"
    // is one property of the fixture rather than one of the chains that
    // happen to be read first. Revision mode keeps precedence: a stage
    // that mints for an operator revision embeds the revision, never the
    // commit, whichever of the two the variant selected.
    trackCommit: options.stateTracksCommit === true,
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
  // The state's own storage state is NOT inherited here: Playwright's
  // browser fixture fills the ABSENT options of a new context from the
  // project's combined context options, so a bare newContext() arrives at
  // the route already holding the very session this body proves. An
  // explicit EMPTY state is what makes this caller genuinely anonymous.
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const denied = await (await anonymous.newPage()).goto(String(process.env.SHOP_PROTECTED_URL) + '/session');
  expect(denied?.status(), 'the route refuses an unauthenticated caller').toBe(401);
  await anonymous.close();
  const granted = await page.goto(String(process.env.SHOP_PROTECTED_URL) + '/session');
  expect(granted?.status(), 'the route accepts the generated session').toBe(200);
${rewrite}
});

${claims}`;
}

/**
 * The wide body project's spec: what a repository-level `chromium` project
 * really proves.
 *
 * The per-chain environment assertions belong to the narrow layout's four
 * bodies, where each one inherits exactly one chain's projection. This
 * layout's wide project proves what is true of the whole suite instead: the
 * session it declares is a signed credential the protected route accepts
 * (and refuses to an anonymous caller), both preparation chains really
 * produced their own signed state before it ran, and it carries the
 * layout's three claim-bearing journeys — the very {@link DELTA_CLAIMS}
 * the narrow layout's delta body carries, so the obligations they back stay
 * mapped to a real case in this layout too.
 *
 * @returns
 *   string: the spec source of the wide body project.
 */
function rootScanningBodySpec(): string {
  // The SAME wiring the narrow layout's delta body uses, so the claim
  // journeys below drive the very same evidence fixtures and register the
  // very same UI surface: the pack's own `test` (which carries `evidence`)
  // extended with the shared accounts surface, reached from this
  // directory one level up.
  return `import { readFileSync } from 'node:fs';
import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { accountsSurface } from '../specs/accounts-surface.js';
const test = gateforgeTest.extend({ surface: accountsSurface });

test('${(ROOT_SCAN_BODY.titles[0] as string)}', async ({ browser, context, page }) => {
  // The project context starts from the state this project declared, so the
  // session it proves is a real credential rather than decorative bytes.
  const own = (await context.cookies()).find((cookie) => cookie.name === '${ROOT_SCAN_BODY.cookie}');
  expect(own, 'this body started from the session its own chain saved').toBeDefined();
  expect(own?.value ?? '', 'the generated session is signed').toMatch(/^[0-9a-z]{1,64}\\.[0-9a-f]{64}$/);
  // The protected route is the authority: 401 to a caller with no
  // credential at all, 200 only to the session this run signed. The
  // project's own state is not inherited by a bare newContext() call, so an
  // explicit EMPTY state is what makes that caller genuinely anonymous.
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const denied = await (await anonymous.newPage()).goto(String(process.env.SHOP_PROTECTED_URL) + '/session');
  expect(denied?.status(), 'the route refuses an unauthenticated caller').toBe(401);
  await anonymous.close();
  const granted = await page.goto(String(process.env.SHOP_PROTECTED_URL) + '/session');
  expect(granted?.status(), 'the route accepts the generated session').toBe(200);
});

test('${(ROOT_SCAN_BODY.titles[1] as string)}', async () => {
  // Both chains are dependencies of this project, so both files exist by
  // the time this test runs, and each carries the signed cookie its own
  // stage minted: the ordering this asserts is what really happened, not a
  // claim about it.
  for (const [statePath, cookieName] of [
    ['.auth/gamma.json', 'gamma-session'],
    ['.auth/omega.json', 'omega-session'],
  ]) {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    const cookie = saved.cookies.find((entry) => entry.name === cookieName);
    expect(cookie, statePath + ' carries the ' + cookieName + ' session').toBeDefined();
    expect(cookie?.value ?? '', cookieName + ' is a signed credential').toMatch(/^[0-9a-z]{1,64}\\.[0-9a-f]{64}$/);
  }
});

${DELTA_CLAIMS}`;
}

/**
 * One narrow body spec of the root-scanning layout: the body project that
 * DECLARES a generated state proves it is a signed credential the
 * protected route accepts, and refuses to an anonymous caller.
 *
 * @param body: the body project whose session this spec proves.
 *
 * @returns
 *   string: the spec source of that body project.
 */
function rootScanningStateSpec(body: RootScanBody): string {
  return `import { readFileSync } from 'node:fs';
import { test, expect } from '@gate-forge/pack-playwright';

test('${(body.titles[0] as string)}', async ({ browser, context, page }) => {
  // The project context starts from the state this project DECLARED, so the
  // session it proves is a real credential rather than decorative bytes.
  const own = (await context.cookies()).find((cookie) => cookie.name === '${body.cookie}');
  expect(own, 'this body started from the session its own stage saved').toBeDefined();
  expect(own?.value ?? '', 'the generated session is signed').toMatch(/^[0-9a-z]{1,64}\\.[0-9a-f]{64}$/);
  const saved = JSON.parse(readFileSync('${body.statePath}', 'utf8'));
  expect(
    saved.cookies.some((cookie) => cookie.name === '${body.cookie}'),
    '${body.statePath} really carries the ${body.cookie} session',
  ).toBe(true);
  // The protected route is the authority: 401 to a caller with no credential
  // at all, 200 only to the session this run signed. The project's own state
  // is not inherited by a bare newContext() call, so an explicit EMPTY state
  // is what makes that caller genuinely anonymous.
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const denied = await (await anonymous.newPage()).goto(String(process.env.SHOP_PROTECTED_URL) + '/session');
  expect(denied?.status(), 'the route refuses an unauthenticated caller').toBe(401);
  await anonymous.close();
  const granted = await page.goto(String(process.env.SHOP_PROTECTED_URL) + '/session');
  expect(granted?.status(), 'the route accepts the generated session').toBe(200);
});
`;
}

/**
 * The consumer's Playwright config, in one of two real shapes:
 * {@link narrowSpecConfig} — two uneven-depth preparation chains
 * (`alpha-auth` → `beta-auth` → `gamma-auth`, plus the independent
 * `omega-auth`) and four bodies, one per chain — or
 * {@link rootScanningConfig}, the repository-level shape. In both, every
 * generated state file is declared as some body's `use.storageState`, so
 * the engine's sealed native config nominates all four as generated
 * targets.
 *
 * @param options: the fixture variant (a consumer may claim the engine's
 *   own controller name, which is a conflict the freeze must refuse, and
 *   one layout declares no `testDir` at all).
 *
 * @returns
 *   string: the consumer config source.
 */
function playwrightConfig(options: NativeFixtureOptions): string {
  return options.rootScanningConfig === true ? rootScanningConfig() : narrowSpecConfig(options);
}

/**
 * The narrow layout's config: one `testDir` and one `testMatch` per
 * project, so each project runs exactly the one spec it names.
 *
 * @param options: the fixture variant (a consumer may claim the engine's
 *   own controller name, which is a conflict the freeze must refuse).
 *
 * @returns
 *   string: the consumer config source.
 */
function narrowSpecConfig(options: NativeFixtureOptions): string {
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
 * The root-scanning layout's config: the shape of a real repository-level
 * Playwright setup. The config declares NO `testDir` at all, the four
 * preparation projects name their own file and declare NO browser state,
 * and the WIDE body project (`chromium`) names neither a `testDir` nor a
 * `testMatch` — so Playwright's own default match collects every spec file
 * in the repository, the run state included whenever a run leaves generated
 * code there.
 *
 * The narrow body projects beside it are ordinary consumers: each declares
 * one generated state as its own `use.storageState`, which is what makes
 * that write an admissible generated output (the engine nominates generated
 * targets from declared states alone), and each runs its own spec file. The
 * wide project ignores exactly THOSE files and nothing else — never the
 * state directory, never `.gateforge/**` — so it still collects whatever a
 * run leaves in the repository, and never runs another project's case.
 *
 * @returns
 *   string: the consumer config source.
 */
function rootScanningConfig(): string {
  const declaringBodies = ROOT_SCAN_STATE_BODIES.map(
    (body) =>
      `    { name: '${body.name}', testMatch: '${basename(body.file)}', ` +
      `dependencies: [${body.prerequisites.map((name) => `'${name}'`).join(', ')}], ` +
      `use: { storageState: '${body.statePath}' } },\n`,
  ).join('');
  const ignoredByWideProject = ROOT_SCAN_STATE_BODIES.map((body) => `'${body.file}'`).join(', ');
  const wideEdges = ROOT_SCAN_BODY.prerequisites.map((name) => `'${name}'`).join(', ');
  const wideProject =
    `    { name: '${ROOT_SCAN_BODY_PROJECT}', testIgnore: [${ignoredByWideProject}], ` +
    `dependencies: [${wideEdges}], use: { storageState: '${ROOT_SCAN_BODY.statePath}' } },\n`;
  return `import { defineConfig } from 'playwright/test';

export default defineConfig({
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  projects: [
    { name: 'alpha-auth', testMatch: 'alpha-auth.setup.js' },
    { name: 'beta-auth', testMatch: 'beta-auth.setup.js', dependencies: ['alpha-auth'] },
    { name: 'gamma-auth', testMatch: 'gamma-auth.setup.js', dependencies: ['beta-auth'] },
    { name: 'omega-auth', testMatch: 'omega-auth.setup.js' },
${declaringBodies}${wideProject}
  ],
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
  // A repository at `init`'s defaults declares every parseable source
  // file as a scan input, so the engine's OWN generated files inside the
  // state directory fall inside the scan scope of the NEXT command over
  // the same workspace. That is the consumer shape this variant
  // reproduces; every other variant keeps the narrow `src/**` +
  // `specs/**` scope it always had.
  // The root-scanning layout's wide project runs specs under `tests/`, so
  // that layout's narrow scan scope has to reach them; the two opt-in
  // scopes above and below never change the default one.
  const scanInclude =
    options.initLikeScanInputs === true
      ? "['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs']"
      : options.rootScanningConfig === true
        ? "['src/**', 'specs/**', 'tests/**']"
        : "['src/**', 'specs/**']";
  const gateforgeConfig = `schemaVersion: 1
project:
  languages: [javascript]
  paths: { include: ${scanInclude}, exclude: [] }
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
scan:
  scanRoots: ${scanInclude}
  declarations:
    internality: gateforge:internal
  volatileFields: []
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
  // The prototype-name variant: what every body must REALLY inherit for
  // the three uncertain names. The independent body sees the trusted
  // baseline untouched, the two bodies on alpha's chain see the two names
  // alpha changed plus the baseline's own `__proto__`, and the omega chain
  // changes none of them, so its body sees the baseline for all three.
  const prototypeBaseline = options.prototypeEnvironment === true ? prototypeBaselineValues() : {};
  const prototypeAlphaChain =
    options.prototypeEnvironment === true ? prototypeBaselineValues(PROTOTYPE_ALPHA_VALUES) : {};
  repo.writeFiles({
    '.gateforge.yml': gateforgeConfig,
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/adapters/tenant.accounts.mjs': ADAPTER,
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
    '.gateforge/runtime.yml': runtimeYml(options),
    'src/accounts.js': '// fixture source: the accounts resource lives here.\n',
    'src/orders.js': '// fixture source: the orders resource lives here.\n',
    'specs/accounts-surface.js': readFileSync(join(ROOT, 'example/e2e/accounts-surface.js'), 'utf8'),
    'specs/alpha-auth.setup.js': alphaSpec(options),
    'specs/beta-auth.setup.js': betaSpec(),
    'specs/gamma-auth.setup.js': gammaSpec(),
    'specs/omega-auth.setup.js': omegaSpec(options),
    // The four narrow body projects, each selected by its own `testMatch`
    // — or, in the root-scanning layout, the wide project that collects
    // every spec file in the repository together with the ordinary body
    // projects that declare the states it cannot.
    ...(options.rootScanningConfig === true
      ? Object.fromEntries([
          [ROOT_SCAN_BODY.file, rootScanningBodySpec()],
          ...ROOT_SCAN_STATE_BODIES.map((body) => [body.file, rootScanningStateSpec(body)] as const),
        ])
      : {
          'specs/delta-body.spec.js': bodySpec({
            title: (BODY_PROJECTS_TABLE[0] as ConsumerProject).titles[0] as string,
            ownCookie: ownCookie ?? 'beta-session',
            fileCookie: 'beta-session',
            statePath: '.auth/beta.json',
            // Its OWN chain's values, in the order that chain produced them:
            // beta's region, gamma's tier, and the ticket alpha created two hops
            // up. Ordinary native propagation along a dependency chain is
            // CUMULATIVE, so a value an earlier stage produced is still present
            // when this body starts.
            expectEnv: {
              ...prototypeAlphaChain,
              SHOP_REGION: 'beta-region',
              SHOP_TIER: 'gamma-tier',
              [INTRODUCED_KEY]: 'alpha-created',
            },
            // The one ordinary baseline key that chain revoked, and only that
            // one: a deletion travels the chain exactly as a creation does.
            absentEnv: [DELETED_BASELINE_KEY],
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
              ...prototypeBaseline,
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
            expectEnv: {
              ...prototypeBaseline,
              SHOP_REGION: 'eu-west',
              SHOP_TIER: 'gold',
              [DELETED_BASELINE_KEY]: 'deprecated',
            },
            absentEnv: [INTRODUCED_KEY],
            rewriteState: options.bodyRewritesGeneratedState === true,
          }),
          'specs/eta-body.spec.js': bodySpec({
            title: (BODY_PROJECTS_TABLE[3] as ConsumerProject).titles[0] as string,
            ownCookie: ownCookie ?? 'gamma-session',
            fileCookie: 'gamma-session',
            statePath: '.auth/gamma.json',
            // The tail of the deepest chain inherits that WHOLE chain's
            // environment, not only its immediate prerequisite's: gamma set the
            // tier, beta's region reached this body two hops down, and alpha's
            // ticket three hops down.
            expectEnv: {
              ...prototypeAlphaChain,
              SHOP_TIER: 'gamma-tier',
              SHOP_REGION: 'beta-region',
              [INTRODUCED_KEY]: 'alpha-created',
            },
            // The baseline key that same chain revoked one hop above still does
            // not come back: a deletion travels the chain as a creation does.
            absentEnv: [DELETED_BASELINE_KEY],
          }),
        }),
    'playwright.config.mjs': playwrightConfig(options),
    // The MIXED module scope: with `mixedModuleScope`, the root package
    // declares no module kind at all — so CommonJS is the default for
    // every file under it — while the spec directory carries an ESM
    // package of its own. The native config is an `.mjs` module either
    // way, so the configuration itself is never what changes.
    ...(options.mixedModuleScope === true
      ? {
          'package.json': `${JSON.stringify({ name: 'native-preparation-fixture', private: true }, null, 2)}\n`,
          'specs/package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
        }
      : { 'package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n` }),
    // `.auth/` is gitignored: the preparation stages write their genuine
    // session state there, so it exists as ignored workspace bytes and
    // never in a commit. The run-state directory is gitignored for the
    // same reason in every layout that always had it — except the two
    // opt-in consumer shapes, where a real consumer's `.gitignore` does
    // NOT hide it: the run's own control documents really are then
    // untracked-but-visible workspace bytes of the shape a later command
    // enumerates, and a root-scanning config whose runner honours
    // `.gitignore` really does walk that directory.
    '.gitignore': [
      'node_modules',
      '.auth/',
      ...(options.initLikeScanInputs === true || options.rootScanningConfig === true ? [] : [DEFAULT_STATE_DIR]),
      '',
    ].join('\n'),
  });
  if (options.installedDependencies === true) {
    installConsumerDependencies(repo.root);
  } else {
    symlinkSync(
      process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'),
      join(repo.root, 'node_modules'),
      'dir',
    );
  }
  repo.git(['add', '-A']);
  repo.commit('native preparation fixture');
}

/**
 * The dependency closure a consumer install actually provides, written
 * into the workspace as ordinary files.
 *
 * Two real entry points have to resolve from the workspace itself: the
 * preparation and body specs import `@gate-forge/pack-playwright`, and
 * the in-process detector imports `@gate-forge/http-contract`. Their
 * declared dependencies are installed with them — the runner the engine
 * selects and spawns, the two engine packages the pack loads, and the
 * libraries those declare — so every module those two entry points
 * really load is present, at the versions this repository is built
 * against. It is the closure an install produces (the shape
 * `example-first-run.test.ts` installs), never a launcher stub, and the
 * copy dereferences, so the workspace carries no link anywhere.
 *
 * @param repoRoot: absolute root of the fixture repository.
 *
 * @returns
 *   void.
 */
function installConsumerDependencies(repoRoot: string): void {
  const modules = join(repoRoot, 'node_modules');
  const installed = process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules');
  const engine = join(modules, '@gate-forge');
  mkdirSync(engine, { recursive: true });
  for (const name of ['pack-playwright', 'core', 'witness', 'http-contract']) {
    cpSync(join(ROOT, 'packages', name), join(engine, name), { recursive: true, dereference: true });
  }
  for (const name of [
    'playwright',
    'playwright-core',
    'typescript',
    'yaml',
    'zod',
    'ajv',
    'fast-deep-equal',
    'fast-uri',
    'json-schema-traverse',
    'require-from-string',
  ]) {
    cpSync(join(installed, name), join(modules, name), { recursive: true, dereference: true });
  }
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

/**
 * Rewrites ONE generated state file to a different session revision, the
 * way an untracked workspace edit would: the cookie is the one that state
 * really declares and its value is a MAC this run's protected route
 * accepts, over this run's own secret. A body that reads the rewritten
 * state therefore still proves the session semantics instead of failing
 * over bytes nothing signed, so what a run reports is a decision about the
 * re-seal rather than an accident.
 *
 * @param repo: the repository whose generated state is rewritten.
 * @param statePath: the repo-relative generated state path.
 * @param origin: the attested base URL the session belongs to.
 * @param secret: the per-run MAC secret.
 * @param sessionPart: the revision half of the session credential.
 *
 * @returns
 *   string: the state bytes now on disk.
 */
export function writeGeneratedSessionState(
  repo: TempRepo,
  statePath: string,
  origin: string,
  secret: string,
  sessionPart: string,
): string {
  const cookie = sessionCookieFor(statePath);
  const bytes = `${JSON.stringify(
    {
      cookies: [
        {
          name: cookie,
          value: signedSessionValue(cookie, sessionPart, secret),
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
  )}\n`;
  repo.writeFiles({ [statePath]: bytes });
  return bytes;
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
  /** Parent commit the receipt was sealed against (null when unborn). */
  parentSha?: string | null;
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
 * @param stateDir: the run-state directory the run actually resolved
 *   (`--out`); the configured one when absent.
 *
 * @returns
 *   SealedExecution: the parsed result, or null when the run sealed none.
 */
export function sealedExecution(repo: TempRepo, stateDir?: string): SealedExecution | null {
  const path = join(resolveStateDir(repo.root, stateDir), 'execution-result.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as SealedExecution;
}

/**
 * Reads the sealed gate receipt, or null when the run left none.
 *
 * @param repo: the repository the run sealed into.
 * @param stateDir: the run-state directory the run actually resolved
 *   (`--out`); the configured one when absent.
 *
 * @returns
 *   SealedReceipt | null: the sealed bindings.
 */
export function sealedReceipt(repo: TempRepo, stateDir?: string): SealedReceipt | null {
  const path = join(resolveStateDir(repo.root, stateDir), 'receipt.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as SealedReceipt;
}

/**
 * How many re-seal chain artifacts the run state currently RETAINS.
 *
 * One hop is not one file: a retained hop is a full set of documents
 * (`hop-<n>-records.json`, `-claims.json`, `-attestations.json`,
 * `-receipt.json`, `-execution-result.json`, `-catalog.json`), so this
 * counts every retained artifact of every hop and the number is a property
 * of the chain's SHAPE, never a hop count.
 *
 * Zero means no artifact is retained — whether the chain directory is gone
 * or simply holds nothing — which is what a suite reads after a refused or
 * never-issued re-seal to show that nothing was kept. A chain directory
 * that exists and cannot be read is an error, not an absence: it is never
 * silently converted to zero.
 *
 * @param repo: the repository the chain lives in.
 *
 * @returns
 *   number: the retained artifact count (0 when the chain retains none).
 */
export function retainedResealArtifactCount(repo: TempRepo): number {
  const directory = join(resolveStateDir(repo.root), 'reseal-chain');
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).length;
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
 * @param stateDir: the run-state directory the run actually resolved
 *   (`--out`); the configured one when absent.
 *
 * @returns
 *   string | null: the candidate tree id, or null without a Git directory.
 */
export function candidateTreeIdOf(repo: TempRepo, stateDir?: string): string | null {
  const gitDir = resolveGitDir(repo.root, process.env);
  if (gitDir === null) return null;
  const config = loadConfig(repo.path('.gateforge.yml'));
  return computeCandidateTreeId(
    gitDir,
    repo.root,
    process.env,
    resolveStateDir(repo.root, stateDir),
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

/**
 * The same commit-only candidate change, COMMITTED.
 *
 * A re-seal parent is authenticated against the COMMIT its receipt names:
 * the sealed candidate must cover that commit's tree, so an uncommitted
 * source edit leaves a parent that proves bytes no commit carries and the
 * verification refuses it. A suite that grades a re-seal therefore records
 * the audited comment in the source before the full parent run, and stages
 * ONLY that one file — the generated session state and the run state are
 * git-ignored workspace bytes and can never reach a commit here.
 *
 * @param repo: the fixture repository.
 *
 * @returns
 *   string: the sha of the commit that carries the change.
 */
export function commitCandidateChange(repo: TempRepo): string {
  writeCandidateChange(repo);
  repo.git(['add', '--', 'src/accounts.js']);
  return repo.commit('record the audited comment in the application source');
}