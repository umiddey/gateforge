/**
 * `endpoints.unmatchedRoutes` (0.9.0, owner decision D7).
 *
 * The endpoint compiler reports a by-id route whose path-derived
 * resource name names no discovered business resource. On a large
 * existing repository that is dozens of honest findings, and blocking
 * on all of them turns an upgrade into a wall of commits the owner never
 * agreed to gate on. The owner decides:
 *
 * - ABSENT (an existing repository that upgraded): advisory, never
 *   blocking, and LOUD — `check` and `next` print a banner naming the
 *   count, the examples and the exact key that turns blocking on.
 * - `warn`: the same, once the owner has said so.
 * - `block`: today's strict behavior.
 *
 * The fixture is the real engine path: an in-process detector plugin
 * emitting one by-id `http.contract` route with no matching business
 * resource, a `consumed: true` policy (no frontend call, so no
 * obligations), and an answered plane rule. The ONLY thing this run can
 * block on is the unmatched-route entry — so an exit code of 0 here IS
 * the behavior under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import type { BlockingEntry } from '@gate-forge/core';
import {
  partitionUnmatchedRouteEntries,
  unmatchedRouteBannerLines,
  unmatchedRoutesMode,
} from '../src/unmatched-routes.js';
import { configYml, runCli } from './helpers.js';
import { existsSync } from 'node:fs';

/** One unmatched by-id route: `logs` names no discovered resource. */
const PLUGIN_SOURCE = `export default {
  discover(paths) {
    const at = (file, line) => ({ file, line, col: 0 });
    return {
      resources: [
        {
          schemaVersion: 1,
          id: 'http.contract:backend/api/v1/reports.py:app.get_report_log:GET:/api/v1/reports/logs/{}',
          kind: 'http.contract',
          source: 'backend/api/v1/reports.py',
          location: at('backend/api/v1/reports.py', 12),
          detectorVersion: '1.0.0',
          attributes: {
            role: 'server-route',
            method: 'GET',
            normalizedPath: '/api/v1/reports/logs/{}',
            rawPath: '/api/v1/reports/logs/{log_id}',
            framework: 'test',
            handlerSymbol: 'app.get_report_log',
            responseSchemaSymbols: ['ReportLogOut'],
          },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [],
      scannedPaths: [...paths],
    };
  },
};
`;

const POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: frontend-consumed-endpoints-transport-only
    when:
      kind: http.endpoint
      consumed: true
    require:
      - http:request-observed
`;

const CLASSIFICATION_POLICY_YML = `\
schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
`;

/**
 * The plane answer, as the `planes:` SECTION of the owner-answers
 * document. Since 0.11.0 it is no longer a `.gateforge/planes.json` file.
 */
const PLANES_SECTION = `planes:
  rules:
    - match: backend/api/v1/**
      plane: tenant
      reason: tenant router tree
`;

/**
 * Installs the fixture repository, optionally declaring the owner's
 * unmatched-route grading in `.gateforge.yml` (absent = the upgraded
 * repository).
 */
function installRepo(repo: TempRepo, endpointsBlock: string): void {
  repo.writeFiles({
    '.gateforge.yml': `${configYml({ include: "['backend/**/*.py']" })}${endpointsBlock}`,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': `${CLASSIFICATION_POLICY_YML}${PLANES_SECTION}`,
    'plugin.mjs': PLUGIN_SOURCE,
    'backend/api/v1/reports.py': '# router fixture\n',
  });
}

const WARN_BLOCK = 'endpoints:\n  unmatchedRoutes: warn\n';
const BLOCK_BLOCK = 'endpoints:\n  unmatchedRoutes: block\n';

interface Report {
  summary: { blocking: number };
  blocking: Array<{ kind: string; detail?: string }>;
  advisories?: Array<{ kind: string; detail?: string }>;
}

describe('unmatched by-id routes: the owner decides whether they block', () => {
  it('an ABSENT setting keeps them advisory, exits 0, and prints the banner', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, '');
      const run = await runCli(repo, ['check']);
      // Before the setting existed, this entry was a blocking entry: exit 1.
      expect(run.code, run.stdout).toBe(0);
      // Loud: the banner names the count, the example and the exact key.
      expect(run.stdout).toContain('1 by-id route whose name matches no discovered resource');
      expect(run.stdout).toContain('REPORTED, NOT BLOCKING');
      expect(run.stdout).toContain('you have not chosen block or warn');
      expect(run.stdout).toContain('unmatchedRoutes: block');
      const json = await runCli(repo, ['check', '--format', 'json']);
      const report = JSON.parse(json.stdout) as Report;
      expect(json.code, json.stdout).toBe(0);
      // Reported under the SAME code, in the advisory channel.
      expect(report.summary.blocking).toBe(0);
      const advisories = report.advisories ?? [];
      expect(advisories).toHaveLength(1);
      expect(advisories[0]?.detail).toContain('ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED');
      expect(report.blocking.some((entry) => (entry.detail ?? '').includes('CANDIDATE_UNMATCHED'))).toBe(false);
    });
  });

  it('never blocks a changed slice (check --changed) with the setting absent', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, '');
      const run = await runCli(repo, ['check', '--changed', '--format', 'json']);
      const report = JSON.parse(run.stdout) as Report;
      expect(run.code, run.stdout).toBe(0);
      expect(report.blocking.some((entry) => (entry.detail ?? '').includes('CANDIDATE_UNMATCHED'))).toBe(false);
      expect((report.advisories ?? []).length).toBe(1);
    });
  });

  it('warn behaves exactly like absent, minus the "you have not chosen" sentence', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, WARN_BLOCK);
      expect(loadConfig(repo.path('.gateforge.yml')).endpoints?.unmatchedRoutes).toBe('warn');
      const run = await runCli(repo, ['check']);
      expect(run.code, run.stdout).toBe(0);
      expect(run.stdout).toContain('REPORTED, NOT BLOCKING');
      expect(run.stdout).not.toContain('you have not chosen');
      expect(run.stdout).toContain('unmatchedRoutes: block');
      const json = await runCli(repo, ['check', '--format', 'json']);
      expect((JSON.parse(json.stdout) as Report).advisories ?? []).toHaveLength(1);
    });
  });

  it('block restores the strict behavior: a blocking entry and exit 1', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, BLOCK_BLOCK);
      const json = await runCli(repo, ['check', '--format', 'json']);
      const report = JSON.parse(json.stdout) as Report;
      expect(json.code, json.stdout).toBe(1);
      expect(report.blocking.some((entry) => (entry.detail ?? '').includes('CANDIDATE_UNMATCHED'))).toBe(true);
      // Not also an advisory: one channel per entry.
      expect((report.advisories ?? []).some((e) => (e.detail ?? '').includes('CANDIDATE_UNMATCHED'))).toBe(false);
      // And no banner: nothing was demoted.
      const text = await runCli(repo, ['check']);
      expect(text.code, text.stdout).toBe(1);
      expect(text.stdout).not.toContain('REPORTED, NOT BLOCKING');
    });
  });

  it('next prints the banner on a clean run and still says the run is clean', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, '');
      const run = await runCli(repo, ['next']);
      expect(run.code, run.stdout).toBe(0);
      expect(run.stdout).toContain('REPORTED, NOT BLOCKING');
      expect(run.stdout).toContain('unmatchedRoutes: block');
      expect(run.stdout).toContain('next: none — clean');
    });
  });

  it('next names the entry as the next action once the owner chose block', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, BLOCK_BLOCK);
      const run = await runCli(repo, ['next']);
      expect(run.code, run.stdout).toBe(1);
      expect(run.stdout).toContain('CANDIDATE_UNMATCHED');
      expect(run.stdout).not.toContain('REPORTED, NOT BLOCKING');
    });
  });
});

describe('the partition and the banner', () => {
  function entry(detail: string, line: number): BlockingEntry {
    return {
      kind: 'unresolved',
      resourceId: null,
      name: null,
      detail,
      location: { file: 'backend/api/v1/reports.py', line, col: 0 },
    };
  }

  const UNMATCHED =
    "ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED: endpoint 'GET /api/v1/reports/logs/{}' derives resource name 'logs', which names no discovered business resource; closest discovered names: access_logs, import_logs (candidates, never links)";
  const OTHER = 'ENDPOINT_RESOURCE_LINK_UNRESOLVED: endpoint GET /api/v1/reports matches 2 resources';

  it('moves only this code, and only when the owner has not chosen block', () => {
    const blocking = [entry(UNMATCHED, 12), entry(OTHER, 20)];
    const absent = partitionUnmatchedRouteEntries(blocking, 'unchosen');
    expect(absent.blocking.map((item) => item.detail)).toEqual([OTHER]);
    expect(absent.advisories.map((item) => item.detail)).toEqual([UNMATCHED]);
    const warned = partitionUnmatchedRouteEntries(blocking, 'warn');
    expect(warned.blocking.map((item) => item.detail)).toEqual([OTHER]);
    const strict = partitionUnmatchedRouteEntries(blocking, 'block');
    expect(strict.blocking).toEqual(blocking);
    expect(strict.advisories).toEqual([]);
  });

  it('reads the mode from the config, and an absent key is unchosen', () => {
    expect(unmatchedRoutesMode({ endpoints: { unmatchedRoutes: 'block' } } as never)).toBe('block');
    expect(unmatchedRoutesMode({ endpoints: { unmatchedRoutes: 'warn' } } as never)).toBe('warn');
    expect(unmatchedRoutesMode({} as never)).toBe('unchosen');
  });

  it('the banner shows at most three examples, the rest by count, and the exact key', () => {
    const many = [1, 2, 3, 4, 5].map((line) => entry(UNMATCHED, line));
    const lines = unmatchedRouteBannerLines(many, 'warn');
    expect(lines.join('\n')).toContain(
      '5 by-id routes whose name matches no discovered resource are REPORTED, NOT BLOCKING',
    );
    // The near matches ride the compiler's own sentence.
    expect(lines.join('\n')).toContain('closest discovered names: access_logs, import_logs');
    expect(lines.join('\n')).toContain('backend/api/v1/reports.py:1');
    expect(lines.filter((line) => line.trim().startsWith('- endpoint'))).toHaveLength(3);
    expect(lines.join('\n')).toContain('and 2 more');
    expect(lines.join('\n')).toContain('unmatchedRoutes: block');
    expect(lines.join('\n')).not.toContain('you have not chosen');
    expect(unmatchedRouteBannerLines(many, 'unchosen').join('\n')).toContain('you have not chosen');
    // Nothing to say, nothing printed.
    expect(unmatchedRouteBannerLines([], 'unchosen')).toEqual([]);
  });
});

/** Answers the fake terminal serves, in prompt order. */
const { scriptedAnswers } = vi.hoisted(() => ({ scriptedAnswers: [] as string[] }));

describe('init asks once and writes the answer', () => {
  // `init` reads every answer through `createInterface` alone, so
  // replacing that one function keeps the real question order and the
  // real question strings under test. `vi.hoisted` allocates the answer
  // queue before the mocked module is first imported.
  vi.mock('node:readline/promises', () => ({
    createInterface: () => ({
      question: async () => scriptedAnswers.shift() ?? '',
      close: () => {},
    }),
  }));

  function useFakeTerminal(): void {
    for (const stream of [process.stdin, process.stdout]) {
      Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    }
  }

  beforeEach(() => {
    scriptedAnswers.length = 0;
  });

  afterEach(() => {
    for (const stream of [process.stdin, process.stdout]) {
      Object.defineProperty(stream, 'isTTY', { value: undefined, configurable: true });
    }
  });

  it('a headless init writes warn and prints the exact way to choose block', async () => {
    await withTempRepo({}, async (repo) => {
      const run = await runCli(repo, ['init', '--no-scan']);
      expect(run.code, run.stdout).toBe(0);
      expect(loadConfig(repo.path('.gateforge.yml')).endpoints?.unmatchedRoutes).toBe('warn');
      expect(run.stdout).toContain('routes whose name matches no table will be REPORTED, not blocking');
      expect(run.stdout).toContain('unmatchedRoutes: block');
      expect(run.stdout).toContain('--unmatched-routes block');
    });
  });

  it('--unmatched-routes block writes block, and an unknown value is a usage error', async () => {
    await withTempRepo({}, async (repo) => {
      const ok = await runCli(repo, ['init', '--no-scan', '--unmatched-routes', 'block']);
      expect(ok.code, ok.stdout).toBe(0);
      expect(loadConfig(repo.path('.gateforge.yml')).endpoints?.unmatchedRoutes).toBe('block');
    });
    await withTempRepo({}, async (repo) => {
      const bad = await runCli(repo, ['init', '--no-scan', '--unmatched-routes', 'loud']);
      expect(bad.code, bad.stdout).toBe(2);
      expect(bad.stderr).toContain("--unmatched-routes must be 'block' or 'warn'");
      // Nothing was written: an invalid choice is refused before any file.
      expect(existsSync(repo.path('.gateforge.yml'))).toBe(false);
    });
  });

  it('an interactive init asks once and writes the answer the owner gave', async () => {
    await withTempRepo({}, async (repo) => {
      useFakeTerminal();
      // Prompt order: goal, run-history retention, unmatched routes.
      scriptedAnswers.push('1', '14', 'block');
      const run = await runCli(repo, ['init', '--no-scan', '--accept-recommended']);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      // Asked once, in plain words, with both choices.
      expect(run.stdout.match(/Routes whose name matches no table/g)).toHaveLength(1);
      expect(run.stdout).toContain('[block/warn]');
      expect(loadConfig(repo.path('.gateforge.yml')).endpoints?.unmatchedRoutes).toBe('block');
    });
  });

  it('an interactive blank answer keeps the non-blocking default', async () => {
    await withTempRepo({}, async (repo) => {
      useFakeTerminal();
      scriptedAnswers.push('1', '14', '');
      const run = await runCli(repo, ['init', '--no-scan', '--accept-recommended']);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(loadConfig(repo.path('.gateforge.yml')).endpoints?.unmatchedRoutes).toBe('warn');
    });
  });

  it('an existing config that said nothing is left alone, and is never asked about', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ '.gateforge.yml': configYml({ include: "['backend/**/*.py']" }) });
      useFakeTerminal();
      // Only the goal question is asked: nothing about unmatched routes.
      scriptedAnswers.push('1');
      const run = await runCli(repo, ['init', '--no-scan', '--accept-recommended']);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).not.toContain('Routes whose name matches no table');
      expect(loadConfig(repo.path('.gateforge.yml')).endpoints).toBeUndefined();
    });
  });
});
