import { HOOK_MARKER_BEGIN, HOOK_MARKER_END, HOOK_VERIFY_ARG, gateforgeHookScript, hasGateforgeMarker, resolveHooksDir, verifyHookActivation } from './staged-candidate.js';
export { HOOK_MARKER_BEGIN, HOOK_MARKER_END, HOOK_VERIFY_ARG, gateforgeHookScript, hasGateforgeMarker, resolveHooksDir, verifyHookActivation };
/** Name of the hook Git runs before a commit is created. */
export declare const PRE_COMMIT_HOOK_NAME = "pre-commit";
/**
 * The standalone staged-gate runner written under `.gateforge/hooks/`:
 * consumers with a foreign hook manager chain it manually (the exact
 * action the conflict report names), and it doubles as the verify target
 * for `check`-less environments. Same engine resolution and strict gate
 * as the generated pre-commit hook.
 */
export declare const STAGED_GATE_SCRIPT_BASENAME = "gateforge-staged.sh";
/** The typed outcome of one `init --blocking` hook installation. */
export type HookInstallOutcome = {
    status: 'installed';
    hookPath: string;
    hooksDir: string;
    detail: string;
} | {
    status: 'verified';
    hookPath: string;
    hooksDir: string;
    detail: string;
} | {
    status: 'conflict';
    hookPath: string;
    hooksDir: string;
    detail: string;
    action: string;
} | {
    status: 'incomplete';
    hookPath: string | null;
    hooksDir: string | null;
    detail: string;
    action: string;
};
/**
 * Installs (or verifies) the active pre-commit hook (plan Phase 5 item
 * 1). Writing the hook is not enough: after writing or finding a
 * gateforge-owned hook the activation is VERIFIED — exec bit present and
 * the script actually executes its verify mode.
 *
 * Args:
 *   cwd: absolute repository root.
 *   env: process environment.
 *
 * Returns:
 *   HookInstallOutcome: typed outcome; `conflict`/`incomplete` carry the
 *   exact required action and must be reported as an incomplete
 *   installation by the caller (nonzero exit).
 */
export declare function installCommitHook(cwd: string, env: NodeJS.ProcessEnv): HookInstallOutcome;
/**
 * Writes the standalone staged-gate script under `.gateforge/hooks/`
 * (idempotent, executable) — the chaining target the conflict report
 * names and a manual-verification entry point.
 *
 * Args:
 *   cwd: absolute repository root.
 *
 * Returns:
 *   string: absolute path of the script.
 *
 * Throws:
 *   Error: when the script cannot be written (caller reports incomplete).
 */
export declare function writeStandaloneGateScript(cwd: string): string;
/**
 * Inspects the hook state for `enforcement doctor` (plan Phase 5 item
 * 7): hooks directory, hook presence, gateforge marker, exec bit, and
 * verified activation — reported honestly, never as managed protection.
 *
 * Args:
 *   cwd: absolute repository root.
 *   env: process environment.
 *
 * Returns:
 *   {installed, hooksDir, hookPath, marker, execBit, verifyOk, detail}:
 *   the honest inspection record.
 */
export declare function inspectCommitHook(cwd: string, env: NodeJS.ProcessEnv): {
    installed: boolean;
    hooksDir: string | null;
    hookPath: string | null;
    marker: boolean;
    execBit: boolean;
    verifyOk: boolean;
    detail: string;
};
/**
 * One-shot activation probe used by tests and the doctor: runs the hook
 * script's verify mode directly (proves the exec bit + the shebang work
 * without a commit).
 *
 * Args:
 *   hookPath: absolute hook path.
 *
 * Returns:
 *   {ok, detail}: spawn result (spawnSync is used directly here so a
 *   spawn-level failure surfaces as `ok: false`, never an exception).
 */
export declare function probeHookExecution(hookPath: string): {
    ok: boolean;
    detail: string;
};
//# sourceMappingURL=git-hooks.d.ts.map