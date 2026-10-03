/**
 * Native per-project auth state (the upstream Playwright pattern:
 * `auth.setup.ts` logs in and saves `playwright/.auth/user.json`, the
 * dependent project declares `use.storageState` on that file).
 *
 * The trusted supervisor never loads the consumer config, so that
 * declaration is the one thing the engine-owned project-graph reporter
 * may carry across as DATA: the RESOLVED `project.use.storageState`
 * string, nothing else. The synthesized config then hands each project
 * its own state, and only that project's — the setup project keeps
 * running unauthenticated, before the dependent project reads the
 * artifact it wrote.
 *
 * Every test here drives a REAL chromium against a REAL loopback HTTP
 * app through the REAL supervised runner: the assertions are about what
 * the browser rendered and which HTTP status the protected route really
 * answered, never about the shape of a config file.
 */
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startWitness } from '../src/witness/server.js';
import { startSupervisorSpoolDrain, type SpoolDrainHandle } from '../src/supervisor/drain.js';
import { spoolPathFor } from '../src/supervisor/spool.js';
import { SupervisorClient } from '../src/supervisor/client.js';
import {
  listNativePlaywrightTests,
  type NativeInstance,
  type NativeListResult,
} from '../src/discovery/reconcile.js';
import { executeSupervisedPlaywright } from '../src/discovery/supervised-run.js';
import {
  resolveProjectStorageState,
  TRUSTED_CONFIG_FILE,
  type ProjectScope,
} from '../src/discovery/trusted-config.js';

const DIRECTORIES: string[] = [];
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RUN_TOKEN = 'project-state-token';
const VERIFIER_KEY = 'project-state-verifier-key';
// Loopback, built rather than typed: the app and the witness bind here only.
const LOOPBACK = [127, 0, 0, 1].join('.');
/** The state file the native auth pattern writes inside the candidate. */
const STATE_FILE = 'playwright/.auth/user.json';
/** A subdirectory project: its config, specs and artifacts live here. */
const PROJECT_DIR = 'frontend';
/** Sessions the app already knows, so a STALE state file is a real login. */
const SEEDED_SESSIONS: Record<string, string> = {
  'stale-token': 'Stale Session',
  'operator-token': 'Operator Session',
};

afterEach(() => {
  for (const dir of DIRECTORIES.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gateforge-projectstate-${label}-`));
  DIRECTORIES.push(dir);
  // Specs import 'playwright/test'; link the monorepo modules as the other
  // e2e harnesses do.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return jar;
}

/** One loopback app with a real session cookie and a real protected route. */
async function startProtectedApp(): Promise<{
  url: string;
  stop: () => Promise<void>;
  hit: (path: string, cookie?: string) => Promise<{ status: number; body: string }>;
}> {
  const sessions = new Map<string, string>(Object.entries(SEEDED_SESSIONS));
  let minted = 0;
  const send = (res: ServerResponse, status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  const page = (who: string): string =>
    `<!doctype html><html><body><h1 id="who">${who}</h1></body></html>`;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    const name = sessions.get(parseCookies(req.headers.cookie)['session'] ?? '') ?? null;
    if (url.pathname === '/') {
      send(res, 200, page(name === null ? 'Signed out' : `Signed in as ${name}`));
      return;
    }
    if (url.pathname === '/login') {
      if (req.method !== 'POST') {
        send(
          res,
          200,
          '<!doctype html><html><body><form method="post" action="/login">' +
            '<input id="name" name="name"/><button type="submit">Sign in</button></form></body></html>',
        );
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const who = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('name') ?? '';
        const token = `token-${String(++minted)}`;
        sessions.set(token, who);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `session=${token}; Path=/` });
        res.end(page(`Signed in as ${who}`));
      });
      return;
    }
    if (url.pathname === '/protected') {
      // The protected route really is protected: no session, no content.
      if (name === null) {
        send(res, 401, '<!doctype html><html><body><h1 id="protected">Sign in required</h1></body></html>');
        return;
      }
      send(
        res,
        200,
        `<!doctype html><html><body><h1 id="protected">Protected area</h1><p id="who">${name}</p></body></html>`,
      );
      return;
    }
    send(res, 404, '<!doctype html><html><body><h1 id="who">Not found</h1></body></html>');
  });
  await new Promise<void>((resolveListen) => server.listen(0, LOOPBACK, resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('loopback app did not bind a port');
  const url = `http://${LOOPBACK}:${String(address.port)}`;
  const hit = (path: string, cookie?: string): Promise<{ status: number; body: string }> =>
    new Promise((settle, fail) => {
      const call = httpRequest(`${url}${path}`, { headers: cookie === undefined ? {} : { cookie } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => settle({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      call.once('error', fail);
      call.end();
    });
  return { url, stop: () => new Promise<void>((closed) => server.close(() => closed())), hit };
}

/** Writes a storage-state document holding one session cookie. */
function storageStateDocument(token: string): string {
  return `${JSON.stringify({
    cookies: [
      {
        name: 'session',
        value: token,
        domain: LOOPBACK,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  })}\n`;
}

/**
 * Writes the native auth layout: an unauthenticated `setup` project that
 * signs in and saves the state file, plus the dependent project that
 * declares the state it reads.
 *
 * Every path the suite itself writes or declares stays RELATIVE, which
 * is the contract under test: where the config lives decides where those
 * paths land. `options.dir` places the config and the specs in a
 * subdirectory project — the self-contained layout enumeration supports
 * too — and leaves the repo root to a config that lives at the root.
 *
 * @param cwd: the consumer repo root.
 * @param declared: the value the dependent project's `use.storageState` holds.
 * @param expects: the identity the dependent spec asserts it renders.
 * @param options: `dir` (project directory; default the repo root) and
 *   `secondSpecTitle` (a second spec test, for named-selection cases).
 */
function writeAuthProject(
  cwd: string,
  declared: string,
  expects: string,
  options: { dir?: string; secondSpecTitle?: string } = {},
): void {
  const projectDir = join(cwd, options.dir ?? '');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'playwright.config.mjs'),
    [
      `export default {`,
      `  testDir: './tests',`,
      `  projects: [`,
      `    { name: 'setup', testMatch: /.*\\.setup\\.ts/ },`,
      `    { name: 'chromium', dependencies: ['setup'], use: { storageState: ${JSON.stringify(declared)} } },`,
      `  ],`,
      `};`,
      '',
    ].join('\n'),
  );
  mkdirSync(join(projectDir, 'tests'), { recursive: true });
  writeFileSync(
    join(projectDir, 'tests', 'auth.setup.ts'),
    [
      `import { mkdirSync } from 'node:fs';`,
      `import { expect, test as setup } from 'playwright/test';`,
      ``,
      `setup('signs in and saves the storage state', async ({ page }) => {`,
      `  // The setup project must start logged out: a state file left behind`,
      `  // by an earlier run may not authenticate it.`,
      `  await page.goto('/');`,
      `  expect((await page.locator('#who').textContent())?.trim()).toBe('Signed out');`,
      `  await page.goto('/login');`,
      `  await page.locator('#name').fill('Ada');`,
      `  await page.locator('button[type=submit]').click();`,
      `  expect((await page.locator('#who').textContent())?.trim()).toBe('Signed in as Ada');`,
      `  mkdirSync('playwright/.auth', { recursive: true });`,
      `  await page.context().storageState({ path: ${JSON.stringify(STATE_FILE)} });`,
      `});`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectDir, 'tests', 'protected.spec.ts'),
    [
      `import { expect, test } from 'playwright/test';`,
      ``,
      `test('renders the protected page', async ({ page }) => {`,
      `  const response = await page.goto('/protected');`,
      `  expect(response?.status()).toBe(200);`,
      `  expect((await page.locator('#protected').textContent())?.trim()).toBe('Protected area');`,
      `  expect((await page.locator('#who').textContent())?.trim()).toBe(${JSON.stringify(expects)});`,
      `});`,
      ...(options.secondSpecTitle === undefined
        ? []
        : [
            '',
            `test(${JSON.stringify(options.secondSpecTitle)}, async ({ page }) => {`,
            `  const response = await page.goto('/protected');`,
            `  expect(response?.status()).toBe(200);`,
            `  expect((await page.locator('#protected').textContent())?.trim()).toBe('Protected area');`,
            `});`,
          ]),
      '',
    ].join('\n'),
  );
}

/**
 * Writes a single-project layout whose only project declares a state.
 *
 * @param cwd: the consumer repo root.
 * @param declared: the value the project's `use.storageState` holds.
 * @param expects: the identity the spec asserts it renders.
 * @param project: the project name (a candidate string, so one case
 *   deliberately uses a name that is a JavaScript prototype key).
 * @param options: `dir` (project directory; default the repo root).
 */
function writeSingleProject(
  cwd: string,
  declared: string,
  expects: string,
  project = 'chromium',
  options: { dir?: string } = {},
): void {
  const projectDir = join(cwd, options.dir ?? '');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'playwright.config.mjs'),
    [
      `export default {`,
      `  testDir: './tests',`,
      `  projects: [`,
      `    { name: ${JSON.stringify(project)}, use: { storageState: ${JSON.stringify(declared)} } },`,
      `  ],`,
      `};`,
      '',
    ].join('\n'),
  );
  mkdirSync(join(projectDir, 'tests'), { recursive: true });
  writeFileSync(
    join(projectDir, 'tests', 'protected.spec.ts'),
    [
      `import { expect, test } from 'playwright/test';`,
      ``,
      `test('renders the protected page', async ({ page }) => {`,
      `  const response = await page.goto('/protected');`,
      `  expect(response?.status()).toBe(200);`,
      `  expect((await page.locator('#protected').textContent())?.trim()).toBe('Protected area');`,
      `  expect((await page.locator('#who').textContent())?.trim()).toBe(${JSON.stringify(expects)});`,
      `});`,
      '',
    ].join('\n'),
  );
}

/** Projects the plan would own, carrying the graph the runner resolved. */
function scopesFor(enumeration: NativeListResult): ProjectScope[] {
  return [...new Set(enumeration.instances.map((instance) => instance.project))]
    .filter((name) => name.length > 0)
    .map((name) => ({
      name,
      files: [
        ...new Set(enumeration.instances.filter((instance) => instance.project === name).map((i) => i.file)),
      ].sort(),
      dependencies: [...(enumeration.projectDependencies?.[name] ?? [])].sort(),
      ...(enumeration.projectStorageStates?.[name] === undefined
        ? {}
        : { storageState: enumeration.projectStorageStates[name] as string }),
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Registers exactly the enumerated instances this run will execute (a
 * named run registers the NAMED tests) and starts the spool drain that
 * backs the run. The supervisor client comes back too: the witness's
 * execution trace is where expected-set ADMISSION is observable — a
 * run whose identities the registration never bound opens no sessions,
 * which no outcome row and no empty conflict list would show.
 */
async function registerAndDrain(input: {
  stateDir: string;
  runId: string;
  witnessUrl: string;
  instances: readonly NativeInstance[];
}): Promise<{ drain: SpoolDrainHandle; supervisor: SupervisorClient }> {
  const supervisor = new SupervisorClient(input.witnessUrl, RUN_TOKEN, VERIFIER_KEY);
  await supervisor.registerExpectedSet({
    tests: input.instances.map((instance) => ({
      testId: instance.frameworkId,
      project: instance.project.length > 0 ? instance.project : null,
      file: instance.file,
      titlePath: instance.titlePath,
    })),
  });
  const drain = startSupervisorSpoolDrain({
    stateDir: input.stateDir,
    runId: input.runId,
    witnessUrl: input.witnessUrl,
    runToken: RUN_TOKEN,
    verifierKey: VERIFIER_KEY,
  });
  return { drain, supervisor };
}

/**
 * One line per registered identity the witness admitted, with the
 * sessions it minted for it: `<project>|<repo-relative file>|<title
 * path>|<sessions>`.
 */
async function admittedIdentities(supervisor: SupervisorClient): Promise<string[]> {
  const trace = await supervisor.executionTrace();
  return (trace?.tests ?? [])
    .map(
      (test) =>
        `${test.project ?? ''}|${test.file}|${test.titlePath.join('>')}|${String(test.sessions.length)}`,
    )
    .sort();
}

describe('a native per-project storage state reaches the project that declared it', () => {
  it('runs the setup project logged out and lets the dependent project render the protected page', async () => {
    const cwd = tempDir('native');
    const stateDir = tempDir('native-state');
    writeAuthProject(cwd, STATE_FILE, 'Ada');
    // A state file from an EARLIER run already sits in the candidate: a
    // session the app accepts. The setup project declares no state, so it
    // must still start logged out — and the dependent project must read
    // the state this run's setup wrote, not this leftover.
    mkdirSync(join(cwd, 'playwright', '.auth'), { recursive: true });
    writeFileSync(join(cwd, STATE_FILE), storageStateDocument('stale-token'), 'utf8');

    const app = await startProtectedApp();
    // The protected route is genuinely protected, checked over plain HTTP
    // with no browser involved at all.
    expect((await app.hit('/protected')).status).toBe(401);
    expect((await app.hit('/protected', 'session=stale-token')).status).toBe(200);

    const enumeration = await listNativePlaywrightTests({ cwd });
    expect(enumeration.instances.length).toBe(2);

    const projectScopes = scopesFor(enumeration);
    const runId = 'project-state-run';
    const witness = await startWitness({ runId, token: RUN_TOKEN, verifierKey: VERIFIER_KEY, host: LOOPBACK });
    const supervisor = new SupervisorClient(witness.url, RUN_TOKEN, VERIFIER_KEY);
    await supervisor.registerExpectedSet({
      tests: enumeration.instances.map((instance) => ({
        testId: instance.frameworkId,
        project: instance.project.length > 0 ? instance.project : null,
        file: instance.file,
        titlePath: instance.titlePath,
      })),
    });
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: witness.url,
      runToken: RUN_TOKEN,
      verifierKey: VERIFIER_KEY,
    });
    try {
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: [] },
        { stateDir, runId, vars: {} },
        {
          cwd,
          timeoutMs: 180_000,
          appBaseUrl: app.url,
          testFiles: enumeration.instances.map((instance) => instance.file),
          projects: projectScopes.map((scope) => scope.name),
          projectScopes,
        },
      );
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      expect(envelope.complete).toBe(true);
      // Both tests really ran, and the dependent one really rendered the
      // protected page as the identity THIS run's setup signed in as.
      expect(envelope.outcomes.map((outcome) => [outcome.project, outcome.status])).toEqual([
        ['setup', 'passed'],
        ['chromium', 'passed'],
      ]);
      const events = readFileSync(spoolPathFor(stateDir, runId), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; project: string | null });
      expect(events.filter((event) => event.kind === 'testBegin').map((event) => event.project)).toEqual([
        'setup',
        'chromium',
      ]);
      // The file the setup wrote is a real session: the very same cookie
      // authenticates the protected route over independent HTTP.
      const written = JSON.parse(readFileSync(join(cwd, STATE_FILE), 'utf8')) as {
        cookies: { name: string; value: string }[];
      };
      const session = written.cookies.find((cookie) => cookie.name === 'session');
      const authenticated = await app.hit('/protected', `session=${session?.value ?? ''}`);
      expect(authenticated.status).toBe(200);
      expect(authenticated.body).toContain('Ada');
      expect(authenticated.body).not.toContain('Stale Session');
    } finally {
      await witness.stop();
      await app.stop();
    }
  }, 240_000);

  it('refuses a declared state that is empty, a URL, or reaches outside the candidate', async () => {
    const outside = tempDir('outside');
    writeFileSync(join(outside, 'user.json'), storageStateDocument('stale-token'), 'utf8');
    const cases = [
      { declared: '../../outside/user.json', because: 'outside the candidate root' },
      { declared: 'https://example.test/user.json', because: 'is a URL' },
      // An empty declaration asked for no state at all: it must be
      // REFUSED, never quietly read as "this project declares nothing".
      { declared: '', because: 'is empty' },
      {
        // Lexically inside the candidate, physically outside it.
        declared: 'linked/user.json',
        because: 'through a link',
        arrange: (cwd: string): void => {
          symlinkSync(outside, join(cwd, 'linked'), 'dir');
        },
      },
      {
        // A link that leads nowhere must be found and refused, not
        // stepped over as if it were absent.
        declared: 'dangling/user.json',
        because: 'is a link this host cannot resolve',
        arrange: (cwd: string): void => {
          symlinkSync(join(cwd, 'never-created'), join(cwd, 'dangling'), 'dir');
        },
      },
    ];
    for (const { declared, because, arrange } of cases) {
      const cwd = tempDir('refuse');
      const stateDir = tempDir('refuse-state');
      writeAuthProject(cwd, declared, 'Ada');
      arrange?.(cwd);
      const enumeration = await listNativePlaywrightTests({ cwd });
      let refused: Error | null = null;
      try {
        await executeSupervisedPlaywright(
          { logicalKeys: [] },
          { stateDir, runId: 'refuse-run', vars: {} },
          {
            cwd,
            timeoutMs: 60_000,
            testFiles: enumeration.instances.map((instance) => instance.file),
            projects: ['chromium', 'setup'],
            projectScopes: scopesFor(enumeration),
          },
        );
      } catch (error) {
        refused = error as Error;
      }
      // The operator is told which project, which value and why, before
      // anything runs.
      expect(refused?.message).toContain("project 'chromium'");
      expect(refused?.message).toContain(because);
      if (declared.length > 0) expect(refused?.message).toContain(declared);
      // Nothing ran: the refusal happens before the config is written, so
      // a silently-dropped state can never degrade into a logged-out run.
      expect(existsSync(join(stateDir, TRUSTED_CONFIG_FILE))).toBe(false);
    }
  }, 240_000);

  it('keeps the operator whole-run state ahead of a project-declared one it never reads', async () => {
    const cwd = tempDir('operator');
    const stateDir = tempDir('operator-state');
    // The project declares a state that could NOT be honored — it points
    // outside the candidate. The operator's whole-run state outranks it,
    // so that declaration is never read, never checked, and never
    // embedded; the run proceeds on the operator's session alone.
    writeSingleProject(cwd, '../../outside/user.json', 'Operator Session');
    writeFileSync(join(cwd, 'operator-state.json'), storageStateDocument('operator-token'), 'utf8');

    const app = await startProtectedApp();
    const enumeration = await listNativePlaywrightTests({ cwd });
    const projectScopes = scopesFor(enumeration);
    const runId = 'operator-override-run';
    const witness = await startWitness({ runId, token: RUN_TOKEN, verifierKey: VERIFIER_KEY, host: LOOPBACK });
    const supervisor = new SupervisorClient(witness.url, RUN_TOKEN, VERIFIER_KEY);
    await supervisor.registerExpectedSet({
      tests: enumeration.instances.map((instance) => ({
        testId: instance.frameworkId,
        project: instance.project.length > 0 ? instance.project : null,
        file: instance.file,
        titlePath: instance.titlePath,
      })),
    });
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: witness.url,
      runToken: RUN_TOKEN,
      verifierKey: VERIFIER_KEY,
    });
    try {
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: [] },
        { stateDir, runId, vars: {} },
        {
          cwd,
          timeoutMs: 180_000,
          appBaseUrl: app.url,
          // The operator's whole-run state, exactly as GATEFORGE_SESSION_STATE
          // has always been honored.
          storageState: 'operator-state.json',
          testFiles: enumeration.instances.map((instance) => instance.file),
          projects: projectScopes.map((scope) => scope.name),
          projectScopes,
        },
      );
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      // The browser rendered the OPERATOR's identity. Were the declared
      // state used instead, this test could not even reach the runner.
      expect(envelope.outcomes.map((outcome) => [outcome.project, outcome.status])).toEqual([
        ['chromium', 'passed'],
      ]);
    } finally {
      await witness.stop();
      await app.stop();
    }
  }, 240_000);

  it('keeps a lone project scope state, under a project name that is a prototype key', async () => {
    const cwd = tempDir('single');
    const stateDir = tempDir('single-state');
    // `__proto__` is a legal project name and candidate data, so every
    // dictionary keyed by a project name must carry it as an ordinary
    // entry rather than lose it to a prototype.
    writeSingleProject(cwd, STATE_FILE, 'Stale Session', '__proto__');
    mkdirSync(join(cwd, 'playwright', '.auth'), { recursive: true });
    writeFileSync(join(cwd, STATE_FILE), storageStateDocument('stale-token'), 'utf8');

    const app = await startProtectedApp();
    const enumeration = await listNativePlaywrightTests({ cwd });
    const projectScopes = scopesFor(enumeration);
    const runId = 'single-scope-run';
    const witness = await startWitness({ runId, token: RUN_TOKEN, verifierKey: VERIFIER_KEY, host: LOOPBACK });
    const supervisor = new SupervisorClient(witness.url, RUN_TOKEN, VERIFIER_KEY);
    await supervisor.registerExpectedSet({
      tests: enumeration.instances.map((instance) => ({
        testId: instance.frameworkId,
        project: instance.project.length > 0 ? instance.project : null,
        file: instance.file,
        titlePath: instance.titlePath,
      })),
    });
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: witness.url,
      runToken: RUN_TOKEN,
      verifierKey: VERIFIER_KEY,
    });
    try {
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: [] },
        { stateDir, runId, vars: {} },
        {
          cwd,
          timeoutMs: 180_000,
          appBaseUrl: app.url,
          testFiles: enumeration.instances.map((instance) => instance.file),
          projects: projectScopes.map((scope) => scope.name),
          projectScopes,
        },
      );
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      // ONE project owns every selected file: the scoped config is not
      // emitted there, and the declared state must survive that path —
      // under a name a plain object would have swallowed.
      expect(envelope.outcomes.map((outcome) => [outcome.project, outcome.status])).toEqual([
        ['__proto__', 'passed'],
      ]);
    } finally {
      await witness.stop();
      await app.stop();
    }
  }, 240_000);
});

/**
 * A project whose config lives ONE directory down is enumerated from
 * that directory, so the supervised child must run there too: the
 * paths the suite itself writes and declares are relative, and they
 * must land exactly where they land when the owner runs the suite from
 * the project directory. The candidate root stays the identity root —
 * repo-relative files, repo-relative keys, pinned root testDir.
 */
describe('a nested native project runs from its own config directory', () => {
  it('writes the setup artifact inside the project and reads it back authenticated', async () => {
    const cwd = tempDir('nested');
    const stateDir = tempDir('nested-state');
    writeAuthProject(cwd, STATE_FILE, 'Ada', { dir: PROJECT_DIR });
    // The candidate root already holds a REAL session for a stale token.
    // An artifact written at the root instead of inside the project
    // would overwrite exactly this file — the observable defect.
    mkdirSync(join(cwd, 'playwright', '.auth'), { recursive: true });
    writeFileSync(join(cwd, STATE_FILE), storageStateDocument('stale-token'), 'utf8');

    const app = await startProtectedApp();
    expect((await app.hit('/protected')).status).toBe(401);

    const enumeration = await listNativePlaywrightTests({ cwd });
    // The nested layout moves WHERE the suite runs, never the identities
    // the catalog, the expected set and the receipt speak: both files
    // stay repo-relative.
    expect([...enumeration.instances.map((instance) => instance.file)].sort()).toEqual([
      `${PROJECT_DIR}/tests/auth.setup.ts`,
      `${PROJECT_DIR}/tests/protected.spec.ts`,
    ]);

    const projectScopes = scopesFor(enumeration);
    const runId = 'nested-project-state-run';
    const witness = await startWitness({ runId, token: RUN_TOKEN, verifierKey: VERIFIER_KEY, host: LOOPBACK });
    const { drain, supervisor } = await registerAndDrain({
      stateDir,
      runId,
      witnessUrl: witness.url,
      instances: enumeration.instances,
    });
    try {
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: [] },
        { stateDir, runId, vars: {} },
        {
          cwd,
          timeoutMs: 180_000,
          appBaseUrl: app.url,
          testFiles: enumeration.instances.map((instance) => instance.file),
          projects: projectScopes.map((scope) => scope.name),
          projectScopes,
        },
      );
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      expect(envelope.outcomes.map((outcome) => [outcome.project, outcome.status])).toEqual([
        ['setup', 'passed'],
        ['chromium', 'passed'],
      ]);
      // Every executed test was ADMITTED by the registration: the
      // witness minted a session for each repo-relative identity. A run
      // whose identities were reported relative to the wrong root opens
      // NO session — and a refused open is not a conflict, so the trace
      // is the only place that shows it.
      expect(await admittedIdentities(supervisor)).toEqual([
        `chromium|${PROJECT_DIR}/tests/protected.spec.ts|renders the protected page|1`,
        `setup|${PROJECT_DIR}/tests/auth.setup.ts|signs in and saves the storage state|1`,
      ]);
      // The setup project's relative write landed INSIDE the project,
      // and the dependent project authenticated with that very file.
      const written = JSON.parse(readFileSync(join(cwd, PROJECT_DIR, STATE_FILE), 'utf8')) as {
        cookies: { name: string; value: string }[];
      };
      const session = written.cookies.find((cookie) => cookie.name === 'session');
      const authenticated = await app.hit('/protected', `session=${session?.value ?? ''}`);
      expect(authenticated.status).toBe(200);
      expect(authenticated.body).toContain('Ada');
      // Nothing was written at the repo root: the directory the suite
      // does not run in kept the exact state it started with.
      const rootState = JSON.parse(readFileSync(join(cwd, STATE_FILE), 'utf8')) as {
        cookies: { name: string; value: string }[];
      };
      expect(rootState.cookies.find((cookie) => cookie.name === 'session')?.value).toBe('stale-token');
    } finally {
      await witness.stop();
      await app.stop();
    }
  }, 240_000);

  it('runs exactly the named file:line after the child moved to the config directory', async () => {
    const cwd = tempDir('nested-named');
    const stateDir = tempDir('nested-named-state');
    const secondTitle = 'renders the protected page on a second visit';
    writeAuthProject(cwd, STATE_FILE, 'Ada', { dir: PROJECT_DIR, secondSpecTitle: secondTitle });

    const app = await startProtectedApp();
    const enumeration = await listNativePlaywrightTests({ cwd });
    const setup = enumeration.instances.find((instance) => instance.project === 'setup');
    const named = enumeration.instances.find((instance) => instance.title === 'renders the protected page');
    if (setup === undefined || named === undefined) throw new Error('enumeration shape changed');
    // The run names BOTH the setup test (the dependent project needs the
    // artifact it writes) and one line of the spec; the spec's second
    // test was never named.
    const testLocations = [
      `${setup.location.file}:${String(setup.location.line)}`,
      `${named.location.file}:${String(named.location.line)}`,
    ];

    const projectScopes = scopesFor(enumeration);
    const runId = 'nested-named-run';
    const witness = await startWitness({ runId, token: RUN_TOKEN, verifierKey: VERIFIER_KEY, host: LOOPBACK });
    const { drain, supervisor } = await registerAndDrain({
      stateDir,
      runId,
      witnessUrl: witness.url,
      instances: [setup, named],
    });
    try {
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: [] },
        { stateDir, runId, vars: {} },
        {
          cwd,
          timeoutMs: 180_000,
          appBaseUrl: app.url,
          testFiles: enumeration.instances.map((instance) => instance.file),
          testLocations,
          projects: projectScopes.map((scope) => scope.name),
          projectScopes,
        },
      );
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      // Exactly the named tests ran, in the named files, in dependency
      // order — and the named spec test really rendered the protected
      // page as the identity this run's setup signed in as.
      expect(
        envelope.outcomes.map((outcome) => [outcome.project, outcome.logicalKey, outcome.status]),
      ).toEqual([
        ['setup', `${setup.location.file}#signs in and saves the storage state`, 'passed'],
        ['chromium', `${named.location.file}#renders the protected page`, 'passed'],
      ]);
      // Both named tests were admitted under their repo-relative
      // identities and hold a session each — the named selection is not
      // only executed, it is bound.
      expect(await admittedIdentities(supervisor)).toEqual([
        `chromium|${PROJECT_DIR}/tests/protected.spec.ts|renders the protected page|1`,
        `setup|${PROJECT_DIR}/tests/auth.setup.ts|signs in and saves the storage state|1`,
      ]);
    } finally {
      await witness.stop();
      await app.stop();
    }
  }, 240_000);

  it('keeps a relative operator whole-run state anchored at the candidate root', async () => {
    const cwd = tempDir('nested-operator');
    const stateDir = tempDir('nested-operator-state');
    // The project declares a state that could NOT be honored; the
    // operator's own relative path is anchored at the CANDIDATE ROOT,
    // not at the directory the native child runs from.
    writeSingleProject(cwd, '../../outside/user.json', 'Operator Session', 'chromium', { dir: PROJECT_DIR });
    writeFileSync(join(cwd, 'operator-state.json'), storageStateDocument('operator-token'), 'utf8');

    const app = await startProtectedApp();
    const enumeration = await listNativePlaywrightTests({ cwd });
    const projectScopes = scopesFor(enumeration);
    const runId = 'nested-operator-run';
    const witness = await startWitness({ runId, token: RUN_TOKEN, verifierKey: VERIFIER_KEY, host: LOOPBACK });
    const { drain, supervisor } = await registerAndDrain({
      stateDir,
      runId,
      witnessUrl: witness.url,
      instances: enumeration.instances,
    });
    try {
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: [] },
        { stateDir, runId, vars: {} },
        {
          cwd,
          timeoutMs: 180_000,
          appBaseUrl: app.url,
          // The operator's whole-run state, exactly as
          // GATEFORGE_SESSION_STATE has always been honored: a relative
          // path still means the candidate root.
          storageState: 'operator-state.json',
          testFiles: enumeration.instances.map((instance) => instance.file),
          projects: projectScopes.map((scope) => scope.name),
          projectScopes,
        },
      );
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      // The browser rendered the OPERATOR's identity — the spec asserts
      // it, so a pass here is the state file really having been read.
      expect(envelope.outcomes.map((outcome) => [outcome.project, outcome.status])).toEqual([
        ['chromium', 'passed'],
      ]);
      // Admitted under its repo-relative identity, session minted: the
      // operator's whole-run state authenticated a test the expected
      // set actually bound.
      expect(await admittedIdentities(supervisor)).toEqual([
        `chromium|${PROJECT_DIR}/tests/protected.spec.ts|renders the protected page|1`,
      ]);
    } finally {
      await witness.stop();
      await app.stop();
    }
  }, 240_000);
});

describe('a declared browser state resolves from the native config directory', () => {
  it('resolves a nested declaration against that directory, bounded by the candidate root', () => {
    const cwd = tempDir('resolve');
    const configDir = join(cwd, PROJECT_DIR);
    mkdirSync(configDir, { recursive: true });
    expect(resolveProjectStorageState(STATE_FILE, cwd, 'chromium', configDir)).toBe(join(configDir, STATE_FILE));
    // A `../shared` state that lands back INSIDE the candidate stays
    // valid: the boundary is the candidate, not the config directory.
    expect(resolveProjectStorageState('../shared/user.json', cwd, 'chromium', configDir)).toBe(
      join(cwd, 'shared', 'user.json'),
    );
  });

  it('still refuses an empty, URL, lexical and physical escape declared by a nested config', () => {
    const outside = tempDir('resolve-outside');
    const cwd = tempDir('resolve-refuse');
    const configDir = join(cwd, PROJECT_DIR);
    mkdirSync(configDir, { recursive: true });
    // Lexically inside the candidate, physically outside it.
    symlinkSync(outside, join(configDir, 'linked'), 'dir');
    const cases = [
      { declared: '', because: 'is empty' },
      { declared: 'https://example.test/user.json', because: 'is a URL' },
      { declared: '../../outside/user.json', because: 'resolves outside the candidate root' },
      { declared: 'linked/user.json', because: 'through a link' },
    ];
    for (const { declared, because } of cases) {
      expect(() => resolveProjectStorageState(declared, cwd, 'chromium', configDir)).toThrow(because);
    }
  });
});
