/**
 * The app-owned managed-run recipe (managed-run plan, Part B).
 *
 * Gateforge sequences the owner's commands; it never interprets their
 * output, never trusts it, and never lets a secret reach the console.
 * These tests pin that contract: declared order, per-step timeout, the
 * plain failure message, `services_down` after a failure, and env
 * values that stay in the log file the operator already owns.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';
import {
  loadRunRecipe,
  recipeSetupSteps,
  runRecipeStep,
  RECIPE_TIMEOUT_EXIT_CODE,
  type RunRecipe,
} from '../src/run-recipe.js';
import { loadConfigAt } from '../src/commands/common.js';

/** Marker every recipe command appends, in execution order. */
const ORDER_MARKER = 'order.txt';

/** Temporary directories to clean up. */
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * Creates a scratch directory for recipe artifacts.
 *
 * Returns:
 *   string: absolute path of the directory.
 */
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-recipe-'));
  scratchDirectories.push(directory);
  return directory;
}

/**
 * Writes a recipe whose steps only record their execution order.
 *
 * Args:
 *   repo: the fixture repository.
 *   steps: recipe keys to declare, in an order the run must NOT follow.
 */
function writeOrderRecipe(repo: TempRepo, steps: readonly string[]): void {
  const block = steps
    .map(
      (step) =>
        `${step}:\n  commands:\n    - ['${process.execPath}', '-e', "require('fs').appendFileSync('${ORDER_MARKER}','${step}\\\\n')"]`,
    )
    .join('\n');
  repo.writeFiles({ '.gateforge/runtime.yml': `schemaVersion: 1\n${block}\n` });
}

/**
 * Reads the executed step order recorded by the recipe.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   string[]: the step names in execution order.
 */
function recordedOrder(cwd: string): string[] {
  const path = join(cwd, ORDER_MARKER);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
}

/**
 * Loads the fixture repository's recipe.
 *
 * Args:
 *   repo: the fixture repository.
 *
 * Returns:
 *   RunRecipe: the loaded recipe (the caller asserts it is not null).
 */
function recipeOf(repo: TempRepo): RunRecipe {
  const recipe = loadRunRecipe(repo.root, loadConfigAt(repo.root));
  expect(recipe, 'recipe loaded').not.toBeNull();
  return recipe as RunRecipe;
}

describe('run recipe (declared order, timeouts, teardown, secrets)', () => {
  it('an absent recipe means no lifecycle at all', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      expect(loadRunRecipe(repo.root, loadConfigAt(repo.root))).toBeNull();
      expect(recipeSetupSteps(null)).toEqual([]);
    });
  });

  it('a managed run consumes the declared steps in lifecycle order, not file order', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      writeOrderRecipe(repo, ['services_down', 'healthcheck', 'services_up', 'seed', 'reset']);
      const recipe = recipeOf(repo);
      expect(recipeSetupSteps(recipe).map((step) => step.name)).toEqual([
        'reset',
        'seed',
        'services_up',
        'healthcheck',
      ]);
      for (const step of recipeSetupSteps(recipe)) {
        const outcome = await runRecipeStep(step, repo.root, { ...process.env }, {
          envFiles: recipe.envFiles,
          logName: step.name,
        });
        expect(outcome.code).toBe(0);
      }
      expect(recordedOrder(repo.root)).toEqual(['reset', 'seed', 'services_up', 'healthcheck']);
    });
  });

  // A real child process with a real deadline: the timeout path is the
  // platform's SIGTERM behavior, which no fake clock can stand in for.
  it('a step that exceeds its own timeout is reported, not waited out forever', async () => {
    const directory = scratch();
    const outcome = await runRecipeStep(
      { commands: [[process.execPath, '-e', 'setInterval(() => {}, 1000)']], timeoutSeconds: 1 },
      directory,
      { ...process.env },
      { logName: 'seed' },
    );
    expect(outcome.code).toBe(RECIPE_TIMEOUT_EXIT_CODE);
    expect(outcome.logPath).toBe(join(directory, '.gateforge', 'test-gates', 'run-recipe', 'seed-log.txt'));
  });

  it('a failing command keeps its exit code and its output out of every message', async () => {
    const directory = scratch();
    const outcome = await runRecipeStep(
      { commands: [[process.execPath, '-e', "console.log('super-secret-value'); process.exit(3)"]] },
      directory,
      { ...process.env },
      { logName: 'reset' },
    );
    expect(outcome.code).toBe(3);
    expect(readFileSync(outcome.logPath, 'utf8')).toContain('super-secret-value');
  });

  it('a retried step runs its commands again and keeps the last failure code', async () => {
    const directory = scratch();
    const marker = join(directory, 'attempts.txt');
    const outcome = await runRecipeStep(
      {
        commands: [
          [
            process.execPath,
            '-e',
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');process.exit(fs.readFileSync(${JSON.stringify(marker)},'utf8').length>=2?5:1)`,
          ],
        ],
        retries: 1,
      },
      directory,
      { ...process.env },
      { logName: 'reset' },
    );
    expect(outcome.code).toBe(5);
    expect(outcome.attempts).toBe(2);
  });

  it('teardown is a declared step of its own, so it runs after a failure too', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/runtime.yml': `schemaVersion: 1
reset:
  commands:
    - ['${process.execPath}', '-e', "process.exit(4)"]
services_down:
  commands:
    - ['${process.execPath}', '-e', "require('fs').appendFileSync('${ORDER_MARKER}','services_down\\\\n')"]
`,
      });
      const recipe = recipeOf(repo);
      const teardown = await runRecipeStep(recipe.services_down!, repo.root, { ...process.env }, {
        envFiles: recipe.envFiles,
        logName: 'services_down',
      });
      expect(teardown.code).toBe(0);
      expect(recordedOrder(repo.root)).toEqual(['services_down']);
    });
  });

  it('env_files carry paths only, load real values, and keep them in the log', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge/secrets.env': 'APP_TOKEN=never-print-me\n' });
      repo.writeFiles({
        '.gateforge/runtime.yml': `schemaVersion: 1
env_files:
  - .gateforge/secrets.env
healthcheck:
  commands:
    - ['${process.execPath}', '-e', "process.stdout.write(String(process.env['APP_TOKEN'] ?? 'missing'))"]
`,
      });
      const recipe = recipeOf(repo);
      const outcome = await runRecipeStep(recipe.healthcheck!, repo.root, { ...process.env }, {
        envFiles: recipe.envFiles,
        logName: 'healthcheck',
      });
      expect(outcome.code).toBe(0);
      expect(readFileSync(outcome.logPath, 'utf8')).toBe('never-print-me');
    });
  });

  it('an inline secret in env_files is a plain schema error, exit 2', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge/runtime.yml': 'schemaVersion: 1\nenv_files:\n  - APP_TOKEN=inline\n' });
      const result = await runCli(repo, ['run']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('env_files entries are paths only');
    });
  });

  it('an unknown recipe key is a plain schema error, exit 2', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge/runtime.yml': 'schemaVersion: 1\nstart_services:\n  command: echo hi\n' });
      const result = await runCli(repo, ['run']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('violates its schema');
    });
  });

  it('a declared env file that does not exist is a plain error, exit 2', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge/runtime.yml': 'schemaVersion: 1\nenv_files:\n  - .gateforge/missing.env\n' });
      const result = await runCli(repo, ['run']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('does not exist');
    });
  });
});
