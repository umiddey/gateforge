/**
 * Phase 4 setup UX: a FRESH copy of `example/webhook` reaches a green
 * gate by following ONLY what the CLI printed.
 *
 * The test is an agent, not a fixture author: it copies the example,
 * runs `gateforge init` with the documented flag, then follows the
 * printed lines — the config key, the behavior declaration, the proof
 * test, the test-map entries, the gate command — without writing a
 * single value of its own. Everything it pastes is parsed back out of
 * the tool's own output, so a printed step that stops being exact fails
 * here rather than in a user's repository.
 *
 * The gate is the example's own `npm run gate`: it starts the receiver
 * on a free loopback port with a per-run signing secret, runs
 * `test-gates --changed` and `check --require-e2e`, and exits with the
 * check's status.
 */
import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { spawnSync } from 'node:child_process';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';

/** Repo root (the example receiver lives here). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** The example the fresh copy starts from. */
const EXAMPLE = join(ROOT, 'example/webhook');

/** Every file the example ships (the app and its own wiring, no gates). */
function copyExample(repoRoot: string): void {
  cpSync(EXAMPLE, repoRoot, { recursive: true });
  // The consumer resolves its CLI and suites through node_modules; the
  // workspace's own tree is the same install a published consumer gets.
  symlinkSync(process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'), join(repoRoot, 'node_modules'), 'dir');
}

/**
 * The fenced blocks of a printed step list, in print order.
 *
 * @param stdout the command's stdout
 * @returns string[] each block between a ``` fence
 */
function codeBlocks(stdout: string): string[] {
  const blocks: string[] = [];
  const lines = stdout.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const opening = (lines[index] as string).trim();
    if (!/^```[a-z]*$/.test(opening)) continue;
    const body: string[] = [];
    index += 1;
    while (index < lines.length && (lines[index] as string).trim() !== '```') {
      body.push(lines[index] as string);
      index += 1;
    }
    blocks.push(body.join('\n').replace(/^\n+|\n+$/g, ''));
  }
  return blocks;
}

describe('setup UX: a fresh example/webhook copy reaches green from printed lines only', () => {
  it('init names the pack, next prints the whole declaration, and the gate is green', async () => {
    await withTempRepo({}, async (repo) => {
      copyExample(repo.root);
      // The example ships its own config and wiring; the two files the
      // setup UX owns (the behavior document and the test map) are the
      // ones a fresh copy does NOT have.
      expect(existsSync(join(repo.root, '.gateforge/behavior.yml'))).toBe(false);
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'webhook example']);

      // 1. init with the documented flag. Non-interactive: it must not
      //    enable anything silently, and it must name the pack it found.
      const offer = await runCli(repo, ['init']);
      expect(offer.code, offer.stderr).toBe(0);
      expect(offer.stdout).toContain('behavior packs detected');
      expect(offer.stdout).toContain('webhook —');
      expect(offer.stdout).toContain('gateforge init --behavior-packs webhook');
      expect(existsSync(join(repo.root, '.gateforge/behavior.yml'))).toBe(false);

      const init = await runCli(repo, ['init', '--behavior-packs', 'webhook']);
      expect(init.code, init.stderr).toBe(0);
      expect(existsSync(join(repo.root, '.gateforge/behavior.yml'))).toBe(true);
      const skeleton = readFileSync(join(repo.root, '.gateforge/behavior.yml'), 'utf8');
      // The written document is a scaffold: an example per enabled pack,
      // commented, plus the exact config key the existing config needs.
      expect(skeleton).toContain('# endpoints:');
      expect(skeleton).toContain('webhook:signature-accepted');
      const behaviorKey = init.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('behaviorPolicy:'));
      expect(behaviorKey).toBe('behaviorPolicy: .gateforge/behavior.yml');
      const configText = readFileSync(join(repo.root, '.gateforge.yml'), 'utf8');
      expect(parseYaml(configText)).not.toHaveProperty('behaviorPolicy');
      writeFileSync(
        join(repo.root, '.gateforge.yml'),
        configText.replace('policies:', `${behaviorKey as string}\npolicies:`),
        'utf8',
      );

      // 2. next prints the whole remaining setup.
      const next = await runCli(repo, ['next']);
      expect(next.code, next.stderr).toBe(1);
      expect(next.stdout).toContain('is discovered but has no approved');
      expect(next.stdout).toContain('step 1 —');
      expect(next.stdout).toContain('step 4 —');
      const blocks = codeBlocks(next.stdout);
      expect(blocks).toHaveLength(3);
      const [declaration, proofSpec, testMap] = blocks as [string, string, string];

      // 3. Follow step 1: the printed entry goes under 'endpoints:'.
      const behaviorPath = join(repo.root, '.gateforge/behavior.yml');
      writeFileSync(
        behaviorPath,
        readFileSync(behaviorPath, 'utf8').replace(
          /^endpoints: \[\]\nresources: \[\]$/m,
          `endpoints:\n${declaration}\nresources: []`,
        ),
        'utf8',
      );
      // 4. Follow step 2: the printed proof test, byte for byte.
      mkdirSync(join(repo.root, 'specs'), { recursive: true });
      writeFileSync(join(repo.root, 'specs/gateforge-cases.spec.js'), `${proofSpec}\n`, 'utf8');
      // 5. Follow step 3: the printed test-map entries.
      writeFileSync(
        join(repo.root, '.gateforge/test-map.yml'),
        `schemaVersion: 1\ntests:\n${testMap}\n`,
        'utf8',
      );

      // 6. Follow step 4: the printed gate command.
      const gate = spawnSync('npm', ['run', 'gate'], {
        cwd: repo.root,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 600_000,
      });
      const transcript = `${gate.stdout}\n${gate.stderr}`;
      expect(transcript).toContain('gate: check --require-e2e');
      expect(transcript).toContain('gate: green');
      expect(gate.status, transcript).toBe(0);
    });
  }, 900_000);

  it('an init on a repository with no behavior packs is byte-identical', async () => {
    await withTempRepo({}, async (repo) => {
      mkdirSync(join(repo.root, 'src'), { recursive: true });
      writeFileSync(join(repo.root, 'src/plain.js'), 'export const answer = 42;\n');
      const quiet = await runCli(repo, ['init']);
      expect(quiet.code, quiet.stderr).toBe(0);
      // No behavior pack, no behavior output, no behavior file: the Phase
      // 4 additions are invisible to a repository that shows none.
      expect(quiet.stdout).not.toContain('behavior packs detected');
      expect(quiet.stdout).not.toContain('behaviorPolicy');
      expect(existsSync(join(repo.root, '.gateforge/behavior.yml'))).toBe(false);
      expect(parseYaml(readFileSync(join(repo.root, '.gateforge.yml'), 'utf8'))).not.toHaveProperty(
        'behaviorPolicy',
      );
    });
  });
});
