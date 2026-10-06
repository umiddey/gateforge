/**
 * The supervised runner child's ENVIRONMENT ALLOWLIST (enforcement-
 * review fix 1): `executeSupervisedPlaywright` used to merge
 * `process.env` into the runner child, so `GATEFORGE_WITNESS_VERIFIER_KEY`
 * or its external key-ring source path — the key that authenticates gate receipts and the witness's
 * attestation/supervisor surface — was inherited by UNTRUSTED test code.
 *
 * The child env is now built from an explicit allowlist, never from the
 * ambient environment wholesale:
 * - system basics the runner needs (PATH/HOME, locale, temp dirs) plus
 *   the operator-set `PLAYWRIGHT_BROWSERS_PATH` cache directory, which
 *   the readiness check resolves through the same name (without it the
 *   doctor green-lights one cache while the child launches from
 *   `$HOME/.cache/ms-playwright`);
 * - the supervisor-supplied run variables (`RunnerExecutionEnv.vars` —
 *   already sanitized by the CLI);
 * - NON-secret `GATEFORGE_*` run flags from the ambient environment.
 * Every other name — and in particular every secret — is EXCLUDED. The
 * secret names are enumerated in {@link RUNNER_SECRET_ENV} and are
 * refused even when a caller explicitly stuffs them into `vars`
 * (fail closed on the wiring bug instead of leaking).
 *
 * Secret/non-secret classification of every known `GATEFORGE_*` name:
 * - SECRET SOURCE (never crosses to the runner child):
 *   GATEFORGE_WITNESS_VERIFIER_KEY and GATEFORGE_WITNESS_VERIFIER_KEY_FILE
 *   (authenticates gate receipts + the witness supervisor/attestation
 *   surface).
 * - NON-SECRET run wiring (allowlisted): GATEFORGE_RUN_TOKEN (the
 *   suite's own submission credential by design), GATEFORGE_WITNESS_URL,
 *   GATEFORGE_APP_BASE_URL, GATEFORGE_TARGET_BASE_URL,
 *   GATEFORGE_TARGET_FINGERPRINT, GATEFORGE_REPORTER_FAIL_RUN.
 * - PARENT-SIDE ONLY (execution-authority fix — the runner child must
 *   not address them): GATEFORGE_RUN_ID, GATEFORGE_STATE_DIR,
 *   GATEFORGE_OBLIGATIONS, GATEFORGE_OUTCOMES_FILE, GATEFORGE_ADAPTERS_DIR,
 *   GATEFORGE_CLASSIFICATIONS, GATEFORGE_ADAPTER_BASE_URL,
 *   GATEFORGE_PROXY_TARGET, GATEFORGE_MOUNT_PATH. Run-state paths reach
 *   the engine reporter as TRUSTED-CONFIG constructor options (never
 *   env), so worker code cannot locate the lifecycle spool or the
 *   outcomes document. The legacy `--suite` escape still wires its own
 *   env outside this allowlist — it is a dev loop, never the strict gate.
 * - Everything else: not allowlisted → excluded by default.
 *
 * WITNESSED PYTEST PARTICIPANT ({@link buildWitnessedPytestChildEnv}):
 * the server-witnessed persistence channel needs a supervised pytest run
 * whose intents can reach the spool (`$STATE_DIR/spool/$RUN_ID/
 * persistence-intents.jsonl`), so the playwright runner-child rules
 * above CANNOT apply verbatim — but the channel's own trust model makes
 * the relaxation sound and SCOPED: the intents spool is UNTRUSTED (the
 * witness verifies every claim with its own adapter server probe; a
 * written intent can never stamp evidence), and the witnessed participant
 * receives NOTHING beyond the run identity it needs to address the spool:
 * - allowed GATEFORGE_* names: GATEFORGE_STATE_DIR, GATEFORGE_RUN_ID
 *   (locate the run's intents spool), GATEFORGE_WITNESS_URL,
 *   GATEFORGE_RUN_TOKEN (run-scoped submission wiring, both already
 *   non-secret by design);
 * - still forbidden, as everywhere: both verifier-key source names
 *   (refused even when a caller explicitly stuffs it into `vars`) and
 *   every OTHER parent-side name (obligations/adapters/classifications/
 *   outcomes paths — the witnessed participant is a pytest process with
 *   none of the engine reporter's trusted-config channels, so those
 *   names have no honest business crossing);
 * - the rest of the ambient environment crosses MINUS every GATEFORGE_*
 *   name (same isolation discipline as the advisory pytest diagnostics
 *   runner `untrustedEnv`): the consumer's own operational env (database
 *   DSNs, interpreters, locale) is not gateforge wiring and must reach
 *   the suite, while ambient gateforge state must never leak in.
 */

/** Typed error for a forbidden runner-child environment. */
export class RunnerEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerEnvError';
  }
}

/**
 * Environment variable names that are SECRETS and must never reach the
 * runner child through ANY channel (env here; argv, stdin, and state
 * files are excluded by construction elsewhere). Keep this list in sync
 * with the module doc's classification.
 */
export const RUNNER_SECRET_ENV: readonly string[] = [
  'GATEFORGE_WITNESS_VERIFIER_KEY',
  'GATEFORGE_WITNESS_VERIFIER_KEY_FILE',
];

/**
 * Run-state paths that must NEVER reach the runner child through ANY
 * channel (execution-authority fix): worker code that can address the
 * lifecycle spool or the outcomes document can fabricate execution.
 * They reach the engine reporter as trusted-config constructor options
 * instead. A caller that stuffs them into `vars` is a wiring bug and
 * throws (fail closed, same discipline as {@link RUNNER_SECRET_ENV}).
 */
export const RUNNER_PARENT_SIDE_ENV: readonly string[] = [
  'GATEFORGE_RUN_ID',
  'GATEFORGE_STATE_DIR',
  'GATEFORGE_OBLIGATIONS',
  'GATEFORGE_OUTCOMES_FILE',
  'GATEFORGE_ADAPTERS_DIR',
  'GATEFORGE_CLASSIFICATIONS',
  'GATEFORGE_ADAPTER_BASE_URL',
  'GATEFORGE_PROXY_TARGET',
  'GATEFORGE_MOUNT_PATH',
];
export const RUNNER_GATEFORGE_ALLOWLIST: readonly string[] = [
  'GATEFORGE_RUN_TOKEN',
  'GATEFORGE_WITNESS_URL',
  'GATEFORGE_APP_BASE_URL',
  // Authority cutover (0.13): enablement ONLY. The grading configuration
  // (route table, login/error markers, app origins, tamper risks) is
  // supervisor-registered on the witness and never crosses to the child,
  // so a suite-controlled variable can disable observation but can never
  // enable false proof.
  'GATEFORGE_PAGE_OBSERVATION_ENABLED',
  'GATEFORGE_TARGET_BASE_URL',
  'GATEFORGE_TARGET_FINGERPRINT',
  'GATEFORGE_REPORTER_FAIL_RUN',
];

/**
 * System basics (path/home/locale/temp) the runner needs to function,
 * plus the one operator-set CACHE PATH the runner resolves through:
 * `enforcement doctor` reads the browser cache through
 * `PLAYWRIGHT_BROWSERS_PATH` and falls back to `$HOME/.cache/ms-playwright`
 * (`cli/playwright-browsers.ts` `defaultBrowsersPath`), so the child
 * must see the same variable or the doctor green-lights one directory
 * while the run launches from another (every test then dies with
 * `Executable doesn't exist`). It is a directory an operator chose, never
 * a secret — the same class as `HOME` and the XDG names the CLI already
 * forwards. The witnessed pytest/session children need no such entry:
 * they inherit the ambient environment minus every `GATEFORGE_*` name
 * ({@link buildWitnessedPytestChildEnv},
 * {@link buildWitnessedSessionRunnerEnv}), so this variable already
 * crosses there.
 */
export const RUNNER_SYSTEM_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PLAYWRIGHT_BROWSERS_PATH',
];

/**
 * Builds the runner child's environment from the ALLOWLIST (never a
 * wholesale `process.env` merge). Precedence: supervisor-supplied
 * `vars` win over the ambient environment; only allowlisted names are
 * copied at all.
 *
 * The child's own record has NO prototype. Every name here is an
 * arbitrary operator- or supervisor-chosen name, and `constructor`,
 * `toString` and `__proto__` are both legal environment names and
 * properties every plain object inherits: on a plain object an
 * assignment to `__proto__` stores no own key at all (the inherited
 * accessor swallows it), and a membership test by lookup
 * (`child[name] === undefined`) reports an inherited property as
 * already present. This map is the trusted baseline the freeze
 * controller projects every body worker back to, so a name dropped here
 * is a name no body worker can ever be projected back to — it keeps
 * whatever the preparation wrote instead.
 *
 * Args:
 *   vars: supervisor-supplied run variables (must be child-safe; a
 *     secret name here is a wiring bug and throws).
 *   ambient: the parent environment (default `process.env`).
 *
 * Returns:
 *   Record<string, string>: the allowlisted child environment.
 *
 * Throws:
 *   RunnerEnvError: when `vars` carries a secret name — fail closed on
 *     the wiring bug instead of leaking signing material.
 */
export function buildRunnerChildEnv(
  vars: Readonly<Record<string, string>>,
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  for (const secret of RUNNER_SECRET_ENV) {
    if (vars[secret] !== undefined) {
      throw new RunnerEnvError(
        `refusing to pass '${secret}' to the runner child: signing material never reaches ` +
          'untrusted test code (enforcement-review fix 1)',
      );
    }
  }
  for (const parentSide of RUNNER_PARENT_SIDE_ENV) {
    if (vars[parentSide] !== undefined) {
      throw new RunnerEnvError(
        `refusing to pass '${parentSide}' to the runner child: run-state paths stay parent-side ` +
          'so worker code cannot address the lifecycle spool or outcomes document ' +
          '(execution-authority fix; the engine reporter receives them as trusted-config options)',
      );
    }
  }
  const child = Object.create(null) as Record<string, string>;
  for (const name of [...RUNNER_SYSTEM_ALLOWLIST, ...RUNNER_GATEFORGE_ALLOWLIST]) {
    const value = vars[name] ?? ambient[name];
    if (value !== undefined && value !== '') child[name] = value;
  }
  // Supervisor vars that are not GATEFORGE-known (future flags) still
  // pass through — they arrive from trusted supervision, and the secret
  // and parent-side checks above already ran over ALL of vars.
  for (const [name, value] of Object.entries(vars)) {
    if (Object.hasOwn(child, name)) continue;
    if (value !== '') child[name] = value;
  }
  return child;
}

/**
 * The `GATEFORGE_*` names a WITNESSED pytest participant (diagnostics
 * suites marked `witnessed: true` in `.gateforge.yml`) may receive inside
 * the supervised window: exactly the run identity needed to address the
 * run's persistence-intents spool (STATE_DIR + RUN_ID) plus the
 * already-non-secret run wiring (witness URL + run token). The verifier
 * key and every other parent-side name are NEVER on this list — see the
 * module doc for why the relaxation is sound and scoped.
 */
export const WITNESSED_PYTEST_RUN_ENV: readonly string[] = [
  'GATEFORGE_STATE_DIR',
  'GATEFORGE_RUN_ID',
  'GATEFORGE_WITNESS_URL',
  'GATEFORGE_RUN_TOKEN',
];

/**
 * Builds the WITNESSED pytest participant's environment (the supervised
 * diagnostics suites marked `witnessed: true`): the ambient environment
 * minus EVERY `GATEFORGE_*` name (the `untrustedEnv` discipline the
 * advisory pytest runner already applies — the consumer's own operational
 * env such as database DSNs crosses, gateforge wiring does not), plus the
 * {@link WITNESSED_PYTEST_RUN_ENV} names from `vars` (run-scoped, so the
 * suite can locate ONLY the intents spool it is allowed to write).
 *
 * Fail closed, same discipline as {@link buildRunnerChildEnv}: a caller
 * that stuffs the verifier key — or any parent-side name OUTSIDE the
 * witnessed allowlist — into `vars` is a wiring bug and throws instead of
 * leaking. The playwright runner child NEVER goes through this builder:
 * its env rules ({@link buildRunnerChildEnv}) are unchanged byte-for-byte.
 *
 * Args:
 *   vars: supervisor-supplied run variables (run-scoped allowlist wins
 *     over ambient; a forbidden name here throws).
 *   ambient: the parent environment (default `process.env`).
 *
 * Returns:
 *   Record<string, string>: the witnessed participant's environment.
 *
 * Throws:
 *   RunnerEnvError: when `vars` carries the verifier key or a parent-side
 *     name that is not on the witnessed allowlist.
 */
export function buildWitnessedPytestChildEnv(
  vars: Readonly<Record<string, string>>,
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  for (const secret of RUNNER_SECRET_ENV) {
    if (vars[secret] !== undefined) {
      throw new RunnerEnvError(
        `refusing to pass '${secret}' to the witnessed pytest participant: signing material ` +
          'never reaches untrusted test code through ANY channel (the intents spool is ' +
          'untrusted by design — the witness verifies every claim with its own server probe)',
      );
    }
  }
  const witnessed = new Set<string>(WITNESSED_PYTEST_RUN_ENV);
  for (const parentSide of RUNNER_PARENT_SIDE_ENV) {
    if (!witnessed.has(parentSide) && vars[parentSide] !== undefined) {
      throw new RunnerEnvError(
        `refusing to pass '${parentSide}' to the witnessed pytest participant: only the ` +
          `run-scoped names [${WITNESSED_PYTEST_RUN_ENV.join(', ')}] cross to the intents ` +
          'writer — the participant can never address obligations, adapters, classifications, ' +
          'or the outcomes document',
      );
    }
  }
  const child: Record<string, string> = {};
  // Ambient minus every GATEFORGE_* name: the consumer's operational env
  // (DSNs, interpreters) is not gateforge wiring and must reach the suite;
  // ambient gateforge state (including the verifier key, if exported)
  // never does.
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined || value === '') continue;
    if (name.startsWith('GATEFORGE_')) continue;
    child[name] = value;
  }
  // Run-scoped allowlist from trusted supervision, wins over ambient.
  for (const name of WITNESSED_PYTEST_RUN_ENV) {
    const value = vars[name] ?? ambient[name];
    if (value !== undefined && value !== '') child[name] = value;
  }
  // Non-GATEFORGE supervisor vars (suite-specific wiring) pass through;
  // every GATEFORGE_* name not on the witnessed allowlist was already
  // refused above, so nothing privileged can ride this loop.
  for (const [name, value] of Object.entries(vars)) {
    if (name.startsWith('GATEFORGE_')) continue;
    if (value !== '') child[name] = value;
  }
  return child;
}

/**
 * The `GATEFORGE_*` names a witnessed session runner child (a runner
 * adapter's supervised execute that resolves per-test sessions and
 * writes the lifecycle spool: the pytest runner child and the Vitest
 * runner child) may receive: the run identity (STATE_DIR + RUN_ID
 * locate the lifecycle spool) plus the non-secret submission wiring
 * (WITNESS_URL + RUN_TOKEN) and the app base URL the session proxy
 * fronts. The verifier key and every other parent-side name are NEVER
 * on this list — same trust model as
 * {@link buildWitnessedPytestChildEnv}, one more non-secret name.
 */
export const WITNESSED_SESSION_RUN_ENV: readonly string[] = [
  ...WITNESSED_PYTEST_RUN_ENV,
  'GATEFORGE_APP_BASE_URL',
  // The pack's Vitest reporter's end-barrier TEST SEAM (see
  // ../vitest/reporter.ts): a filesystem path, never a secret, and
  // completely inert unless a test sets it. It exists so a test can
  // hold the reporter's `testEnd` deterministically instead of racing a
  // loaded machine for the same effect.
  'GATEFORGE_VITEST_END_BARRIER',
];

/**
 * Builds a witnessed session runner child's environment: the ambient
 * environment minus EVERY `GATEFORGE_*` name, plus the
 * {@link WITNESSED_SESSION_RUN_ENV} names from `vars`.
 *
 * Fail closed, same discipline as the other builders: a caller that
 * stuffs the verifier key — or any parent-side name OUTSIDE the
 * session allowlist — into `vars` is a wiring bug and throws instead
 * of leaking.
 *
 * Args:
 *   vars: supervisor-supplied run variables (run-scoped allowlist wins
 *     over ambient; a forbidden name here throws).
 *   ambient: the parent environment (default `process.env`).
 *
 * Returns:
 *   Record<string, string>: the runner child's environment.
 *
 * Throws:
 *   RunnerEnvError: when `vars` carries the verifier key or a
 *     parent-side name that is not on the session allowlist.
 */
export function buildWitnessedSessionRunnerEnv(
  vars: Readonly<Record<string, string>>,
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  for (const secret of RUNNER_SECRET_ENV) {
    if (vars[secret] !== undefined) {
      throw new RunnerEnvError(
        `refusing to pass '${secret}' to the runner child: signing material never reaches ` +
          'untrusted test code through ANY channel',
      );
    }
  }
  const allowed = new Set<string>(WITNESSED_SESSION_RUN_ENV);
  for (const parentSide of RUNNER_PARENT_SIDE_ENV) {
    if (!allowed.has(parentSide) && vars[parentSide] !== undefined) {
      throw new RunnerEnvError(
        `refusing to pass '${parentSide}' to the runner child: only the run-scoped names ` +
          `[${WITNESSED_SESSION_RUN_ENV.join(', ')}] cross — the child can never address ` +
          'obligations, adapters, classifications, or the outcomes document',
      );
    }
  }
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined || value === '') continue;
    if (name.startsWith('GATEFORGE_')) continue;
    child[name] = value;
  }
  for (const name of WITNESSED_SESSION_RUN_ENV) {
    const value = vars[name] ?? ambient[name];
    if (value !== undefined && value !== '') child[name] = value;
  }
  for (const [name, value] of Object.entries(vars)) {
    if (name.startsWith('GATEFORGE_')) continue;
    if (value !== '') child[name] = value;
  }
  return child;
}

/**
 * Builds the pytest runner child's environment for a supervised,
 * session-producing run (the `PytestRunnerAdapter` execute path): the
 * neutral witnessed-session environment plus the plugin directory
 * prepended to PYTHONPATH so `-p gateforge_pytest_plugin` resolves.
 *
 * Args:
 *   vars: supervisor-supplied run variables (run-scoped allowlist wins
 *     over ambient; a forbidden name here throws).
 *   ambient: the parent environment (default `process.env`).
 *   pluginDir: absolute directory the pack ships the pytest plugin in.
 *
 * Returns:
 *   Record<string, string>: the runner child's environment.
 *
 * Throws:
 *   RunnerEnvError: when `vars` carries the verifier key or a
 *     parent-side name that is not on the session allowlist.
 */
export function buildWitnessedPytestSessionEnv(
  vars: Readonly<Record<string, string>>,
  ambient: NodeJS.ProcessEnv = process.env,
  pluginDir: string,
): Record<string, string> {
  const child = buildWitnessedSessionRunnerEnv(vars, ambient);
  const existingPath = child['PYTHONPATH'];
  child['PYTHONPATH'] = existingPath !== undefined && existingPath !== '' ? `${pluginDir}:${existingPath}` : pluginDir;
  return child;
}
