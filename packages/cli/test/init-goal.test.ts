/**
 * Goal-based `init` (plan Phase 0-2): the ONE question, the three
 * presets, and the honest non-interactive default.
 *
 * Two directions matter and are tested separately:
 * - an AI agent / CI run WITHOUT `--preset` must write light and say a
 *   human must choose (never silently guess normal or strict);
 * - a human in a fake terminal answers ONE question and gets that goal's
 *   wiring plus a summary of what was written.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, withTempRepo } from '@gate-forge/core';
import {
  CHOOSE_ANOTHER_GOAL_ADVICE,
  INIT_PRESETS,
  parseGoalAnswer,
  renderGoalQuestion,
  renderPresetTable,
} from '../src/commands/init-presets.js';
import { runCli } from './helpers.js';

/** Answers the fake terminal serves, in prompt order. */
const scriptedAnswers: string[] = [];

// The fake terminal: `process.stdin.isTTY` is what every init prompt
// checks, and `createInterface` is what reads the answer. Replacing the
// readline interface (not the prompt code) keeps the real ordering and
// the real question strings under test.
vi.mock('node:readline/promises', async () => {
  const actual = await vi.importActual<typeof import('node:readline/promises')>(
    'node:readline/promises',
  );
  return {
    ...actual,
    createInterface: () => ({
      question: async () => scriptedAnswers.shift() ?? '',
      close: () => {},
    }),
  };
});

/** Makes `process.stdin`/`process.stdout` report a terminal. */
function useFakeTerminal(): void {
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  }
}

beforeEach(() => {
  scriptedAnswers.length = 0;
});

afterEach(() => {
  // Restore the real non-TTY streams for every later test file section.
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, 'isTTY', { value: undefined, configurable: true });
  }
});

describe('init goal question wording', () => {
  it('asks exactly one question and explains each choice in one line', () => {
    const question = renderGoalQuestion();
    expect(question.match(/Your choice/g)).toHaveLength(1);
    expect(question).toContain('What should Gateforge do for you?');
    expect(question).toContain('1) light');
    expect(question).toContain('2) normal');
    expect(question).toContain('3) strict');
    expect(question).toMatch(/block nothing/);
    // Jargon is explained where it is first used.
    expect(INIT_PRESETS.strict.explanation).toContain('WITNESS');
    expect(INIT_PRESETS.strict.explanation).toContain('RECEIPT');
    expect(INIT_PRESETS.normal.explanation).toMatch(/Example:/);
    expect(renderPresetTable()).toContain('An OBLIGATION is one thing');
  });

  it('maps an answer to a goal and rejects nonsense', () => {
    expect(parseGoalAnswer('')).toBe('normal');
    expect(parseGoalAnswer('1')).toBe('light');
    expect(parseGoalAnswer('3')).toBe('strict');
    expect(parseGoalAnswer('strict')).toBe('strict');
    expect(() => parseGoalAnswer('turbo')).toThrow(/not a goal/);
  });
});

describe('init without a preset, without a terminal', () => {
  it('writes light only and says a human must choose', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--no-scan']);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('no terminal: writing the light preset');
      expect(stdout).toContain(CHOOSE_ANOTHER_GOAL_ADVICE);
      // Light means warn: the report lists untested code, nothing blocks.
      expect(loadConfig(join(repo.root, '.gateforge.yml')).mode).toBe('warn');
      expect(existsSync(repo.path('.git/hooks/pre-commit'))).toBe(false);
      expect(existsSync(repo.path('.pre-commit-config.yaml'))).toBe(false);
    });
  });

  it('states the chosen preset once, on the line that names --preset (F5)', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--no-scan']);
      expect(code, stdout).toBe(0);
      const advice = stdout.split('\n').filter((line) => line.includes('--preset'));
      // Exactly ONE line tells a headless owner how to choose another
      // preset, and it is the same line that names the one written.
      expect(advice).toHaveLength(1);
      expect(advice[0]).toContain('writing the light preset');
      expect(advice[0]).toContain('--preset <');
      // The closing summary no longer restates the choice a second time.
      expect(stdout).not.toContain('preset light:');
      // What the run actually did is still reported.
      expect(stdout).toContain('wrote mode: warn');
      expect(stdout).toContain('undo: rm -rf');
    });
  });
});

describe('init --preset', () => {
  it('--explain-presets prints the mapping and writes nothing', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--explain-presets']);
      expect(code).toBe(0);
      for (const name of ['light', 'normal', 'strict']) {
        expect(stdout).toContain(`${name} — `);
      }
      expect(stdout).toContain('mode: warn');
      expect(stdout).toContain('mode: strict');
      expect(existsSync(repo.path('.gateforge.yml'))).toBe(false);
    });
  });

  it('rejects an unknown preset as a usage error and writes nothing', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['init', '--preset', 'turbo']);
      expect(code).toBe(2);
      expect(stderr).toContain("flag '--preset' must be 'light', 'normal' or 'strict'");
      expect(existsSync(repo.path('.gateforge.yml'))).toBe(false);
    });
  });

  it('--preset strict writes the strict config and both hooks', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--no-scan', '--preset', 'strict']);
      expect(code, stdout).toBe(0);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.mode).toBe('strict');
      expect(config.enforcement?.strictE2E).toBe(true);
      expect(config.enforcement?.receiptStage).toBe('pre-push');
      expect(existsSync(repo.path('.git/hooks/pre-commit'))).toBe(true);
      expect(existsSync(repo.path('.git/hooks/pre-push'))).toBe(true);
      expect(stdout).toContain('preset strict:');
      expect(stdout).toContain('undo:');
      // A preset never writes a waiver, an adopted baseline or a plane rule.
      expect(existsSync(repo.path('.gateforge/planes.json'))).toBe(false);
      expect(readFileSync(repo.path('.gateforge/baselines/obligations.json'), 'utf8')).toContain(
        '"fingerprints": []',
      );
    });
  });

  it('--preset normal blocks only what a change touches, with a CI job', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--no-scan', '--preset', 'normal']);
      expect(code, stdout).toBe(0);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.mode).toBe('changed');
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).not.toContain('strictE2E: true');
      expect(readFileSync(repo.path('.git/hooks/pre-commit'), 'utf8')).toContain('check --changed');
      expect(existsSync(repo.path('.git/hooks/pre-push'))).toBe(false);
      expect(existsSync(repo.path('.gitlab-ci.yml'))).toBe(true);
      expect(stdout).toContain('preset normal:');
    });
  });

  it('never rewrites an existing config, byte for byte', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init', '--no-scan', '--preset', 'normal']);
      expect(first.code).toBe(0);
      const before = readFileSync(repo.path('.gateforge.yml'), 'utf8');
      const second = await runCli(repo, ['init', '--no-scan', '--preset', 'strict']);
      // R1-2: the strict preset asks for `mode: strict` and
      // `enforcement.strictE2E: true`; the existing config has
      // `mode: changed` and no strict E2E. init never rewrites
      // an existing config, so the differing request exits 2
      // before anything is written — the owner sets the keys.
      expect(second.code).toBe(2);
      expect(second.stderr).toContain('.gateforge.yml exists and has mode: changed');
      expect(second.stderr).toContain('you asked for strict');
      expect(second.stderr).toContain('.gateforge.yml exists and has enforcement.strictE2E: false');
      expect(second.stderr).toContain('you asked for true');
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toBe(before);
      expect(loadConfig(repo.path('.gateforge.yml')).mode).toBe('changed');
    });
  });
});

describe('init in a terminal (fake TTY)', () => {
  it('answering 3 gives the strict config and both hooks', async () => {
    await withTempRepo({}, async (repo) => {
      useFakeTerminal();
      // the goal question comes first, then the follow-ups in prompt order
      scriptedAnswers.push('3', '', '', '', '', 'n');
      const { code, stdout } = await runCli(repo, ['init', '--no-scan']);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('What should Gateforge do for you?');
      expect(stdout).toContain('1) light');
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.mode).toBe('strict');
      expect(config.enforcement?.strictE2E).toBe(true);
      expect(existsSync(repo.path('.git/hooks/pre-commit'))).toBe(true);
      expect(existsSync(repo.path('.git/hooks/pre-push'))).toBe(true);
      expect(stdout).toContain('preset strict:');
    });
  }, 120_000);

  it('answering 1 asks nothing about blocking and wires no hook', async () => {
    await withTempRepo({}, async (repo) => {
      useFakeTerminal();
      scriptedAnswers.push('1', '', '', '', '', 'n');
      const { code, stdout } = await runCli(repo, ['init', '--no-scan']);
      expect(loadConfig(repo.path('.gateforge.yml')).mode).toBe('warn');
      expect(existsSync(repo.path('.git/hooks/pre-commit'))).toBe(false);
      expect(stdout).not.toContain('a human must choose the preset');
      expect(stdout).toContain('preset light:');
    });
  }, 120_000);

  it('an explicit --blocking is not overridden by the goal', async () => {
    await withTempRepo({}, async (repo) => {
      useFakeTerminal();
      scriptedAnswers.push('', '', '', '', 'n');
      const { code, stdout } = await runCli(repo, ['init', '--no-scan', '--blocking']);
      expect(code, stdout).toBe(0);
      // No preset ran, so the config keeps today's shape: no `mode:` key,
      // which means strict — the frozen default.
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).not.toContain('\nmode: ');
      expect(stdout).not.toContain('preset ');
    });
  }, 120_000);
});
describe('init --preset with enforcement flags (R1-1)', () => {
  it('a flag the preset already implies is a no-op and the preset applies', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout, stderr } = await runCli(repo, [
        'init',
        '--no-scan',
        '--preset',
        'strict',
        '--blocking',
        '--pre-commit',
        '--ci',
        '--strict-e2e',
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      // The strict preset's config: strict mode + strict E2E.
      expect(config.mode).toBe('strict');
      expect(config.enforcement?.strictE2E).toBe(true);
      // The strict wiring (blocking: both hooks) was applied.
      expect(existsSync(repo.path('.git/hooks/pre-commit'))).toBe(true);
      expect(existsSync(repo.path('.git/hooks/pre-push'))).toBe(true);
      expect(stdout).toContain('preset strict:');
    });
  });

  it('the normal preset applies with the flags it implies', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout, stderr } = await runCli(repo, [
        'init',
        '--no-scan',
        '--preset',
        'normal',
        '--pre-commit',
        '--ci',
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.mode).toBe('changed');
      expect(stdout).toContain('preset normal:');
    });
  });

  it('a positive flag the preset does not wire contradicts it (light)', async () => {
    await withTempRepo({}, async (repo) => {
      for (const flag of ['--blocking', '--pre-commit', '--ci', '--strict-e2e']) {
        const { code, stderr } = await runCli(repo, ['init', '--no-scan', '--preset', 'light', flag]);
        expect(code, `${flag}: ${stderr}`).toBe(2);
        expect(stderr, flag).toContain('--preset light already decides');
        expect(stderr, flag).toContain(`--${flag.slice(2)} contradicts it — drop one of them`);
        // Nothing was written: the contradiction is decided before any file.
        expect(existsSync(repo.path('.gateforge.yml')), flag).toBe(false);
      }
    });
  });

  it('a positive flag the normal preset does not wire contradicts it', async () => {
    await withTempRepo({}, async (repo) => {
      for (const flag of ['--blocking', '--strict-e2e']) {
        const { code, stderr } = await runCli(repo, ['init', '--no-scan', '--preset', 'normal', flag]);
        expect(code, `${flag}: ${stderr}`).toBe(2);
        expect(stderr, flag).toContain('--preset normal already decides');
        expect(stderr, flag).toContain(`--${flag.slice(2)} contradicts it — drop one of them`);
        expect(existsSync(repo.path('.gateforge.yml')), flag).toBe(false);
      }
    });
  });

  it('a --no-* flag contradicts a preset that wires the thing', async () => {
    await withTempRepo({}, async (repo) => {
      const cases: Array<[string, string]> = [
        ['strict', '--no-blocking'],
        ['strict', '--no-pre-commit'],
        ['strict', '--no-ci'],
        ['normal', '--no-pre-commit'],
        ['normal', '--no-ci'],
      ];
      for (const [preset, flag] of cases) {
        const { code, stderr } = await runCli(repo, ['init', '--no-scan', '--preset', preset, flag]);
        expect(code, `${preset} ${flag}: ${stderr}`).toBe(2);
        expect(stderr, `${preset} ${flag}`).toContain(`--preset ${preset} already decides`);
        expect(stderr, `${preset} ${flag}`).toContain(`${flag} contradicts it — drop one of them`);
        expect(existsSync(repo.path('.gateforge.yml')), `${preset} ${flag}`).toBe(false);
      }
    });
  });

  it('a --no-* flag for something the preset does not wire is a no-op', async () => {
    await withTempRepo({}, async (repo) => {
      // light wires nothing, so no negative flag can contradict it.
      const { code, stdout, stderr } = await runCli(repo, [
        'init',
        '--no-scan',
        '--preset',
        'light',
        '--no-blocking',
        '--no-pre-commit',
        '--no-ci',
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(loadConfig(join(repo.root, '.gateforge.yml')).mode).toBe('warn');
      expect(stdout).toContain('preset light:');
    });
  });

  it('without a preset, enforcement flags behave exactly as today', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout, stderr } = await runCli(repo, ['init', '--no-scan', '--blocking']);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      // No preset ran: the config keeps today's shape (no `mode:` key).
      expect(readFileSync(join(repo.root, '.gateforge.yml'), 'utf8')).not.toContain('\nmode: ');
      expect(existsSync(repo.path('.git/hooks/pre-commit'))).toBe(true);
    });
  });
});
