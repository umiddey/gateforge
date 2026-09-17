import type { Io } from '../io.js';
/**
 * Resolves the engine root from the live CLI invocation, when gateforge
 * was started as `<engine>/packages/cli/bin/gateforge.js`. Returns null
 * under test runners / other invocations — the hook then relies on
 * gateforge on PATH or $GATEFORGE_CLI (the npm-install future).
 */
export declare function engineRootFromInvocation(): string | null;
/**
 * Records the engine checkout root in `.gateforge/engine` — the ONE
 * machine-specific reference the generated hook reads. Empty/absent when
 * gateforge resolves from PATH instead (the npm-install future).
 */
export declare function writeEngineReference(io: Io, engineRoot: string | null): void;
/** Ensures the check-gate hook script exists (executable).
 *
 * Args:
 *   gateArgs: the gate invocation the hook runs, chosen by the wiring
 *     command at generation time — `enforce`/`adopt` wire
 *     ['check', '--changed'] (debt-friendly); `init --blocking` wires
 *     ['check', '--staged', '--require-e2e'] (strict staged gate). One
 *     template, one hook file, one resolution order — only the check
 *     invocation differs, and it is recorded in the generated file.
 */
export declare function ensureHookScript(io: Io, engineRoot: string | null, gateArgs?: readonly string[]): string;
/** Appends the gateforge-check hook to .pre-commit-config.yaml (idempotent). */
export declare function appendPreCommitHook(io: Io): void;
/** Writes the GitLab CI job template + include wiring (idempotent). */
export declare function writeGitlabCiTemplate(io: Io): void;
/** Wires everything: engine reference + hook script + pre-commit block + CI template. */
export declare function ensureBlockingWiring(io: Io, engineRoot: string | null, gateArgs?: readonly string[]): void;
//# sourceMappingURL=blocking.d.ts.map