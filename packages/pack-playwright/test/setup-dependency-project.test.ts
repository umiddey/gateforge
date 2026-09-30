/**
 * Setup dependency projects (the standard Playwright auth pattern).
 *
 * A consumer config that declares `{ name: 'setup', testMatch: /.*\.setup\.ts/ }`
 * plus a dependent project with `dependencies: ['setup']` is correct,
 * documented Playwright. Two product facts must hold for such a run:
 *
 * 1. every test the supervised runner executes opens a witness session, so it
 *    can produce evidence; and
 * 2. the progress counter's total counts what will actually run, so the
 *    executed count never exceeds it.
 *
 * The trusted config carries project names as identity data. A project-scoped
 * `testMatch` is per-project CONFIGURATION, which trusted synthesis does not
 * honor, so each spec file is collected under every named project. The
 * registration, meanwhile, comes from `playwright --list` over the consumer's
 * own config, which scopes `setup` to `*.setup.ts`. The two inventories then
 * disagree and the extra executions are refused.
 *
 * These tests drive a real `playwright test` child through the real witness
 * and register the expected set exactly as the CLI registers it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startWitness } from '../src/witness/server.js';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import { spoolPathFor } from '../src/supervisor/spool.js';
import { SupervisorClient } from '../src/supervisor/client.js';
import { listNativePlaywrightTests } from '../src/discovery/reconcile.js';
import { executeSupervisedPlaywright } from '../src/discovery/supervised-run.js';
import type { ProjectScope } from '../src/discovery/trusted-config.js';

const DIRECTORIES: string[] = [];
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RUN_TOKEN = 'suite-token';
const VERIFIER_KEY = 'setup-dependency-verifier-key';
// Loopback, built rather than typed: the witness binds here only.
const LOOPBACK = [127, 0, 0, 1].join('.');

afterEach(() => {
  for (const dir of DIRECTORIES.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gateforge-setupdep-${label}-`));
  DIRECTORIES.push(dir);
  // Specs import 'playwright/test'; link the monorepo modules as the other
  // e2e harnesses do.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/**
 * Writes the standard setup-dependency layout: a consumer config whose `setup`
 * project testMatches only `*.setup.ts`, and a `chromium` project that depends
 * on it.
 *
 * @param cwd: the consumer repo root.
 */
function writeSetupDependencyProject(cwd: string): void {
  writeFileSync(
    join(cwd, 'playwright.config.mjs'),
    [
      `export default {`,
      `  testDir: './tests',`,
      `  projects: [`,
      `    { name: 'setup', testMatch: /.*\\.setup\\.ts/ },`,
      `    { name: 'chromium', dependencies: ['setup'] },`,
      `  ],`,
      `};`,
      '',
    ].join('\n'),
  );
  mkdirSync(join(cwd, 'tests'), { recursive: true });
  writeFileSync(
    join(cwd, 'tests', 'auth.setup.ts'),
    [`import { test as setup } from 'playwright/test';`, `setup('authenticate', async () => {});`, ''].join('\n'),
  );
  writeFileSync(
    join(cwd, 'tests', 'feature.spec.ts'),
    [`import { test } from 'playwright/test';`, `test('feature works', async () => {});`, ''].join('\n'),
  );
}

/**
 * Writes the same layout with a setup that PRODUCES an artifact after a
 * delay and a dependent test that reads it — the standard auth pattern
 * (a `setup` project writes `user.json`, the dependent project loads it
 * as `storageState`). The artifact is the only witness of ordering: run
 * without the dependency edge and the dependent test reads a file that
 * does not exist yet.
 *
 * @param cwd: the consumer repo root.
 */
function writeDelayedSetupDependencyProject(cwd: string): void {
  writeFileSync(
    join(cwd, 'playwright.config.mjs'),
    [
      `export default {`,
      `  testDir: './tests',`,
      `  projects: [`,
      `    { name: 'setup', testMatch: /.*\\.setup\\.ts/ },`,
      `    { name: 'chromium', dependencies: ['setup'] },`,
      `  ],`,
      `};`,
      '',
    ].join('\n'),
  );
  mkdirSync(join(cwd, 'tests'), { recursive: true });
  writeFileSync(
    join(cwd, 'tests', 'auth.setup.ts'),
    [
      `import { writeFileSync } from 'node:fs';`,
      `import { test as setup } from 'playwright/test';`,
      `setup('authenticate', async () => {`,
      `  await new Promise((resolve) => setTimeout(resolve, 800));`,
      `  writeFileSync('user.json', '{}');`,
      `});`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(cwd, 'tests', 'feature.spec.ts'),
    [
      `import { existsSync } from 'node:fs';`,
      `import { expect, test } from 'playwright/test';`,
      `test('feature works', async () => {`,
      `  expect(existsSync('user.json')).toBe(true);`,
      `});`,
      '',
    ].join('\n'),
  );
}

describe('a setup dependency project keeps every executed test inside the expected set', () => {
  it('opens a session for every test the supervised run executes', async () => {
    const cwd = tempDir('run');
    const stateDir = tempDir('run-state');
    writeSetupDependencyProject(cwd);

    // Registered exactly as test-gates registers it: the independent
    // `playwright --list` enumeration of the consumer's own config.
    const enumeration = await listNativePlaywrightTests({ cwd });
    expect(enumeration.instances.length).toBe(2);

    const runId = 'setup-dependency-run';
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
      const projectScopes: ProjectScope[] = [
        ...new Set(enumeration.instances.map((instance) => instance.project)),
      ]
        .map((name) => ({
          name,
          files: [
            ...new Set(
              enumeration.instances.filter((i) => i.project === name).map((i) => i.file),
            ),
          ].sort(),
        }))
        .sort((left, right) => (left.name < right.name ? -1 : 1));
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: [] },
        { stateDir, runId, vars: {} },
        {
          cwd,
          timeoutMs: 120_000,
          testFiles: enumeration.instances.map((instance) => instance.file),
          projects: projectScopes.map((scope) => scope.name),
          projectScopes,
        },
      );
      const { conflicts } = await drain.stop();
      const trace = await supervisor.executionTrace();
      const sessionsOpened = (trace?.tests ?? []).reduce((total, test) => total + test.sessions.length, 0);

      // Every executed test that produced an outcome must have a session: an
      // identity the registration never bound loses all of its evidence.
      const executed = envelope.outcomes.length;
      expect(conflicts).toEqual([]);
      expect(sessionsOpened).toBe(executed);
      // ...and the run's executions cannot outrun the enumeration it planned.
      expect(executed).toBe(enumeration.instances.length);
      expect(envelope.complete).toBe(true);
    } finally {
      await witness.stop();
    }
  });

  it('runs the setup project before the dependent project that reads its artifact', async () => {
    const cwd = tempDir('ordered');
    const stateDir = tempDir('ordered-state');
    writeDelayedSetupDependencyProject(cwd);

    const enumeration = await listNativePlaywrightTests({ cwd });
    // The enumeration is the ONLY trusted source of the dependency edge:
    // the runner's json reporter does not carry it, so the pack asks the
    // runner for it through its own reporter.
    expect(enumeration.projectDependencies).toEqual({ setup: [], chromium: ['setup'] });

    const runId = 'ordered-run';
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
      const names = [...new Set(enumeration.instances.map((instance) => instance.project))].sort();
      const projectScopes: ProjectScope[] = names.map((name) => ({
        name,
        files: [
          ...new Set(enumeration.instances.filter((i) => i.project === name).map((i) => i.file)),
        ].sort(),
        dependencies: [...(enumeration.projectDependencies[name] ?? [])].sort(),
      }));
      const envelope = await executeSupervisedPlaywright(
        { logicalKeys: [] },
        { stateDir, runId, vars: {} },
        {
          cwd,
          timeoutMs: 120_000,
          testFiles: enumeration.instances.map((instance) => instance.file),
          projects: names,
          projectScopes,
        },
      );
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      expect(envelope.complete).toBe(true);
      // Both tests ran and PASSED — the dependent one read the artifact
      // the setup test wrote, which is only true when it ran second.
      expect(envelope.outcomes.map((outcome) => [outcome.project, outcome.status])).toEqual([
        ['setup', 'passed'],
        ['chromium', 'passed'],
      ]);
      // The lifecycle spool is the record of what really ran, in order.
      const events = readFileSync(spoolPathFor(stateDir, runId), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; project: string | null });
      expect(
        events.filter((event) => event.kind === 'testBegin').map((event) => event.project),
      ).toEqual(['setup', 'chromium']);
    } finally {
      await witness.stop();
    }
  });

  it('still refuses a session for a test outside the registered expected set', async () => {
    const cwd = tempDir('failclosed');
    const stateDir = tempDir('failclosed-state');
    writeSetupDependencyProject(cwd);
    const enumeration = await listNativePlaywrightTests({ cwd });
    const setupFile = enumeration.instances.find((i) => i.project === 'setup');
    const featureFile = enumeration.instances.find((i) => i.project === 'chromium');
    if (setupFile === undefined || featureFile === undefined) throw new Error('enumeration shape changed');

    const runId = 'fail-closed-run';
    const witness = await startWitness({ runId, token: RUN_TOKEN, verifierKey: VERIFIER_KEY, host: LOOPBACK });
    const supervisor = new SupervisorClient(witness.url, RUN_TOKEN, VERIFIER_KEY);
    // Register ONLY the setup project's test: the chromium tests the runner
    // will execute are outside the expected set and must be refused.
    await supervisor.registerExpectedSet({
      tests: [
        {
          testId: setupFile.frameworkId,
          project: 'setup',
          file: setupFile.file,
          titlePath: setupFile.titlePath,
        },
      ],
    });
    // The drain reports each refusal on stderr; capture it so the test can
    // prove the refusal actually happened rather than inferring it.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown, ...rest: unknown[]): void => {
      warnings.push([message, ...rest].map(String).join(' '));
      originalWarn(message, ...rest);
    };
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: witness.url,
      runToken: RUN_TOKEN,
      verifierKey: VERIFIER_KEY,
    });
    try {
      await executeSupervisedPlaywright(
        { logicalKeys: [] },
        { stateDir, runId, vars: {} },
        {
          cwd,
          timeoutMs: 120_000,
          testFiles: [setupFile.file, featureFile.file],
          projects: ['chromium', 'setup'],
          projectScopes: [
            { name: 'setup', files: [setupFile.file] },
            { name: 'chromium', files: [featureFile.file] },
          ],
        },
      );
      await drain.stop();
      console.warn = originalWarn;
      const trace = await supervisor.executionTrace();
      const registeredKeys = new Set(
        (trace?.tests ?? []).map((test) => `${test.project ?? '-'}|${test.file}|${test.titlePath.join('>')}`),
      );
      // The runner's own lifecycle spool is the record of what really ran.
      const events = readFileSync(spoolPathFor(stateDir, runId), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; project: string | null; file: string });
      const begun = events.filter((event) => event.kind === 'testBegin');
      // The chromium tests really executed alongside the setup project's ...
      expect(begun.map((event) => event.project).sort()).toContain('chromium');
      expect(begun.map((event) => event.project)).toContain('setup');
      // ... and the fail-closed rule stands: a session exists for the ONE
      // registered identity and for nothing else, so an unregistered
      // execution carries no evidence at all.
      expect(registeredKeys).toEqual(new Set([`setup|${setupFile.file}|${setupFile.titlePath.join('>')}`]));
      // Every refused begin is exactly one the run really executed outside
      // the registered set — no silent skips, no phantom refusals.
      const unregistered = begun.filter(
        (event) => !(event.project === 'setup' && event.file === setupFile.file),
      );
      expect(unregistered.length).toBeGreaterThanOrEqual(1);
      expect(warnings.filter((line) => /not in the registered expected set/i.test(line))).toHaveLength(
        unregistered.length,
      );
    } finally {
      console.warn = originalWarn;
      await witness.stop();
    }
  });
});
