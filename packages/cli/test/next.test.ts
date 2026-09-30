/**
 * `gateforge next`: the single blocking next action (Phase 1 item 2) —
 * navigation, not the gate. Exit 0 clean, 1 next action, 2 config/usage.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint, withTempRepo } from '@gate-forge/core';
import {
  installFixture,
  LIFECYCLE,
  OBLIGATION_ACCOUNTS,
  OBLIGATION_ORDERS,
  POLICY_ID,
  runCli,
} from './helpers.js';

/** A valid, unexpired waiver for one fixture obligation. */
function waiverJson(resourceId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: 'team-' + resourceId.split('.')[1],
    justificationUrl: 'https://example.invalid/justification',
    approver: 'approver@example.invalid',
    scope: {
      kind: 'exact',
      resourceId,
      fingerprint: fingerprint({
        resourceId,
        contract: 'persistence:read',
        policyId: POLICY_ID,
        lifecycle: LIFECYCLE,
      }),
    },
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
}

/**
 * Splits one printed POSIX command line into argv (single-quoted
 * arguments are the only quoting `next` generates).
 *
 * Args:
 *   line: the printed command.
 *
 * Returns:
 *   string[]: the argument vector.
 */
function parsePrintedCommand(line: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const character of line) {
    if (character === "'") {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (character === ' ' && !quoted) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

/**
 * Every runnable command line `next` printed: the `do:` line when it
 * is a command, plus each command in the guidance block.
 *
 * Args:
 *   stdout: the printed `next` output.
 *
 * Returns:
 *   string[]: printed command lines, in print order.
 */
function printedCommands(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('gateforge '))
    .map((line) => (line.startsWith('do: ') ? line.slice('do: '.length) : line));
}

describe('gateforge next', () => {
  it('no config → exit 2 directing to init', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['next']);
      expect(code).toBe(2);
      expect(stderr).toContain('gateforge init');
    });
  });

  it('unsatisfied persistence obligations → exit 1 with one overlay next action', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      // Exactly one action: the lowest obligation id wins the rank.
      expect(stdout).toContain(`next: ${OBLIGATION_ACCOUNTS}`);
      expect(stdout).toContain('cause: TEST_MAPPING_MISSING');
      expect(stdout).toContain('do:');
      expect(stdout).toContain('tests/e2e/gateforge');
      expect(stdout).not.toContain(OBLIGATION_ORDERS);
    });
  });

  it('ignores a run-only claim when ranking current mapping gaps', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/test-gates/claims.json': JSON.stringify([
          {
            schemaVersion: 1,
            obligationId: OBLIGATION_ORDERS,
            testId: 'suite-test',
            testFile: 'tests/orders.spec.ts',
          },
        ]),
      });
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      expect(stdout).toContain(`next: ${OBLIGATION_ACCOUNTS}`);
      expect(stdout).toContain('cause: TEST_MAPPING_MISSING');
      expect(stdout).toContain('tests/e2e/gateforge');
    });
  });

  it('--json is parseable with a remainingBlocking count', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['next', '--json']);
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout) as {
        next: string;
        cause: string;
        why: string;
        do: string;
        remainingBlocking: number;
      };
      expect(parsed.next).toBe(OBLIGATION_ACCOUNTS);
      expect(parsed.cause).toBe('TEST_MAPPING_MISSING');
      expect(typeof parsed.why).toBe('string');
      expect(parsed.do).toContain('tests/e2e/gateforge');
      expect(parsed.remainingBlocking).toBe(1);
    });
  });

  it('--changed honors the diff scope like check', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.git(['add', '-A']);
      const { code, stdout } = await runCli(repo, ['next', '--changed']);
      expect(code).toBe(1);
      expect(stdout).toContain('next:');
      expect(stdout).toContain('cause:');
      expect(stdout).toContain('do:');
    });
  });

  it('waived obligations → exit 0 clean', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(0);
      expect(stdout).toContain('clean');
      const json = await runCli(repo, ['next', '--json']);
      expect(json.code).toBe(0);
      const parsed = JSON.parse(json.stdout) as { next: null; remainingBlocking: number };
      expect(parsed.next).toBeNull();
      expect(parsed.remainingBlocking).toBe(0);
    });
  });

  it('a tracked dangling symlink does not block the run (F2)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // The template shape: a checked-in skill link into a virtualenv
      // that exists only after the project's own bootstrap.
      mkdirSync(join(repo.root, '.agents/skills'), { recursive: true });
      symlinkSync(
        '../../.venv/lib/python3.14/site-packages/fastapi',
        join(repo.root, '.agents/skills/fastapi'),
      );
      repo.git(['add', '-A']);
      repo.git([
        '-c', 'user.name=fixture',
        '-c', 'user.email=fixture@gateforge.invalid',
        'commit', '--quiet', '-m', 'dangling skill link',
      ]);
      const { code, stdout, stderr } = await runCli(repo, ['next']);
      expect(stderr).not.toContain('unsupported input snapshot');
      expect(code).toBe(1);
      expect(stdout).toContain('next:');
      // One plain notice line naming the dangling link, then the run
      // continues with the single next action.
      expect(stdout).toContain('dangling symlink');
      expect(stdout).toContain('.agents/skills/fastapi');
    });
  });

  it('every printed command runs as printed on a fresh initialized repo (F9)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // An unresolved route: the printed `do:` is the plane-classification
      // guidance, whose commands need an owner-reviewed planes file.
      const plugin = readFileSync(join(repo.root, 'plugin.mjs'), 'utf8');
      repo.writeFiles({
        'plugin.mjs': plugin.replace(
          'return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
          `const httpResource = {
             schemaVersion: 1,
             kind: 'http.contract',
             source: 'src/http.ts',
             location: { file: 'src/http.ts', line: 1, col: 0 },
             detectorVersion: '1.0.0',
             attributes: { role: 'server-route', method: 'DELETE', normalizedPath: '/items/{item_id}', rawPath: '/items/{item_id}', framework: 'express', handlerSymbol: 'deleteItem' },
             id: 'http.contract:delete',
           };
           resources.push(httpResource);
           return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };`,
        ),
      });
      const first = await runCli(repo, ['next']);
      expect(first.code).toBe(1);
      const commands = printedCommands(first.stdout);
      expect(commands.length).toBeGreaterThan(1);
      for (const command of commands) {
        // The plane commands are alternatives ("choose only the command
        // for the boundary confirmed by the owner"), so each one is
        // checked from the baseline the guidance prints for it: the
        // prerequisite run, with no rule chosen yet. A command that only
        // works after a sibling command ran is not runnable as printed.
        rmSync(join(repo.root, '.gateforge/planes.json'), { force: true });
        const prerequisite = await runCli(repo, ['init', '--planes']);
        expect(prerequisite.code, `init --planes exited ${prerequisite.code}`).toBe(0);
        expect(existsSync(join(repo.root, '.gateforge/planes.json'))).toBe(true);
        const run = await runCli(repo, parsePrintedCommand(command).slice(1));
        expect(run.code, `${command} exited ${run.code}: ${run.stderr}`).not.toBe(2);
      }
    });
  });

});

describe('gateforge next: behavior ranking (plan §5)', () => {
  it('ranks ENDPOINT_BEHAVIOR_MISSING (rank 2) above test-mapping advice (rank 8)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // A discovered HTTP endpoint: the fixture plugin gains one
      // http.contract fact so the endpoint compiler inventories a route.
      const pluginPath = join(repo.root, 'plugin.mjs');
      const plugin = readFileSync(pluginPath, 'utf8');
      const endpointFact = `
      const httpResource = {
        schemaVersion: 1,
        kind: 'http.contract',
        source: 'src/http.ts',
        location: { file: 'src/http.ts', line: 1, col: 0 },
        detectorVersion: '1.0.0',
        attributes: { role: 'server-route', method: 'POST', normalizedPath: '/accounts', rawPath: '/accounts', framework: 'express', handlerSymbol: 'accountsHandler' },
        id: 'http.contract:test',
      };
`;
      const patched = plugin.replace(
        'return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
        `${endpointFact}
        resources.push(httpResource);
        return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };`,
      );
      repo.writeFiles({ 'plugin.mjs': patched });
      // Enable the complete-behavior profile with an empty owner document:
      // every discovered endpoint blocks with ENDPOINT_BEHAVIOR_MISSING.
      repo.writeFiles({
        '.gateforge/behavior.yml': 'schemaVersion: 1\nendpoints: []\nresources: []\n',
      });
      const config = readFileSync(join(repo.root, '.gateforge.yml'), 'utf8');
      repo.writeFiles({
        '.gateforge.yml': config.replace(
          'policies:',
          'behaviorPolicy: .gateforge/behavior.yml\npolicies:',
        ),
      });
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      expect(stdout).toContain('ENDPOINT_BEHAVIOR_MISSING');
      // The behavior declaration gap outranks mapping/test advice: the
      // printed action is the owner declaration, not overlay generation.
      expect(stdout).toContain('Owner defines endpoint behavior');
      expect(stdout).not.toContain('tests/e2e/gateforge');
    });
  });
  it('never recommends rerunning check for a classifier-blocked resource', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ 'src/mystery.txt': 'mystery fixture.table\n' });
      const pluginPath = join(repo.root, 'plugin.mjs');
      const plugin = readFileSync(pluginPath, 'utf8').replace(
        "signal('plane', 'tenant');",
        "if (name !== 'mystery') signal('plane', 'tenant');",
      );
      repo.writeFiles({ 'plugin.mjs': plugin });

      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      expect(stdout).toContain('cause: BLOCKING_FINDING');
      expect(stdout).not.toContain('Run `gateforge check`');
      const action = stdout.match(/^do: (.+)$/m)?.[1] ?? '';
      expect(action.startsWith('gateforge ') || action.includes('exact file')).toBe(true);
    });
  });

  it('keeps the original JSON report contract fields and cause vocabulary', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as {
        schemaVersion: number;
        summary: Record<string, number>;
        verdicts: Array<Record<string, unknown>>;
        blocking: Array<Record<string, unknown>>;
      };
      expect(Object.keys(report).filter((key) => key !== 'engine').sort()).toEqual([
        'blocking',
        'cache',
        'diagnosticContext',
        'run',
        'schemaVersion',
        'scope',
        'summary',
        'verdicts',
        'waiverCounts',
      ]);
      expect(Object.keys(report.summary).sort()).toEqual([
        'blocking',
        'blockingEntries',
        'invalid',
        'missing',
        'obligations',
        'satisfied',
        'stale',
        'unclassified',
        'unresolved',
        'waived',
      ]);
      expect(Object.keys(report.verdicts[0] ?? {}).filter((key) => key !== 'message').sort()).toEqual([
        'cause',
        'contract',
        'detector',
        'fingerprint',
        'nextAction',
        'obligationId',
        'policyId',
        'reason',
        'recordIds',
        'resourceId',
        'trustTier',
        'verdict',
      ]);
      expect(report.verdicts.every((item) => item.cause === 'TEST_MAPPING_MISSING')).toBe(true);
      expect(report.blocking).toEqual([]);
    });
  });
});
