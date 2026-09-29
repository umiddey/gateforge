/**
 * `gateforge enforce --ci gitlab|github --witnessed`: the witnessed job
 * template (managed-run plan, Part C, feedback E59).
 *
 * A consumer used to hand-write ~850 lines of CI glue (job-scoped
 * names, a private workspace, merge-request base-sha forwarding, verdict
 * extraction, artifacts). The generated template must carry that glue,
 * stay plain reviewable YAML, and never print a secret variable.
 *
 * The last test executes the generated GitLab job's `script:` lines in
 * a clean checkout with the CI environment set — no Docker, no runner —
 * and requires a green receipt out of `gateforge run`.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { withTempRepo } from '@gate-forge/core';
import { startAttestationProxy } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt } from '../src/commands/common.js';
import { runCli } from './helpers.js';
import {
  cleanupWitnessedFixture,
  FINGERPRINT,
  installStrictFixture,
  operatorEnvironment,
  recipeSteps,
  startApp,
  writeTinyRecipe,
} from './witnessed-run-fixture.js';

/** Where the generated files land, per provider. */
const PATHS = {
  gitlab: '.gateforge/ci/gitlab-witnessed.yml',
  github: '.github/workflows/gateforge-witnessed.yml',
} as const;

/** Every generated file's path, per provider. */
const STATIC_PATHS = {
  gitlab: '.gateforge/ci/gitlab-gateforge.yml',
  github: '.github/workflows/gateforge.yml',
} as const;

/** Names no line of the template may print. */
const SECRET_NAMES = [
  'GATEFORGE_WITNESS_VERIFIER_KEY',
  'GATEFORGE_WITNESS_VERIFIER_KEY_FILE',
  'GATEFORGE_APPROVED_POLICY_DIGEST',
  'CI_JOB_TOKEN',
  'CI_REGISTRY_PASSWORD',
];

/**
 * Asserts that no line of a generated template prints a secret name.
 *
 * Args:
 *   source: the generated file.
 */
function expectNoSecretEcho(source: string): void {
  for (const line of source.split('\n')) {
    if (!/\b(echo|printf|print|set -x)\b/.test(line)) continue;
    for (const secret of SECRET_NAMES) {
      expect(line, `template line echoes ${secret}: ${line}`).not.toContain(secret);
    }
  }
  // A debug trace of the environment is the same leak in one word.
  expect(source).not.toContain('set -x');
  expect(source).not.toContain('printenv');
  expect(source).not.toContain('envsubst');
}

/** The joined `script:` blocks of the generated GitLab witnessed job. */
function gitlabScript(repoPath: (name: string) => string): string {
  const document = parseYaml(readFileSync(repoPath(PATHS.gitlab), 'utf8')) as {
    'gateforge:witnessed': { script?: unknown };
  };
  const job = document['gateforge:witnessed'];
  expect(job, 'the generated file must define the witnessed job').toBeDefined();
  const script = job?.script;
  expect(Array.isArray(script), 'script must be a list of blocks').toBe(true);
  return (script as string[]).join('\n');
}

/** The `variables:` block the runner exports into the job's script. */
function gitlabJobVariables(repoPath: (name: string) => string): Record<string, string> {
  const document = parseYaml(readFileSync(repoPath(PATHS.gitlab), 'utf8')) as {
    'gateforge:witnessed': { variables?: Record<string, string> };
  };
  return document['gateforge:witnessed'].variables ?? {};
}

/**
 * Runs the generated job's script lines in a shell, the way a runner
 * does: one shell for the whole `script:` list, so the install block's
 * `run_gateforge` is still defined for the blocks after it.
 *
 * Args:
 *   scriptPath: the shell file holding the joined script blocks.
 *   cwd: repository root.
 *   jobEnv: the environment the runner would export.
 *
 * Returns:
 *   Promise<{ status, stdout, stderr }>: the job's exit code and output.
 */
function runJobScript(
  scriptPath: string,
  cwd: string,
  jobEnv: Record<string, string>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  // The compiler target predates Promise.withResolvers, so this one
  // stays an executor promise.
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('bash', [scriptPath], { cwd, env: jobEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (status) => {
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}

afterEach(() => {
  cleanupWitnessedFixture();
});

describe('gateforge enforce --witnessed', () => {
  it('generates a GitLab witnessed job with job-scoped names, base-sha forwarding, full scope and artifacts', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      const enforced = await runCli(repo, ['enforce', '--ci', 'gitlab', '--witnessed']);
      expect(enforced.code, `stdout:\n${enforced.stdout}\nstderr:\n${enforced.stderr}`).toBe(0);
      expect(enforced.stdout).toContain(PATHS.gitlab);
      expect(existsSync(repo.path(PATHS.gitlab))).toBe(true);

      const document = parseYaml(readFileSync(repo.path(PATHS.gitlab), 'utf8')) as Record<string, Record<string, unknown>>;
      const job = document['gateforge:witnessed'];
      expect(job).toBeDefined();
      expect(job?.['image']).toBe('node:22');

      // Job-scoped names and a private per-job workspace: nothing two
      // concurrent jobs of one project can collide on.
      const variables = job?.['variables'] as Record<string, string>;
      expect(Object.keys(variables)).toContain('GATEFORGE_CI_JOB_SCOPE');
      expect(String(variables['GATEFORGE_CI_JOB_SCOPE'])).toContain('CI_JOB_ID');
      expect(String(variables['GATEFORGE_CI_STACK_NAME'])).toContain('CI_JOB_ID');
      expect(String(variables['GATEFORGE_CI_IMAGE_NAME'])).toContain('CI_JOB_ID');
      expect(String(variables['GATEFORGE_CI_WORKSPACE'])).toContain('CI_JOB_ID');

      // The merge-request base sha reaches BOTH supervised commands.
      const script = gitlabScript((name) => repo.path(name));
      expect(script).toContain('export CI_MERGE_REQUEST_DIFF_BASE_SHA');
      expect(script).toContain('GATEFORGE_CI_BASE_SHA');
      expect(script).toContain('test-gates');
      expect(script).toContain('check --require-e2e');
      // Full scope is the default: a narrowed run is the user's edit.
      expect(script).toContain('gateforge run -- --changed --scope full');
      // The verdict comes from the report json, not from a parsed log.
      expect(script).toContain('.gateforge/test-gates/report.json');
      expect(script).toContain('summary');
      // The run log is a file, so the job can upload it.
      expect(script).toContain('.gateforge/test-gates/ci-run.log');

      const artifacts = job?.['artifacts'] as { when?: string; paths?: string[] };
      expect(artifacts.when).toBe('always');
      expect(artifacts.paths).toEqual(
        expect.arrayContaining([
          '.gateforge/test-gates/report.json',
          '.gateforge/test-gates/receipt.json',
          '.gateforge/test-gates/ci-run.log',
        ]),
      );
      // The recipe log may hold secrets: never an artifact by default.
      expect(artifacts.paths).not.toContain('.gateforge/test-gates/run-recipe');

      const source = readFileSync(repo.path(PATHS.gitlab), 'utf8');
      expectNoSecretEcho(source);
      const include = parseYaml(readFileSync(repo.path('.gitlab-ci.yml'), 'utf8')) as {
        include: { local: string }[];
      };
      expect(include.include.map((entry) => entry.local)).toEqual(
        expect.arrayContaining(['.gateforge/ci/gitlab-gateforge.yml', PATHS.gitlab]),
      );
    });
  }, 120_000);

  it('generates a GitHub Actions witnessed job with the same guarantees', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      const enforced = await runCli(repo, ['enforce', '--ci', 'github', '--witnessed']);
      expect(enforced.code, `stdout:\n${enforced.stdout}\nstderr:\n${enforced.stderr}`).toBe(0);
      expect(existsSync(repo.path(PATHS.github))).toBe(true);

      const workflow = parseYaml(readFileSync(repo.path(PATHS.github), 'utf8')) as {
        jobs: Record<string, { steps: { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> }[] }>;
      };
      const job = workflow.jobs['witnessed'];
      expect(job, 'the generated workflow must define the witnessed job').toBeDefined();
      const steps = job?.steps ?? [];
      const runs = steps.map((step) => step.run ?? '').join('\n');

      expect(runs).toContain('gateforge run -- --changed --scope full');
      expect(runs).toContain('.gateforge/test-gates/report.json');
      expect(runs).toContain('.gateforge/test-gates/ci-run.log');
      // The base branch is what the scope provider diffs against.
      const forwarding = steps.find((step) => (step.run ?? '').includes('GITHUB_BASE_REF'));
      expect(forwarding, 'a step must forward the pull-request base ref').toBeDefined();
      expect(forwarding?.run).toContain('GITHUB_ENV');
      expect(forwarding?.run).toContain('github.base_ref');
      // Secrets arrive as environment values on the run step only.
      const runStep = steps.find((step) => (step.run ?? '').includes('gateforge run'));
      expect(runStep?.env?.['GATEFORGE_WITNESS_VERIFIER_KEY']).toBe('${{ secrets.GATEFORGE_WITNESS_VERIFIER_KEY }}');
      expect(runStep?.env?.['GATEFORGE_APPROVED_POLICY_DIGEST']).toBe('${{ secrets.GATEFORGE_APPROVED_POLICY_DIGEST }}');

      const upload = steps.find((step) => (step.uses ?? '').startsWith('actions/upload-artifact'));
      expect(upload, 'the witnessed job must upload its evidence').toBeDefined();
      expect(upload?.if).toBe('always()');
      expect(String(upload?.with?.['path'])).toContain('.gateforge/test-gates/receipt.json');
      expect(String(upload?.with?.['path'])).toContain('.gateforge/test-gates/ci-run.log');
      expect(String(upload?.with?.['path'])).not.toContain('run-recipe');

      const source = readFileSync(repo.path(PATHS.github), 'utf8');
      expectNoSecretEcho(source);
    });
  }, 120_000);

  it('never overwrites an edited witnessed template, and leaves the static job byte-identical', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      expect((await runCli(repo, ['enforce', '--ci', 'gitlab', '--witnessed'])).code).toBe(0);
      const edited = `${readFileSync(repo.path(PATHS.gitlab), 'utf8')}# reviewed by the owner\n`;
      writeFileSync(repo.path(PATHS.gitlab), edited);
      const again = await runCli(repo, ['enforce', '--ci', 'gitlab', '--witnessed']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain(`exists, leaving untouched: ${repo.path(PATHS.gitlab)}`);
      expect(readFileSync(repo.path(PATHS.gitlab), 'utf8')).toBe(edited);
    });
    // The static job is what the flag must not move a single byte of.
    let withoutFlag = '';
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      expect((await runCli(repo, ['enforce', '--ci', 'gitlab'])).code).toBe(0);
      withoutFlag = readFileSync(repo.path(STATIC_PATHS.gitlab), 'utf8');
      expect(existsSync(repo.path(PATHS.gitlab))).toBe(false);
    });
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      expect((await runCli(repo, ['enforce', '--ci', 'gitlab', '--witnessed'])).code).toBe(0);
      expect(readFileSync(repo.path(STATIC_PATHS.gitlab), 'utf8')).toBe(withoutFlag);
    });
  }, 240_000);

  it('runs the generated GitLab script lines to a green receipt on the example app', async () => {
    const { env } = operatorEnvironment();
    await withTempRepo({}, async (repo) => {
      installStrictFixture(repo);
      writeTinyRecipe(repo);
      expect((await runCli(repo, ['enforce', '--ci', 'gitlab', '--witnessed'])).code).toBe(0);
      repo.git(['add', '-A']);
      const baseSha = repo.commit('witnessed ci fixture');
      // The genuine candidate change under test.
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited comment.\n' });

      // The package-install block is the runner image's job (the
      // generated job is proven against a real install in enforce.test.ts);
      // here it is a no-op shim so the harness needs no registry.
      const shim = join(repo.root, 'ci-shim');
      mkdirSync(shim, { recursive: true });
      for (const name of ['npm', 'corepack']) {
        writeFileSync(join(shim, name), "#!/bin/sh\nexit 0\n");
        chmodSync(join(shim, name), 0o755);
      }

      const script = gitlabScript((name) => repo.path(name));
      const scriptPath = join(repo.root, 'ci-job.sh');
      writeFileSync(scriptPath, script);
      const app = await startApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const config = loadConfigAt(repo.root);
        // The runner exports the job's `variables:` block into the
        // script environment, expanding ${...} from the pipeline.
        const pipeline: Record<string, string> = {
          ...process.env,
          ...env,
          PATH: `${shim}:${process.env['PATH'] ?? ''}`,
          CI: 'true',
          CI_JOB_ID: '4711',
          CI_PROJECT_DIR: repo.root,
          CI_PROJECT_ID: '42',
          CI_PROJECT_PATH_SLUG: 'witnessed-fixture',
          CI_COMMIT_SHA: baseSha,
          CI_COMMIT_SHORT_SHA: 'abcdef0',
          CI_COMMIT_BRANCH: 'feature',
          CI_DEFAULT_BRANCH: 'main',
          CI_PIPELINE_SOURCE: 'merge_request_event',
          CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha,
          CI_API_V4_URL: 'https://gitlab.invalid/api/v4',
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
        };
        const jobEnv = {
          ...pipeline,
          ...Object.fromEntries(
            Object.entries(gitlabJobVariables((name) => repo.path(name))).map(([name, value]) => [
              name,
              value.replace(/\$\{(\w+)\}/g, (match, key: string) => pipeline[key] ?? match),
            ]),
          ),
        };
        // The parent keeps serving the app and the attestation proxy
        // while the job runs, so the run really drives the browser.
        const result = await runJobScript(scriptPath, repo.root, jobEnv);
        const output = `${result.stdout}${result.stderr}`;
        expect(result.status, `job output:\n${output}`).toBe(0);
        // The base sha really reached the scope provider: without it the
        // provider falls back to the local staged diff (0 files).
        expect(output).toContain('provider: gitlab-mr');
        expect(output).toContain('Gateforge CI: verdict');
        // The recipe ran, the suite ran, and the strict check accepted
        // the receipt the engine sealed.
        expect(recipeSteps(repo)).toEqual(['reset', 'services_down']);
        const receipt = JSON.parse(
          readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8'),
        ) as { verifierKeyId: string; verdictSummary: { blocking: number } };
        expect(receipt.verifierKeyId).toBe('managed-run-key');
        expect(receipt.verdictSummary.blocking).toBe(0);
        // The artifacts the job promises really exist.
        for (const artifact of ['report.json', 'receipt.json', 'ci-run.log']) {
          expect(existsSync(join(repo.root, '.gateforge/test-gates', artifact)), artifact).toBe(true);
        }
      } finally {
        await proxy.stop();
        app.stop();
      }
    });
  }, 600_000);
});
