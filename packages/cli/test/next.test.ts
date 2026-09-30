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
  PLUGIN_SOURCE,
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

  it('a tracked DIRECTORY symlink does not block the run (F2)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // The same template shape after the project's own bootstrap: the
      // checked-in link now resolves to a directory.
      mkdirSync(join(repo.root, '.venv/lib/python3.14/site-packages/fastapi'), {
        recursive: true,
      });
      mkdirSync(join(repo.root, '.agents/skills'), { recursive: true });
      symlinkSync(
        '../../.venv/lib/python3.14/site-packages/fastapi',
        join(repo.root, '.agents/skills/fastapi'),
      );
      repo.git(['add', '-A']);
      repo.git([
        '-c', 'user.name=fixture',
        '-c', 'user.email=fixture@gateforge.invalid',
        'commit', '--quiet', '-m', 'directory skill link',
      ]);
      const { code, stdout, stderr } = await runCli(repo, ['next']);
      expect(stderr).not.toContain('unsupported input snapshot');
      expect(code).toBe(1);
      expect(stdout).toContain('next:');
      // One plain notice line, and it says no action is needed: the link
      // works as it stands and nothing was read through it.
      expect(stdout).toContain('directory symlink');
      expect(stdout).toContain('.agents/skills/fastapi');
      expect(stdout).toContain('no action needed');
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

  it('explains the first real question before asking it (F8)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
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
      const result = await runCli(repo, ['next']);
      expect(result.code).toBe(1);
      const lines = result.stdout.split('\n');
      const questionIndex = lines.findIndex((line) => line.startsWith('question: '));
      expect(questionIndex).toBeGreaterThan(0);
      // ONE plain line, immediately BEFORE the question, that says what
      // is asked, why it cannot be read from the code, and what each
      // answer does.
      const explanation = lines[questionIndex - 1] ?? '';
      expect(lines.slice(0, questionIndex).filter((line) => line.startsWith('about this question'))).toHaveLength(1);
      expect(explanation.startsWith('about this question: ')).toBe(true);
      expect(explanation).toContain('no data plane');
      for (const answer of ['tenant', 'master', 'global']) {
        expect(explanation).toContain(answer);
      }
      expect(explanation).toContain('classify plane');
      expect(explanation).toContain('internal rule');
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

/**
 * The standard fixture plugin, extended so ONE resource also carries the
 * additive `singletonPerTenant` fact the sqlalchemy pack mints for a
 * table whose UNIQUE constraint admits one row per tenant.
 */
const SINGLETON_PLUGIN_SOURCE = PLUGIN_SOURCE.replace(
  "attributes: { resourceName: name },",
  `attributes: {
            resourceName: name,
            ...(name === 'ledger'
              ? {
                  singletonPerTenant: {
                    constraint: 'uq_ledger_tenant_ledger_kind',
                    tenantColumn: 'tenant_id',
                    columns: ['tenant_id', 'ledger', 'kind'],
                  },
                }
              : {}),
          },`,
);

/**
 * The standard fixture plugin with the `ledger` resource declared as the
 * background task resource a queue delivers to — the discovery half of
 * what makes the `task` pack gradable.
 */
const TASK_RESOURCE_PLUGIN_SOURCE = PLUGIN_SOURCE.replace(
  "attributes: { resourceName: name },",
  `attributes: { resourceName: name, ...(name === 'ledger' ? { queue: 'mailer' } : {}) },`,
);

/**
 * The exact `gateforge next` stdout of the standard fixture, captured
 * from the pre-change build. A repository with no per-tenant singleton
 * must keep it byte for byte.
 */
const FIXTURE_NEXT_OUTPUT_WITHOUT_SINGLETON = "next: tenant.accounts:persistence:read\ncause: TEST_MAPPING_MISSING\nwhy: no claim declares 'tenant.accounts:persistence:read'\ndo: Overlay: write `tests/e2e/gateforge/<resource>.<op>.spec.js`. Do not `tests mark` as a fix — that cannot satisfy the obligation.\n";

describe('gateforge next: the task pack offer and the singleton guidance', () => {
  it('without a singleton fact, next output is byte-identical to the pre-change output', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      expect(stdout).toBe(FIXTURE_NEXT_OUTPUT_WITHOUT_SINGLETON);
      // The JSON contract is unchanged too: the new keys are omitted
      // entirely when they have nothing to say.
      const json = await runCli(repo, ['next', '--json']);
      const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
      expect(parsed['singletonGuidance']).toBeUndefined();
      expect(parsed['taskPackOffer']).toBeUndefined();
    });
  });

  it('with a singleton fact, next prints the guidance lines and names the resource', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'plugin.mjs': SINGLETON_PLUGIN_SOURCE,
        'src/ledger.txt': 'ledger fixture.table\n',
        '.gateforge/adapters/ledger.mjs': 'export default {};\n',
      });
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      // The guidance is the SAME sentence `check` renders as an advisory,
      // so the two surfaces can never disagree.
      const line = stdout
        .split('\n')
        .find((candidate) => candidate.includes('is a singleton per tenant'));
      expect(line).toBeDefined();
      expect(line).toContain("'tenant.ledger'");
      expect(line).toContain('uq_ledger_tenant_ledger_kind unique(tenant_id, ledger, kind)');
      expect(line).toContain("'tenant_id'");
      expect(line).toContain('POST /sessions/identity');
      // The next action itself is unchanged — the guidance is additive.
      expect(stdout.startsWith('next: tenant.accounts:persistence:read\n')).toBe(true);
      const json = await runCli(repo, ['next', '--json']);
      const parsed = JSON.parse(json.stdout) as { singletonGuidance: string[] };
      expect(parsed.singletonGuidance).toHaveLength(1);
      expect(parsed.singletonGuidance[0]).toContain('is a singleton per tenant');
    });
  });

  it('without a queueObserver, next offers no task pack even with a task resource', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'plugin.mjs': TASK_RESOURCE_PLUGIN_SOURCE,
        'src/ledger.txt': 'ledger task.resource\n',
        '.gateforge/adapters/ledger.mjs': 'export default {};\n',
      });
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      expect(stdout).not.toContain('gateforge init --behavior-packs task');
      expect(stdout).toBe(
        'next: tenant.accounts:persistence:read\ncause: TEST_MAPPING_MISSING\nwhy: no claim declares ' +
          "'tenant.accounts:persistence:read'\ndo: Overlay: write `tests/e2e/gateforge/<resource>.<op>.spec.js`. " +
          'Do not `tests mark` as a fix — that cannot satisfy the obligation.\n',
      );
    });
  });

  it('with a queueObserver, next offers the task pack the way init names it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'plugin.mjs': TASK_RESOURCE_PLUGIN_SOURCE,
        'src/ledger.txt': 'ledger task.resource\n',
        '.gateforge/adapters/ledger.mjs': 'export default {};\n',
        '.gateforge.yml':
          readFileSync(join(repo.root, '.gateforge.yml'), 'utf8') +
          `queueObserver:
  kind: bullmq
  connection:
    urlEnv: GATEFORGE_TEST_REDIS_URL
  queues:
    - name: mailer
      taskResourceId: tenant.ledger
`,
      });
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      expect(stdout).toContain('the task behavior pack is gradable in this repository');
      expect(stdout).toContain("'tenant.ledger' is a discovered task resource");
      expect(stdout).toContain('  gateforge init --behavior-packs task');
    });
  });
});
