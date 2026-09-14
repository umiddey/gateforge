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
 */
/** Typed error for a forbidden runner-child environment. */
export class RunnerEnvError extends Error {
    constructor(message) {
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
export const RUNNER_SECRET_ENV = ['GATEFORGE_WITNESS_VERIFIER_KEY'];
/**
 * Run-state paths that must NEVER reach the runner child through ANY
 * channel (execution-authority fix): worker code that can address the
 * lifecycle spool or the outcomes document can fabricate execution.
 * They reach the engine reporter as trusted-config constructor options
 * instead. A caller that stuffs them into `vars` is a wiring bug and
 * throws (fail closed, same discipline as {@link RUNNER_SECRET_ENV}).
 */
export const RUNNER_PARENT_SIDE_ENV = [
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
export const RUNNER_GATEFORGE_ALLOWLIST = [
    'GATEFORGE_RUN_TOKEN',
    'GATEFORGE_WITNESS_URL',
    'GATEFORGE_APP_BASE_URL',
    'GATEFORGE_TARGET_BASE_URL',
    'GATEFORGE_TARGET_FINGERPRINT',
    'GATEFORGE_REPORTER_FAIL_RUN',
];
/** System basics (path/home/locale/temp) the runner needs to function. */
export const RUNNER_SYSTEM_ALLOWLIST = [
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
];
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
export function buildRunnerChildEnv(vars, ambient = process.env) {
    for (const secret of RUNNER_SECRET_ENV) {
        if (vars[secret] !== undefined) {
            throw new RunnerEnvError(`refusing to pass '${secret}' to the runner child: signing material never reaches ` +
                'untrusted test code (enforcement-review fix 1)');
        }
    }
    for (const parentSide of RUNNER_PARENT_SIDE_ENV) {
        if (vars[parentSide] !== undefined) {
            throw new RunnerEnvError(`refusing to pass '${parentSide}' to the runner child: run-state paths stay parent-side ` +
                'so worker code cannot address the lifecycle spool or outcomes document ' +
                '(execution-authority fix; the engine reporter receives them as trusted-config options)');
        }
    }
    const child = {};
    for (const name of [...RUNNER_SYSTEM_ALLOWLIST, ...RUNNER_GATEFORGE_ALLOWLIST]) {
        const value = vars[name] ?? ambient[name];
        if (value !== undefined && value !== '')
            child[name] = value;
    }
    // Supervisor vars that are not GATEFORGE-known (future flags) still
    // pass through — they arrive from trusted supervision, and the secret
    // and parent-side checks above already ran over ALL of vars.
    for (const [name, value] of Object.entries(vars)) {
        if (child[name] === undefined && value !== '')
            child[name] = value;
    }
    return child;
}
//# sourceMappingURL=runner-env.js.map