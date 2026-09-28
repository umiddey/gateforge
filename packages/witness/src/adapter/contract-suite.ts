/**
 * The runner-adapter contract suite (plan 2026-09-25 phase 0).
 *
 * One shared conformance suite every runner adapter must pass. The suite
 * owns the ASSERTIONS; a {@link RunnerContractHost} owns only the
 * runner mechanics (which files to materialize, how to spawn the runner,
 * where its structured report lands). Nothing here parses a runner's
 * output — the adapter does that, and the suite checks the adapter did
 * it honestly.
 *
 * The suite is deliberately framework-free (no test runner import): each
 * adapter's package runs {@link runRunnerAdapterContract} and asserts
 * the returned violation list is empty. That keeps one implementation
 * of "what a runner adapter must do" instead of N look-alike copies.
 *
 * Grading always runs through `superviseExecution`
 * (`@gate-forge/core`) — the neutral completeness rules. The suite never
 * invents a verdict of its own, so a contract pass means the adapter
 * feeds the same enforcement point a Playwright run feeds.
 */
import { superviseExecution, type PlannedInstanceInput, type RunnerExecutionEnvelope } from '@gate-forge/core';
import type {
  RunnerAdapter,
  RunnerChildEnvContext,
  RunnerExecuteRequest,
  RunnerRawResults,
  RunnerSessionTag,
  RunnerTagChannel,
  RunnerTestIdentity,
} from './contract.js';

/**
 * The behaviours a conforming adapter must distinguish. Each one is a
 * way a run can silently look green when it is not.
 */
export type ContractScenarioKind =
  /** Every planned test passes on its first attempt. */
  | 'pass'
  /** A planned test fails. */
  | 'fail'
  /** A planned test is skipped — nothing was proven by it. */
  | 'skip'
  /** A planned test needed a second attempt (required retries are zero). */
  | 'retry'
  /** The runner ran a test that was not in the expected set. */
  | 'unplanned'
  /** The runner ran nothing at all. */
  | 'zero'
  /** The runner ran the suite but never tagged its traffic. */
  | 'untagged';

/** One contract scenario: the expected set plus the behaviour to produce. */
export interface ContractScenario {
  kind: ContractScenarioKind;
  /** Exact logical keys the run is expected to cover (fixed pre-run). */
  expectedLogicalKeys: readonly string[];
  /** Repo-relative posix file the planned tests live in. */
  file: string;
  /** Full title path of the planned tests. */
  titlePath: readonly string[];
  /** Runner project, or null. */
  project: string | null;
}

/**
 * One observed execution of a scenario: the runner's REAL structured
 * report plus the envelope the adapter read out of it.
 *
 * The envelope is always `adapter.parseResults(raw)` — never the
 * runner's own verdict and never a hand-written one. Grading the
 * adapter's reading of real runner output is the whole point: a runner
 * that prints "0 failed" proves nothing until an adapter has turned it
 * into outcomes supervision can compare against the expected set.
 */
export interface ContractObservation {
  /** `adapter.parseResults(raw)` — the adapter's structured envelope. */
  envelope: RunnerExecutionEnvelope;
  /** The runner's structured report, exactly as the runner emitted it. */
  raw: RunnerRawResults;
  /**
   * Why the host produced this report outside `adapter.execute` (e.g.
   * the scenario cannot occur under the supervised policy, which forces
   * zero retries). Empty when `adapter.execute` produced it.
   */
  note?: string;
}

/**
 * The runner-specific mechanics a contract run needs. An adapter
 * supplies none of these: the suite drives the adapter and asserts.
 */
export interface RunnerContractHost {
  /** Runner name under test (must equal the adapter's). */
  readonly runner: string;
  /**
   * The runner project the expected set is bound to, or null when the
   * runner reports none. It is part of the identity join key, so the
   * suite cannot guess it: the host owns the runner's own naming.
   */
  readonly project: string | null;
  /**
   * Materializes a project whose suite produces `scenario`.
   *
   * Args:
   *   scenario: the behaviour the produced suite must exhibit.
   *
   * Returns:
   *   Promise<string>: the absolute project root.
   */
  materialize(scenario: ContractScenario): Promise<string>;
  /**
   * Spawns the REAL runner over the materialized project and returns its
   * structured report, graded by `adapter.parseResults`.
   *
   * The host spawns; the adapter reads. A scenario the supervised
   * policy forbids (a retry — the supervised run forces `--retries=0`)
   * is produced with the runner's OWN setting and the host says so in
   * {@link ContractObservation.note}: the point of that case is that
   * the adapter DETECTS a retry when one happens, not that the engine
   * permits one.
   *
   * Args:
   *   adapter: the adapter under test (for `parseResults` only).
   *   projectRoot: the root `materialize` returned.
   *   scenario: the behaviour to produce.
   *
   * Returns:
   *   Promise<ContractObservation>: the real report and its envelope.
   */
  run(
    adapter: RunnerAdapter,
    projectRoot: string,
    scenario: ContractScenario,
  ): Promise<ContractObservation>;
  /**
   * The request a `pass` scenario executes with (timeout, run state).
   * The suite calls `adapter.execute` with it for the execute check.
   */
  executeRequest(projectRoot: string, scenario: ContractScenario): RunnerExecuteRequest;
  /**
   * A report in this runner's NATIVE format whose every row carries no
   * framework identity — the shape a runner emits when its per-test tag
   * never reached it. The suite feeds it to `parseResults` to prove the
   * adapter attributes nothing from it.
   */
  untaggedReport(): string;
}

/** One contract violation (a non-empty list is a contract failure). */
export interface ContractViolation {
  /** The contract case the violation belongs to. */
  case: string;
  /** Single-cause explanation. */
  detail: string;
}

/** The session context a run wires for a planned test. */
function sessionContext(overrides: Partial<RunnerChildEnvContext> = {}): RunnerChildEnvContext {
  return {
    witnessUrl: 'http://127.0.0.1:1',
    runToken: 'contract-suite-run-token',
    sessionId: 'contract-suite-session',
    sessionToken: 'contract-suite-session-token',
    sessionProxyUrl: 'http://127.0.0.1:1/session/contract-suite-session',
    appBaseUrl: 'http://127.0.0.1:2',
    ...overrides,
  };
}

/**
 * The identity key an adapter's outcome `logicalKey` encodes: the
 * repo-relative file and the full title path, joined the way the engine
 * already keys claim injections (`<file>#<titlePath.join('>')>`). The
 * contract reads it back so a scenario can grade an outcome the adapter
 * did not plan — which is exactly what an unplanned run produces.
 */
function identityOfOutcome(logicalKey: string): { file: string; titlePath: string[] } {
  const hash = logicalKey.indexOf('#');
  if (hash < 0) return { file: logicalKey, titlePath: [] };
  return {
    file: logicalKey.slice(0, hash),
    titlePath: logicalKey.slice(hash + 1).split('>'),
  };
}

/** The identity key an enumerated test is joined on. */
function identityOfTest(test: RunnerTestIdentity): string {
  return `${test.project ?? '-'}\u0000${test.file}\u0000${test.titlePath.join('>')}`;
}

/** The identity key a scenario's planned test is joined on. */
function identityOfScenario(scenario: ContractScenario): string {
  return `${scenario.project ?? '-'}\u0000${scenario.file}\u0000${scenario.titlePath.join('>')}`;
}

/** The planned instance for a scenario (the expected set, fixed pre-run). */
function plannedOf(scenario: ContractScenario): PlannedInstanceInput[] {
  return scenario.expectedLogicalKeys.map((logicalKey) => ({
    logicalKey,
    project: scenario.project,
    file: scenario.file,
    titlePath: scenario.titlePath,
    blockingAnnotations: [],
  }));
}

/** Env names that must never reach a runner child through any channel. */
const FORBIDDEN_CHILD_ENV: readonly string[] = [
  'GATEFORGE_WITNESS_VERIFIER_KEY',
  'GATEFORGE_WITNESS_VERIFIER_KEY_FILE',
  'GATEFORGE_OBLIGATIONS',
  'GATEFORGE_OUTCOMES_FILE',
  'GATEFORGE_ADAPTERS_DIR',
  'GATEFORGE_CLASSIFICATIONS',
  'GATEFORGE_ADAPTER_BASE_URL',
];

/** The scenarios every adapter is graded on, in a stable order. */
export const CONTRACT_SCENARIOS: readonly ContractScenarioKind[] = [
  'pass',
  'fail',
  'skip',
  'retry',
  'unplanned',
  'zero',
];

/** Builds the canonical scenario for one kind (single planned test). */
export function contractScenario(
  kind: ContractScenarioKind,
  overrides: Partial<ContractScenario> = {},
): ContractScenario {
  const file = overrides.file ?? 'e2e/contract.spec.ts';
  const titlePath = overrides.titlePath ?? ['contract'];
  return {
    kind,
    file,
    titlePath,
    project: overrides.project ?? null,
    expectedLogicalKeys: overrides.expectedLogicalKeys ?? [
      `${file}#${titlePath.join('>')}`,
    ],
  };
}

/**
 * Runs the full contract against one adapter.
 *
 * Every check is fail-closed: an adapter that throws, reports a missing
 * field, or grades a dishonest run green produces a violation. The
 * returned list is the whole result — an empty list is a pass.
 *
 * Args:
 *   adapter: the adapter under test.
 *   host: the runner mechanics for `adapter.runner`.
 *
 * Returns:
 *   Promise<ContractViolation[]>: every contract case that failed.
 */
export async function runRunnerAdapterContract(
  adapter: RunnerAdapter,
  host: RunnerContractHost,
): Promise<ContractViolation[]> {
  const violations: ContractViolation[] = [];
  const fail = (name: string, detail: string): void => {
    violations.push({ case: name, detail });
  };

  if (host.runner !== adapter.runner) {
    fail(
      'runner-name-matches',
      `the contract host serves '${host.runner}' but the adapter reports '${adapter.runner}'`,
    );
    return violations;
  }
  if (adapter.capabilities.inventory !== 'available') {
    fail(
      'capabilities-declared',
      `a witness-producing adapter must declare inventory 'available' (got '${adapter.capabilities.inventory}')`,
    );
  }
  if (adapter.capabilities.execute !== 'available') {
    fail(
      'capabilities-declared',
      `a witness-producing adapter must declare execute 'available' (got '${adapter.capabilities.execute}')`,
    );
  }

  await checkEnumeration(adapter, host, fail);
  await checkTagging(adapter, fail);
  checkReportParsing(adapter, host, fail);
  await checkExecute(adapter, host, fail);

  for (const kind of CONTRACT_SCENARIOS) {
    await checkScenario(adapter, host, kind, fail);
  }
  return violations;
}

/** The expected set must be listed before the run, and never faked empty. */
async function checkEnumeration(
  adapter: RunnerAdapter,
  host: RunnerContractHost,
  fail: (name: string, detail: string) => void,
): Promise<void> {
  const scenario = contractScenario('pass', { project: host.project });
  const root = await host.materialize(scenario);
  let enumeration;
  try {
    enumeration = await adapter.enumerate(root);
  } catch (error) {
    fail('enumeration-lists-the-expected-set', `enumerate threw: ${errorMessage(error)}`);
    return;
  }
  if (enumeration.status !== 'discovered') {
    fail(
      'enumeration-lists-the-expected-set',
      `enumerate returned '${enumeration.status}' (${enumeration.detail}) for a project that has tests`,
    );
    return;
  }
  // Joined on IDENTITY (project + file + title path), the same join
  // supervision uses — never on a key format the contract would have to
  // predict for every runner.
  const found = new Set(enumeration.tests.map(identityOfTest));
  if (!found.has(identityOfScenario(scenario))) {
    fail(
      'enumeration-lists-the-expected-set',
      `enumerate omitted the planned test (saw [${[...found].join(' | ')}])`,
    );
  }
  for (const test of enumeration.tests) {
    if (test.file === '' || test.titlePath.length === 0) {
      fail(
        'enumeration-carries-identity',
        `enumerated test '${test.logicalKey}' has no file/titlePath identity — supervision cannot join it`,
      );
    }
  }

  const emptyRoot = await host.materialize(contractScenario('zero', { project: host.project }));
  let empty;
  try {
    empty = await adapter.enumerate(emptyRoot);
  } catch (error) {
    fail('zero-tests-never-reads-as-discovered', `enumerate threw: ${errorMessage(error)}`);
    return;
  }
  if (empty.status !== 'unavailable' || empty.tests.length !== 0) {
    fail(
      'zero-tests-never-reads-as-discovered',
      `a project with no runnable tests must enumerate as 'unavailable', got '${empty.status}' with ${String(empty.tests.length)} test(s)`,
    );
  }
}

/**
 * The tag must vary per session: a constant tag is unattributed traffic
 * wearing a tag, which is exactly the rule the witness already enforces
 * for traffic that bypasses every session channel.
 */
async function checkTagging(
  adapter: RunnerAdapter,
  fail: (name: string, detail: string) => void,
): Promise<void> {
  const first = adapter.childEnv(
    { logicalKey: 'a#one', frameworkId: 'one', project: null },
    sessionContext(),
  );
  const second = adapter.childEnv(
    { logicalKey: 'a#two', frameworkId: 'two', project: null },
    sessionContext({ sessionId: 'contract-suite-session-2', sessionToken: 'contract-suite-session-token-2', sessionProxyUrl: 'http://127.0.0.1:1/session/contract-suite-session-2' }),
  );
  if (first.tagChannel === 'none' || second.tagChannel === 'none') {
    fail(
      'traffic-is-tagged',
      `childEnv reported tagChannel 'none' — a runner whose traffic cannot be attributed can never produce witness evidence`,
    );
  }
  const identity = new Set([...first.identityVars, ...second.identityVars]);
  if (identity.size === 0) {
    fail('traffic-is-tagged', 'childEnv declared no identity variables — nothing tags the test');
    return;
  }
  const differing = [...identity].filter((name) => first.vars[name] !== second.vars[name]);
  if (differing.length === 0) {
    fail(
      'tag-varies-per-session',
      `no identity variable (${[...identity].join(', ')}) differs between two sessions — every test would be attributed to the same session`,
    );
  }
  for (const [name, value] of Object.entries({ ...first.vars, ...second.vars })) {
    if (FORBIDDEN_CHILD_ENV.includes(name)) {
      fail('child-env-carries-no-parent-side-wiring', `childEnv leaked parent-side '${name}' to the runner child`);
    }
    if (value === '') {
      fail('child-env-carries-no-parent-side-wiring', `childEnv emitted an empty value for '${name}'`);
    }
  }
  const channel: RunnerTagChannel = first.tagChannel;
  if (channel === 'session-proxy' && (first.vars['GATEFORGE_SESSION_PROXY_URL'] ?? '') === '') {
    fail(
      'traffic-is-tagged',
      "tagChannel 'session-proxy' requires GATEFORGE_SESSION_PROXY_URL in the child env",
    );
  }
}

/** An unreadable report is never a green run, and never a fabricated set. */
function checkReportParsing(
  adapter: RunnerAdapter,
  host: RunnerContractHost,
  fail: (name: string, detail: string) => void,
): void {
  const garbage = adapter.parseResults({ processExit: 0, report: '' });
  if (garbage.complete) {
    fail(
      'unreadable-report-fails-closed',
      'parseResults read an empty report as a complete run — a missing report never proves anything',
    );
  }
  if (garbage.outcomes.length !== 0) {
    fail(
      'unreadable-report-fails-closed',
      `parseResults invented ${String(garbage.outcomes.length)} outcome(s) from an empty report`,
    );
  }
  const noExit = adapter.parseResults({ processExit: null, report: '' });
  if (noExit.complete) {
    fail('unreadable-report-fails-closed', 'a run with no exit status is incomplete, never complete');
  }
  // A row the adapter cannot identify belongs to NO test: untagged
  // traffic is never attributed, which is the same rule the witness
  // applies to a request that bypassed every session channel.
  const untagged = adapter.parseResults({ processExit: 0, report: host.untaggedReport() });
  if (untagged.complete) {
    fail(
      'untagged-traffic-is-not-attributed',
      'a report whose rows carry no runner framework id graded complete — a test the adapter cannot identify is never attributed to a test',
    );
  }
}

/**
 * The job-3 check: the adapter must be able to RUN a suite itself, not
 * only read reports. One real supervised `execute` over the `pass`
 * project, graded exactly like a scenario.
 */
async function checkExecute(
  adapter: RunnerAdapter,
  host: RunnerContractHost,
  fail: (name: string, detail: string) => void,
): Promise<void> {
  const name = 'execute-runs-a-suite';
  const scenario = contractScenario('pass', { project: host.project });
  const root = await host.materialize(scenario);
  const request = host.executeRequest(root, scenario);
  let envelope: RunnerExecutionEnvelope;
  try {
    envelope = await adapter.execute(request);
  } catch (error) {
    fail(name, `execute threw: ${errorMessage(error)}`);
    return;
  }
  if (envelope.outcomes.length === 0) {
    fail(name, 'execute reported no outcomes for a project that has a passing test');
    return;
  }
  const graded = superviseExecution(plannedOf(scenario), {
    processExit: envelope.processExit,
    complete: envelope.complete,
    ...(envelope.incompleteDetail !== undefined ? { incompleteDetail: envelope.incompleteDetail } : {}),
    outcomes: envelope.outcomes.map((outcome) => ({
      ...identityOfOutcome(outcome.logicalKey),
      logicalKey: outcome.logicalKey,
      project: outcome.project,
      status: outcome.status,
      attempt: outcome.attempt,
      expectedFailure: outcome.expectedFailure ?? false,
    })),
    fixtureOutcome: envelope.fixtureOutcome ?? 'unknown',
    shards: envelope.shards ?? null,
    retriesDetected: envelope.retriesDetected ?? false,
    ...(envelope.retriesDetail !== undefined ? { retriesDetail: envelope.retriesDetail } : {}),
  });
  if (!graded.complete) {
    fail(
      name,
      `execute ran the passing project but supervision blocked it: ${graded.findings[0]?.detail ?? ''}`,
    );
  }
}

/** One scenario: run it and assert supervision blocks exactly as it must. */
async function checkScenario(
  adapter: RunnerAdapter,
  host: RunnerContractHost,
  kind: ContractScenarioKind,
  fail: (name: string, detail: string) => void,
): Promise<void> {
  const name = `scenario-${kind}`;
  const scenario = contractScenario(kind, { project: host.project });
  const root = await host.materialize(scenario);
  let observation: ContractObservation;
  try {
    observation = await host.run(adapter, root, scenario);
  } catch (error) {
    fail(name, `the host could not run the scenario: ${errorMessage(error)}`);
    return;
  }
  const planned = plannedOf(scenario);
  const graded = superviseExecution(planned, {
    processExit: observation.envelope.processExit,
    complete: observation.envelope.complete,
    ...(observation.envelope.incompleteDetail !== undefined
      ? { incompleteDetail: observation.envelope.incompleteDetail }
      : {}),
    outcomes: observation.envelope.outcomes.map((outcome) => ({
      ...identityOfOutcome(outcome.logicalKey),
      logicalKey: outcome.logicalKey,
      project: outcome.project,
      status: outcome.status,
      attempt: outcome.attempt,
      expectedFailure: outcome.expectedFailure ?? false,
    })),
    fixtureOutcome: observation.envelope.fixtureOutcome ?? 'unknown',
    shards: observation.envelope.shards ?? null,
    retriesDetected: observation.envelope.retriesDetected ?? false,
    ...(observation.envelope.retriesDetail !== undefined
      ? { retriesDetail: observation.envelope.retriesDetail }
      : {}),
  });
  const causes = graded.findings.map((finding) => finding.cause);
  switch (kind) {
    case 'pass':
      if (!graded.complete) {
        fail(name, `a complete first-attempt passing run was blocked: ${graded.findings[0]?.detail ?? ''}`);
      }
      if (observation.envelope.outcomes.length !== scenario.expectedLogicalKeys.length) {
        fail(
          name,
          `a passing run reported ${String(observation.envelope.outcomes.length)} outcome(s) for ${String(scenario.expectedLogicalKeys.length)} planned test(s)`,
        );
      }
      return;
    case 'zero':
      if (graded.complete) {
        fail(name, 'a run that executed no test graded complete — nothing executed proves nothing');
      }
      return;
    default:
      if (graded.complete) {
        fail(name, `a '${kind}' run graded complete — it must block`);
      }
      if (!causes.includes('TEST_NOT_EXECUTED') && !causes.includes('TEST_FAILED') && !causes.includes('RUN_INCOMPLETE')) {
        fail(name, `a '${kind}' run blocked with no typed cause (saw [${causes.join(', ')}])`);
      }
  }
}

/** Single-line message of an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
