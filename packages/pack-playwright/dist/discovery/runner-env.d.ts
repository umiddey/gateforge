/**
 * The supervised runner child's ENVIRONMENT ALLOWLIST (enforcement-
 * review fix 1): `executeSupervisedPlaywright` used to merge
 * `process.env` into the runner child, so `GATEFORGE_WITNESS_VERIFIER_KEY`
 * — the key that authenticates gate receipts and the witness's
 * attestation/supervisor surface — was inherited by UNTRUSTED test code.
 *
 * The child env is now built from an explicit allowlist, never from the
 * ambient environment wholesale:
 * - system basics the runner needs (PATH/HOME, locale, temp dirs);
 * - the supervisor-supplied run variables (`RunnerExecutionEnv.vars` —
 *   already sanitized by the CLI);
 * - NON-secret `GATEFORGE_*` run flags from the ambient environment.
 * Every other name — and in particular every secret — is EXCLUDED. The
 * secret names are enumerated in {@link RUNNER_SECRET_ENV} and are
 * refused even when a caller explicitly stuffs them into `vars`
 * (fail closed on the wiring bug instead of leaking).
 *
 * Secret/non-secret classification of every known `GATEFORGE_*` name:
 * - SECRET (never crosses to the runner child): GATEFORGE_WITNESS_VERIFIER_KEY
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
 * - still forbidden, as everywhere: GATEFORGE_WITNESS_VERIFIER_KEY
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
export declare class RunnerEnvError extends Error {
    constructor(message: string);
}
/**
 * Environment variable names that are SECRETS and must never reach the
 * runner child through ANY channel (env here; argv, stdin, and state
 * files are excluded by construction elsewhere). Keep this list in sync
 * with the module doc's classification.
 */
export declare const RUNNER_SECRET_ENV: readonly string[];
/**
 * Run-state paths that must NEVER reach the runner child through ANY
 * channel (execution-authority fix): worker code that can address the
 * lifecycle spool or the outcomes document can fabricate execution.
 * They reach the engine reporter as trusted-config constructor options
 * instead. A caller that stuffs them into `vars` is a wiring bug and
 * throws (fail closed, same discipline as {@link RUNNER_SECRET_ENV}).
 */
export declare const RUNNER_PARENT_SIDE_ENV: readonly string[];
export declare const RUNNER_GATEFORGE_ALLOWLIST: readonly string[];
/** System basics (path/home/locale/temp) the runner needs to function. */
export declare const RUNNER_SYSTEM_ALLOWLIST: readonly string[];
/**
 * Builds the runner child's environment from the ALLOWLIST (never a
 * wholesale `process.env` merge). Precedence: supervisor-supplied
 * `vars` win over the ambient environment; only allowlisted names are
 * copied at all.
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
export declare function buildRunnerChildEnv(vars: Readonly<Record<string, string>>, ambient?: NodeJS.ProcessEnv): Record<string, string>;
/**
 * The `GATEFORGE_*` names a WITNESSED pytest participant (diagnostics
 * suites marked `witnessed: true` in `.gateforge.yml`) may receive inside
 * the supervised window: exactly the run identity needed to address the
 * run's persistence-intents spool (STATE_DIR + RUN_ID) plus the
 * already-non-secret run wiring (witness URL + run token). The verifier
 * key and every other parent-side name are NEVER on this list — see the
 * module doc for why the relaxation is sound and scoped.
 */
export declare const WITNESSED_PYTEST_RUN_ENV: readonly string[];
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
export declare function buildWitnessedPytestChildEnv(vars: Readonly<Record<string, string>>, ambient?: NodeJS.ProcessEnv): Record<string, string>;
//# sourceMappingURL=runner-env.d.ts.map