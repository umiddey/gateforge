/**
 * WP3 attribution proof (plan 2026-10-05 §5 D2/D4, §7.5): a REAL sealed
 * supervised run — `test-gates` with the evidence stub runner, the REAL
 * witness, the real drain, sealing and grading — grades a rule case
 * `satisfied (observe)` from the run's OWN authorized records, and the
 * failure modes stay honest:
 *
 * - the satisfied case is proved by the attribution join the evaluator
 *   performs: the sealed run's `sessionTrace` names the test's witness
 *   sessions, and a witnessed `http.request` record carries that session
 *   id in its payload — asserted here over the REAL run artifacts, not a
 *   mock of either side;
 * - before any run exists, the static gate grades the mapped cases
 *   `unproven` (a mapping is a declaration, never a proof), and after the
 *   run `check --require-e2e` grades the SAME cases satisfied from the
 *   sealed receipt;
 * - the same test mapped and FAILED (`__FAIL__`) grades both of the
 *   rule's cases `failing` — a red test is never forgiven — and a failing
 *   run seals no receipt;
 * - a named run that does not execute the mapped test grades the case
 *   `unproven` — visible, never satisfied, never silently absent;
 * - §7.6: a rule case mapped to a MOCKED spec (`page.route`, statically
 *   scanned by the playwright pack), to an owner-QUARANTINED test, or
 *   to a test nothing DECLARED (inference alone) never becomes
 *   satisfied — the mark is refused, the run grades unproven/unmapped,
 *   and the output names which of the three reasons bit.
 *
 * The stub runner plays the suite-side role the real `@gate-forge/
 * pack-playwright` fixture plays in a browser run — resolve the
 * supervisor-opened session, drive traffic through that session's
 * observation proxy, claim the observed exchange — so everything above
 * it (drain, witness, supervision, authorization, grading) is the
 * product's own code. What the stub cannot do is lie about WHICH files
 * it was asked to run, or mint a session: sessions are opened only by
 * the verifier-key drain, and the claim consumes an exchange the
 * session's own proxy captured inside a recorded interval.
 *
 * The rule's test is the fixture's third evidence spec (`invoices`),
 * declared `observed-e2e` — the only entry claiming the invoices
 * obligation, so no cross-entry kind conflict — whose obligation is
 * owner-waived: the Observe channel wiring (session proxy) is what the
 * rule proof needs; the obligation's own persistence answer is recorded
 * debt, not this suite's subject.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceRecordSchema, loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { answersYml, businessRule, configYml, fixtureFingerprint, installFixture, PLUGIN_SOURCE, runCli, stubPlaywrightFiles } from './helpers.js';
import {
  DEFAULT_EVIDENCE_NAMES,
  VERIFIER_KEY,
  evidenceAdapter,
  evidenceKeys,
  evidenceSpecTable,
  evidenceSpecs,
  evidenceTestMap,
  startEvidenceApp,
  stateRecords,
} from './reseal-e2e-fixture.js';

/** All three evidence specs; the third carries the rule's cases. */
const NAMES = [...DEFAULT_EVIDENCE_NAMES, 'invoices'] as const;

const RULE_FILE = 'e2e/invoices.spec.mjs';
const RULE_TITLE = 'reads an invoice';
/** The catalog logical key of that test (the sidecar identity `tests mark` writes). */
const RULE_KEY = `playwright:chromium:${RULE_FILE}:${RULE_TITLE}`;
const ACCOUNT_RULE_KEY = 'playwright:chromium:e2e/accounts.spec.mjs:reads an account';

/** The two-case invoice rule the fixture declares. */
const RULE = businessRule({
  id: 'invoices-stay-readable',
  title: 'An issued invoice stays readable through the real app',
  subject: 'invoices',
  cases: [
    { id: 'read-after-issue', describe: 'The invoice issued by the journey is still readable afterwards' },
    { id: 'read-shows-fields', describe: 'Reading the invoice renders the fields the journey entered' },
  ],
});

const CLAIM_AFTER = 'business-rule:invoices-stay-readable/read-after-issue';
const CLAIM_FIELDS = 'business-rule:invoices-stay-readable/read-shows-fields';

/** The proxied path the observe phase drives and claims (never a real app route). */
const PROBE_PATH = '/invoices-after-issue';

/** One serialized case of a report's `businessRules` section. */
interface RuleSectionEntry {
  ruleId: string;
  caseId: string;
  status: string;
  channel: string | null;
  enforcement: string;
  mappedTests: readonly string[];
  finding: { cause: string; detail: string; tests: readonly string[] } | null;
}

interface Report {
  summary: { blocking: number };
  blocking: Array<{ cause: string | null; name: string | null; detail: string }>;
  businessRules?: RuleSectionEntry[];
}

/** The invoices spec without the persistence-intent marker (no intent is forwarded for it). */
function ruleSpec(specOverrides: Record<string, string> = {}): string {
  const override = specOverrides[RULE_FILE];
  if (override !== undefined) return override;
  const generated = evidenceSpecs(NAMES)[RULE_FILE] ?? '';
  const [beforeMarker] = generated.split('\n// __EVIDENCE__');
  return `${(beforeMarker ?? generated).trimEnd()}\n`;
}

/** The sidecar entries for the invoice journey and optional second rule test. */
function observeTestMap(secondRuleTest = false): string {
  const secondRuleMapping = secondRuleTest
    ? [
        '  - key: playwright:chromium:e2e/accounts.spec.mjs:reads an account',
        '    selector:',
        '      runner: playwright',
        '      file: e2e/accounts.spec.mjs',
        '      titlePath:',
        '        - reads an account',
        '    kind: observed-e2e',
        '    claims:',
        `      - ${CLAIM_AFTER}`,
        '    reason: the account journey also claims the unpaid invoice case',
      ]
    : [];
  return [
    evidenceTestMap(['accounts', 'orders']),
    ...secondRuleMapping,
    '  - key: ' + RULE_KEY,
    '    selector:',
    '      runner: playwright',
    `      file: ${RULE_FILE}`,
    '      titlePath:',
    `        - ${RULE_TITLE}`,
    '    kind: observed-e2e',
    '    claims:',
    '      - tenant.invoices:persistence:read',
    `      - ${CLAIM_AFTER}`,
    `      - ${CLAIM_FIELDS}`,
    '    reason: the journey claims the read obligation and both rule cases through its own proxied traffic',
    '',
  ].join('\n');
}

/** The owner waiver that records the invoices obligation's persistence answer as accepted debt. */
function invoicesWaiver(): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      owner: 'team',
      justificationUrl: 'https://example.invalid/justification',
      approver: 'approver@example.invalid',
      scope: {
        kind: 'exact',
        resourceId: 'tenant.invoices',
        fingerprint: fixtureFingerprint('tenant.invoices'),
      },
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
    null,
    2,
  )}\n`;
}

/**
 * The evidence stub runner with the fixture-side observe work added for
 * the invoice test, INLINE in the serial worker-0 lifecycle: begin event
 * first (the drain opens that test's witness session from it), then
 * resolve → interval → proxied traffic → http-observation claim →
 * interval close, and only then the end event — so the worker slot
 * discipline is exactly a genuine serial run's. The persistence intents,
 * outcomes and ledger copy are byte-for-byte the shared fixture's
 * behavior.
 *
 * The bounded 25 ms retry loops live in the CHILD PROCESS this string
 * spawns, not in the test: the awaited condition is the drain's own
 * spool handling in another node process, so no in-process fake timer
 * or awaitable signal exists — the loop is the await, and it is bounded.
 */
function observeStubCli(observeClaims: readonly string[] = [CLAIM_AFTER, CLAIM_FIELDS]): string {
  const titles = Object.fromEntries(evidenceSpecTable(NAMES).map((row) => [`e2e/${row.name}.spec.mjs`, row.title]));
  return [
    "const { readFileSync, writeFileSync, appendFileSync, mkdirSync } = require('node:fs');",
    'const argv = process.argv.slice(2);',
    `const files = ${JSON.stringify(Object.keys(evidenceSpecs(NAMES)))};`,
    `const titles = ${JSON.stringify(titles)};`,
    `const keys = ${JSON.stringify(evidenceKeys(NAMES))};`,
    `const observeFile = ${JSON.stringify(RULE_FILE)};`,
    `const probePath = ${JSON.stringify(PROBE_PATH)};`,
    `const observeClaims = ${JSON.stringify(observeClaims)};`,
    "if (argv.includes('--list')) {",
    '  process.stdout.write(JSON.stringify({',
    '    config: { rootDir: process.cwd() },',
    '    suites: files.map((file) => ({',
    '      file,',
    '      specs: [{',
    '        id: file,',
    '        title: titles[file],',
    '        line: 2,',
    '        column: 0,',
    "        tests: [{ projectId: 'chromium', projectName: 'chromium', expectedStatus: 'passed', annotations: [] }],",
    '      }],',
    '    })),',
    '  }));',
    '} else {',
    "  const config = readFileSync(argv[argv.indexOf('--config') + 1], 'utf8');",
    '  const selected = JSON.parse(/testMatch: (\\[[^\\]]*\\])/.exec(config)[1]);',
    '  const reporter = /"stateDir":"([^"]+)","runId":"([^"]+)","outcomesPath":"([^"]+)"/.exec(config);',
    '  const stateDir = reporter[1];',
    '  const runId = reporter[2];',
    "  const spool = stateDir + '/spool/' + runId;",
    '  mkdirSync(spool, { recursive: true });',
    "  const fails = (file) => readFileSync(file, 'utf8').includes('__FAIL__');",
    '  const begin = (file) => ({ kind: "testBegin", testId: file, workerIndex: 0, file, titlePath: [titles[file]], project: "chromium" });',
    '  const end = (file) => ({ kind: "testEnd", testId: file, workerIndex: 0, file, titlePath: [titles[file]], project: "chromium", outcome: fails(file) ? "failed" : "passed", attempt: 1 });',
    '  const url = process.env.GATEFORGE_WITNESS_URL;',
    '  const token = process.env.GATEFORGE_RUN_TOKEN;',
    '  const post = async (path, body) => {',
    '    const response = await fetch(url + path, { method: "POST", headers: { "x-gateforge-run": token, "content-type": "application/json" }, body: JSON.stringify(body) });',
    '    if (!response.ok) throw new Error(path + " answered " + String(response.status));',
    '    return response.json();',
    '  };',
    '  const observeWork = async (file) => {',
    '    if (url === undefined || token === undefined) return;',
    '    let session = null;',
    '    for (let attempt = 0; attempt < 400; attempt += 1) {',
    '      try { session = await post("/sessions/resolve", { testId: file, workerIndex: 0 }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }',
    '    }',
    '    if (session === null || session.proxyUrl === null) return;',
    '    const interval = await post("/sessions/intervals/open", { sessionId: session.sessionId, sessionToken: session.sessionToken, operation: "read" });',
    '    await fetch(session.proxyUrl + probePath);',
    '    await post("/witness/http-observation", { claimIds: observeClaims, testId: file, method: "GET", path: probePath, sessionId: session.sessionId, sessionToken: session.sessionToken });',
    '    await post("/sessions/intervals/close", { sessionId: session.sessionId, sessionToken: session.sessionToken, intervalId: interval.intervalId });',
    '  };',
    '  (async () => {',
    '    const intents = [];',
    '    for (const file of selected) {',
    '      const declared = /__EVIDENCE__ (tenant\\.[a-z]+)/.exec(readFileSync(file, "utf8"));',
    '      if (declared !== null) {',
    '        intents.push({',
    '          entity: declared[1],',
    '          operation: "read",',
    '          phase: "post",',
    '          intent: "expect-present",',
    '          key: "acc-1",',
    '          claimId: declared[1] + ":persistence:read",',
    '          testId: keys[file],',
    '          sequence: 1,',
    '        });',
    '      }',
    '      appendFileSync(spool + "/events.jsonl", JSON.stringify(begin(file)) + "\\n");',
    '      if (file === observeFile) await observeWork(file);',
    '      appendFileSync(spool + "/events.jsonl", JSON.stringify(end(file)) + "\\n");',
    '    }',
    '    writeFileSync(spool + "/persistence-intents.jsonl", intents.map((intent) => JSON.stringify(intent)).join("\\n") + "\\n");',
    '    writeFileSync(reporter[3], JSON.stringify({',
    '      schemaVersion: 1,',
    '      runStatus: selected.some(fails) ? "failed" : "passed",',
    '      runnerErrors: [],',
    '      shard: null,',
    '      outcomes: selected.map((file) => ({',
    '        testId: file,',
    '        file,',
    '        titlePath: [titles[file]],',
    '        project: "chromium",',
    '        status: fails(file) ? "failed" : "passed",',
    '        attempt: 1,',
    '        expectedFailure: false,',
    '      })),',
    '    }));',
    '    const copyLedger = async () => {',
    '      if (url === undefined || token === undefined) return;',
    '      for (let attempt = 0; attempt < 200; attempt += 1) {',
    '        const response = await fetch(url + "/records", { headers: { "x-gateforge-run": token } });',
    '        const body = await response.json();',
    '        if (Array.isArray(body.records) && body.records.length >= intents.length) {',
    '          writeFileSync(stateDir + "/records.json", JSON.stringify(body.records, null, 2) + "\\n");',
    '          return;',
    '        }',
    '        await new Promise((resolve) => setTimeout(resolve, 25));',
    '      }',
    '    };',
    '    await copyLedger();',
    '  })();',
    '}',
    '',
  ].join('\n');
}

/**
 * The evidence repository carrying the rule: the standard fixture plus
 * three evidence specs (the invoice spec without the persistence marker),
 * attested adapters, the observe-extended stub runner, the rule-extended
 * sidecar and the owner waiver for the invoice obligation.
 *
 * `options.scanSpecs` extends the closed-world scan roots with the
 * invoice SPEC FILE itself, so the playwright pack statically scans it
 * (a real spec file the pack parses — not a stub-listed row) and its
 * catalog row carries the static facts: inference signals AND, when the
 * spec intercepts the network, the mock signal. The fixture plugin skips
 * those scanned spec paths (a language plugin would never read a
 * playwright spec as a resource), so the scan adds no junk resources.
 */
function installObserveRepo(
  repo: TempRepo,
  appUrl: string,
  specOverrides: Record<string, string> = {},
  options: { scanSpecs?: boolean; observeClaims?: readonly string[]; secondRuleTest?: boolean } = {},
): void {
  installFixture(repo);
  repo.writeFiles({
    ...(Object.fromEntries(
      Object.entries(evidenceSpecs(NAMES, true)).map(([file, body]) => [
        file,
        file === RULE_FILE ? ruleSpec(specOverrides) : (specOverrides[file] ?? (body as string)),
      ]),
    )),
    ...Object.fromEntries(NAMES.map((name) => [`src/${name}.txt`, `${name} fixture.table\n`])),
    ...Object.fromEntries(NAMES.map((name) => [`.gateforge/adapters/${name}.mjs`, evidenceAdapter(appUrl)])),
    '.gateforge/test-map.yml': observeTestMap(options.secondRuleTest === true),
    '.gateforge/waivers/invoices.json': invoicesWaiver(),
    '.gateforge/classification-policy.yml': answersYml([RULE]),
    '.gateforge.yml': `mode: changed\n${configYml(
      options.scanSpecs === true ? { include: "['src/**/*.txt', 'e2e/invoices.spec.mjs']" } : {},
    )}`,
    ...(options.scanSpecs === true
      ? {
          // The spec file rides the scan roots, so the fixture plugin
          // receives it with everything else; a real detector would not
          // read a playwright spec as a business resource, and neither
          // does this one.
          'plugin.mjs': PLUGIN_SOURCE.replace(
            'for (const rel of paths) {',
            "for (const rel of paths) {\n      if (rel.startsWith('e2e/')) continue;",
          ),
        }
      : {}),
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    ...stubPlaywrightFiles(observeStubCli(options.observeClaims)),
    '.gitignore': '.gateforge/test-gates/\nnode_modules/\n',
  });
}

/** The environment the run and the later check share. */
function gateEnv(repo: TempRepo, appUrl: string): Record<string, string> {
  return {
    GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
    GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml'))),
    CI_MERGE_REQUEST_DIFF_BASE_SHA: repo.headSha() as string,
    GATEFORGE_APP_BASE_URL: appUrl,
  };
}

/** The persisted sealed execution result of the run that just finished. */
function sealedExecutionRaw(repo: TempRepo): {
  sessionTrace?: Array<{ file: string; titlePath: string[]; sessions: Array<{ sessionId: string }> }>;
} {
  return JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/execution-result.json'), 'utf8')) as {
    sessionTrace?: Array<{ file: string; titlePath: string[]; sessions: Array<{ sessionId: string }> }>;
  };
}

describe('§7.5 a real sealed run grades the rule from its own authorized records', () => {
  it('satisfies both cases through the observe channel, attributed to the test session', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installObserveRepo(repo, app.url);
        repo.commitFiles({}, 'base');
        const env = gateEnv(repo, app.url);

        // Before any run exists, the static gate grades the mapped cases
        // `unproven` — a mapping is a declaration, never a proof.
        const staticCheck = await runCli(repo, ['check', '--require-e2e', '--format', 'json'], env);
        const staticReport = JSON.parse(staticCheck.stdout) as Report;
        expect(staticReport.businessRules?.map((entry) => entry.status)).toEqual(['unproven', 'unproven']);
        expect(
          staticReport.businessRules?.every((entry) =>
            entry.finding?.detail.includes('no sealed supervised run exists yet'),
          ),
        ).toBe(true);

        const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.code, output).toBe(0);
        const report = JSON.parse(run.stdout) as Report;
        expect(report.summary.blocking, output).toBe(0);
        expect(report.businessRules, output).toEqual([
          {
            ruleId: 'invoices-stay-readable',
            caseId: 'read-after-issue',
            test: 'e2e',
            enforcement: 'block',
            status: 'satisfied',
            channel: 'observe',
            mappedTests: [RULE_KEY],
            finding: null,
          },
          {
            ruleId: 'invoices-stay-readable',
            caseId: 'read-shows-fields',
            test: 'e2e',
            enforcement: 'block',
            status: 'satisfied',
            channel: 'observe',
            mappedTests: [RULE_KEY],
            finding: null,
          },
        ]);

        // THE ATTRIBUTION, over the run's real artifacts: the sealed
        // session trace names the invoice test's witness sessions, and
        // the authorized ledger carries one http.request record per
        // claimed case whose payload names one of THOSE sessions.
        const execution = sealedExecutionRaw(repo);
        const trace = (execution.sessionTrace ?? []).find((entry) => entry.file === RULE_FILE);
        expect(trace, output).toBeDefined();
        const sessionIds = (trace?.sessions ?? []).map((session) => session.sessionId);
        expect(sessionIds.length, output).toBeGreaterThan(0);
        const attributed = stateRecords(repo)
          .map((record) => EvidenceRecordSchema.safeParse(record))
          .filter((parsed) => parsed.success)
          .flatMap((parsed) => {
            const payload = parsed.data.payload;
            if (parsed.data.kind !== 'http.request') return [];
            if (typeof payload !== 'object' || payload === null || !('sessionId' in payload)) return [];
            const sessionId = payload.sessionId;
            if (typeof sessionId !== 'string' || !sessionIds.includes(sessionId)) return [];
            return [[parsed.data.obligationId, sessionId] as const];
          });
        expect(attributed.map(([obligationId]) => obligationId).sort(), output).toEqual(
          [CLAIM_AFTER, CLAIM_FIELDS].sort(),
        );
        // Both claims were consumed from the ONE session the drain
        // opened for this test — the join is per-session, not per-test.
        const recordSessions = attributed.map(([, sessionId]) => sessionId);
        expect(recordSessions, output).not.toHaveLength(0);
        expect(recordSessions.every((sessionId) => sessionId === recordSessions[0]), output).toBe(true);

        // The same grading through the commit gate, from the sealed
        // receipt's facts: satisfied there too, exit 0.
        const check = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
        const checkOutput = `${check.stdout}\n${check.stderr}`;
        expect(check.code, checkOutput).toBe(0);
        const checkReport = JSON.parse(check.stdout) as Report;
        expect(
          checkReport.businessRules?.map((entry) => [entry.caseId, entry.status, entry.channel]),
          checkOutput,
        ).toEqual([
          ['read-after-issue', 'satisfied', 'observe'],
          ['read-shows-fields', 'satisfied', 'observe'],
        ]);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('grades every case the failed test touches failing, and seals no receipt', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installObserveRepo(repo, app.url, {
          [RULE_FILE]: `${ruleSpec()}// __FAIL__ a race in this test\n`,
        });
        repo.commitFiles({}, 'base');
        const env = gateEnv(repo, app.url);

        const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.code, output).toBe(1);
        const report = JSON.parse(run.stdout) as Report;
        expect(report.businessRules?.map((entry) => [entry.caseId, entry.status, entry.channel]), output).toEqual([
          ['read-after-issue', 'failing', null],
          ['read-shows-fields', 'failing', null],
        ]);
        expect(
          report.businessRules?.every((entry) => entry.finding?.cause === 'BUSINESS_RULE_TEST_FAILING'),
          output,
        ).toBe(true);
        expect(report.businessRules?.every((entry) => entry.finding?.tests.includes(RULE_KEY)), output).toBe(true);
        // A failing run seals no receipt: there is nothing for a later
        // check to grade satisfied from.
        expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json')), output).toBe(false);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('fails a case when its second mapped test is red and its sibling is green', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        const accountSpec = evidenceSpecs(['accounts'], true)['e2e/accounts.spec.mjs'];
        if (accountSpec === undefined) throw new Error('missing generated account spec');
        installObserveRepo(
          repo,
          app.url,
          { 'e2e/accounts.spec.mjs': `${accountSpec}// __FAIL__ the account journey is red\n` },
          { secondRuleTest: true },
        );
        repo.commitFiles({}, 'base');
        const env = gateEnv(repo, app.url);

        const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.code, output).toBe(1);
        const report = JSON.parse(run.stdout) as Report;
        const caseEntry = report.businessRules?.find((entry) => entry.caseId === 'read-after-issue');
        expect(caseEntry?.status, output).toBe('failing');
        expect(caseEntry?.mappedTests, output).toEqual([ACCOUNT_RULE_KEY, RULE_KEY]);
        expect(caseEntry?.finding?.cause, output).toBe('BUSINESS_RULE_TEST_FAILING');
        expect(caseEntry?.finding?.tests, output).toEqual([ACCOUNT_RULE_KEY]);
        expect(
          report.businessRules?.find((entry) => entry.caseId === 'read-shows-fields')?.status,
          output,
        ).toBe('satisfied');
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('keeps a case the named run did not execute unproven and visible', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installObserveRepo(repo, app.url);
        repo.commitFiles({}, 'base');
        const env = gateEnv(repo, app.url);

        // The named result-only run executes exactly one test; the
        // rule's mapped test is not among them. The case is reported —
        // never absent, never satisfied by a run that never ran its test.
        const run = await runCli(
          repo,
          ['test-gates', '--test', 'reads an account', '--result-only', '--format', 'json'],
          env,
        );
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.code, output).toBe(1);
        const report = JSON.parse(run.stdout) as Report;
        expect(report.businessRules?.map((entry) => [entry.caseId, entry.status]), output).toEqual([
          ['read-after-issue', 'unproven'],
          ['read-shows-fields', 'unproven'],
        ]);
        expect(
          report.businessRules?.every((entry) => entry.finding?.detail.includes('the sealed run did not execute it')),
          output,
        ).toBe(true);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('keeps a case a --scope changed run did not select unproven and visible', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installObserveRepo(repo, app.url);
        repo.commitFiles({}, 'base');
        const env = gateEnv(repo, app.url);

        // A product change whose affected slice is the ACCOUNTS test:
        // the rule's mapped test is outside this run's graded slice.
        // The rule finding is run-wide (invariant 8) — reported, never
        // diff-scoped away, never satisfied by a slice that never ran it.
        // The changed-slice provider diffs COMMIT ranges, so the change
        // lands as a commit like any real merge request.
        repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table — widened\n' });
        repo.commitFiles({}, 'widen the accounts source');
        const run = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.code, output).toBe(1);
        const report = JSON.parse(run.stdout) as Report;
        expect(report.businessRules?.map((entry) => [entry.caseId, entry.status]), output).toEqual([
          ['read-after-issue', 'unproven'],
          ['read-shows-fields', 'unproven'],
        ]);
        expect(
          report.businessRules?.every((entry) => entry.finding?.detail.includes('the sealed run did not execute it')),
          output,
        ).toBe(true);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

/** The invoice spec with the journey's network access MOCKED away: the
 * `page.route` interception answers in place of the real app, so the
 * test proves the mock, never the rule. No `__EVIDENCE__` marker, exactly
 * like the honest rule spec (no persistence intent is forwarded). */
function mockedRuleSpec(): string {
  return [
    "import { test } from 'playwright/test';",
    "test('reads an invoice', async ({ page }) => {",
    "  await page.route('**/invoices-after-issue', (route) =>",
    "    route.fulfill({ status: 200, contentType: 'application/json', body: '{\"mocked\":true}' }));",
    '});',
    '',
  ].join('\n');
}

describe('§7.6 a mocked, quarantined or merely inferred mapping never satisfies', () => {
  it('refuses to mark a mocked spec, and even a passing sealed run keeps the case unproven naming the mock', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        // The invoice spec REALLY intercepts the network (`page.route`),
        // and the pack statically scans it (scanSpecs) — the catalog row
        // for the rule's test carries the observed mock signal, exactly
        // as it would in a real repository.
        installObserveRepo(repo, app.url, { [RULE_FILE]: mockedRuleSpec() }, { scanSpecs: true });
        repo.commitFiles({}, 'base');
        const env = gateEnv(repo, app.url);

        // The product refuses the dishonest declaration outright: an
        // explicit e2e kind cannot override observed mocking (§5.3).
        const refused = await runCli(
          repo,
          [
            'tests', 'mark',
            '--test', RULE_KEY,
            '--kind', 'observed-e2e',
            '--rule', 'invoices-stay-readable/read-after-issue',
            '--reason', 'the mocked journey claims the case',
          ],
        );
        const refusedOutput = `${refused.stdout}\n${refused.stderr}`;
        expect(refused.code, refusedOutput).toBe(2);
        expect(refused.stderr, refusedOutput).toContain('observed mocking');
        expect(refused.stderr, refusedOutput).toContain('§5.3');

        // The bypass a determined agent would attempt — the declaration
        // hand-written into the sidecar — is graded, not trusted. Statically
        // the case is already unproven WITH the mock as the named reason.
        const staticCheck = await runCli(repo, ['check', '--require-e2e', '--format', 'json'], env);
        const staticOutput = `${staticCheck.stdout}\n${staticCheck.stderr}`;
        expect(staticCheck.code, staticOutput).toBe(1);
        const staticReport = JSON.parse(staticCheck.stdout) as Report;
        expect(
          staticReport.businessRules?.map((entry) => [entry.caseId, entry.status, entry.channel]),
          staticOutput,
        ).toEqual([
          ['read-after-issue', 'unproven', null],
          ['read-shows-fields', 'unproven', null],
        ]);
        expect(
          staticReport.businessRules?.every((entry) =>
            entry.finding?.detail.includes('mock the system under test — a mocked spec never proves an end-to-end rule'),
          ),
          staticOutput,
        ).toBe(true);

        // And the sealed run settles it: the mocked test RUNS and PASSES
        // (the stub executes it green, the proxy traffic is witnessed and
        // claimed) — and the case is STILL unproven, because the proof a
        // mocked spec produces is the mock's, never the rule's.
        const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.code, output).toBe(1);
        const report = JSON.parse(run.stdout) as Report;
        expect(report.businessRules?.map((entry) => [entry.caseId, entry.status, entry.channel]), output).toEqual([
          ['read-after-issue', 'unproven', null],
          ['read-shows-fields', 'unproven', null],
        ]);
        expect(
          report.businessRules?.every((entry) =>
            entry.finding?.detail.includes('mock the system under test — a mocked spec never proves an end-to-end rule') &&
            entry.finding?.tests.includes(RULE_KEY),
          ),
          output,
        ).toBe(true);
        // The resolver's own §5.3 refusal stays visible: the declaration
        // contradicts the observed mocking, by claim id.
        const ambiguous = report.blocking.filter((entry) => entry.cause === 'TEST_MAPPING_AMBIGUOUS');
        expect(ambiguous.length, output).toBeGreaterThan(0);
        expect(ambiguous.some((entry) => entry.name === CLAIM_AFTER), output).toBe(true);
        expect(ambiguous.some((entry) => entry.detail.includes('observed mocking')), output).toBe(true);
        // A run whose rule never held seals no receipt.
        expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json')), output).toBe(false);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('never satisfies through an owner-quarantined test: the sealed run excludes it and says so', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installObserveRepo(repo, app.url);
        repo.commitFiles({}, 'base');
        // The owner quarantines the rule's own test (the fixed fixture
        // clock is 2026-01-01, so a 2026-01-10 expiry is in the future).
        const quarantined = await runCli(repo, [
          'quarantine', RULE_KEY,
          '--owner', 'owner',
          '--approver', 'approver',
          '--reason', 'the invoice read is flaky in CI',
          '--expires', '2026-01-10',
        ]);
        const quarantineOutput = `${quarantined.stdout}\n${quarantined.stderr}`;
        expect(quarantined.code, quarantineOutput).toBe(0);

        // Quarantines are owner-pinned policy: the digest is minted over
        // the quarantine document, AFTER it exists.
        const env = gateEnv(repo, app.url);
        const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.code, output).toBe(1);
        const report = JSON.parse(run.stdout) as Report;
        // The quarantined test never ran: its outcome and its session
        // were discarded, so the case cannot read satisfied — the finding
        // says exactly which mapped test the sealed run did not execute.
        expect(report.businessRules?.map((entry) => [entry.caseId, entry.status, entry.channel]), output).toEqual([
          ['read-after-issue', 'unproven', null],
          ['read-shows-fields', 'unproven', null],
        ]);
        expect(
          report.businessRules?.every(
            (entry) =>
              entry.finding?.cause === 'BUSINESS_RULE_TEST_UNPROVEN' &&
              entry.finding?.detail.includes('the sealed run did not execute it') &&
              entry.finding?.tests.includes(RULE_KEY),
          ),
          output,
        ).toBe(true);
        // The run names the quarantine itself, so the reason a mapped
        // test did not run is on the same report.
        const quarantineSection = (
          report as Report & { quarantine?: { count: number; tests: Array<{ testKey: string }> } }
        ).quarantine;
        expect(quarantineSection?.count, output).toBe(1);
        expect(quarantineSection?.tests.map((entry) => entry.testKey), output).toEqual([RULE_KEY]);
        expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json')), output).toBe(false);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('never satisfies on inference alone: a green witnessed run without a declared mapping keeps the case unmapped', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        // The invoice journey exists, runs GREEN under supervision, and
        // its traffic is witnessed — but NOTHING declares the rule cases:
        // the sidecar maps the test for its obligation only. The catalog's
        // inference can see the candidate; inference never writes a
        // mapping, and a declaration is never conjured from one.
        installObserveRepo(repo, app.url, {}, {
          observeClaims: ['tenant.invoices:persistence:read'],
        });
        repo.writeFiles({
          '.gateforge/test-map.yml': observeTestMap().replace(
            `      - ${CLAIM_AFTER}\n      - ${CLAIM_FIELDS}\n`,
            '',
          ),
        });
        repo.commitFiles({}, 'base');
        const env = gateEnv(repo, app.url);

        const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.code, output).toBe(1);
        const report = JSON.parse(run.stdout) as Report;
        // The strongest possible near-miss: the only plausible test ran,
        // passed, and produced witnessed records — and the case is still
        // UNMAPPED, because only a declared mapping can carry proof.
        expect(report.businessRules?.map((entry) => [entry.caseId, entry.status, entry.channel]), output).toEqual([
          ['read-after-issue', 'unmapped', null],
          ['read-shows-fields', 'unmapped', null],
        ]);
        expect(
          report.businessRules?.every(
            (entry) =>
              entry.finding?.cause === 'BUSINESS_RULE_TEST_MISSING' &&
              entry.mappedTests.length === 0 &&
              entry.finding.detail.includes('no test is mapped for this case'),
          ),
          output,
        ).toBe(true);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('§7.9 editing a rule moves the trusted digest and a stale pin is refused', () => {
  it('re-approves the pin after a rule wording change, and the cases stay unproven', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        installObserveRepo(repo, app.url);
        repo.commitFiles({}, 'base');
        // The owner pin over the rule's CURRENT bytes.
        const before = trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')));

        // The owner rewords the rule (same id, new title) and commits.
        const reworded = businessRule({
          id: 'invoices-stay-readable',
          title: 'An issued invoice stays readable through the app',
          subject: 'invoices',
          cases: [
            { id: 'read-after-issue', describe: 'The invoice issued by the journey is still readable afterwards' },
            { id: 'read-shows-fields', describe: 'Reading the invoice renders the fields the journey entered' },
          ],
        });
        repo.writeFiles({ '.gateforge/classification-policy.yml': answersYml([reworded]) });
        repo.commitFiles({}, 'reword the rule');
        const after = trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')));
        expect(after).not.toBe(before);

        // A pin minted over the OLD bytes no longer authorizes the
        // candidate: the answers document is owner-pinned, so a rule the
        // owner rewrote is exactly what the candidate-commit gate refuses
        // until the owner re-approves.
        const refused = await runCli(repo, ['check', '--candidate-commit', repo.headSha() as string, '--format', 'json'], {
          GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
          GATEFORGE_APPROVED_POLICY_DIGEST: before,
        });
        const refusedOutput = `${refused.stdout}\n${refused.stderr}`;
        expect(refused.code, refusedOutput).toBe(1);
        // The stale pin is refused by name — the owner re-approves.
        expect(refusedOutput).toContain('ENFORCEMENT_UNTRUSTED');

        // And with the pin re-approved, the gate grades again — the
        // reworded rule's cases are UNPROVEN until the next sealed run
        // (the wording change never inherits the old receipt's proof).
        const repinned = gateEnv(repo, app.url);
        const clean = await runCli(repo, ['check', '--format', 'json'], repinned);
        const cleanReport = JSON.parse(clean.stdout) as Report;
        expect(cleanReport.businessRules?.map((entry) => entry.status)).toEqual(['unproven', 'unproven']);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});
