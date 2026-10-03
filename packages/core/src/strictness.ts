/**
 * Owner-chosen gate strictness and the
 * flaky-test quarantine model (Phase 2).
 *
 * `mode` is an OPTIONAL owner-owned config key. Its default is
 * `strict`, which is exactly the behavior a repository without the key
 * has today — the frozen contract. The owner may soften the GATE, never
 * the evidence: `warn` still evaluates, counts and reports everything
 * and only the exit code changes; `changed` blocks on debt this change
 * touches while the full debt stays in the report.
 *
 * Pure and deterministic: every function here is total, side-effect
 * free and free of wall-clock reads, so the decision is unit-testable
 * and identical on every surface that asks for it.
 */
import { z } from 'zod';

/**
 * The three owner-selectable gate strictness levels.
 *
 * - `strict` — today's gate (also the default when the key is absent).
 * - `changed` — block only for debt the evaluated change touches; the
 *   full debt is still reported.
 * - `warn` — evaluate fully, report everything, exit 0.
 */
export const StrictnessModeSchema = z.enum(['strict', 'changed', 'warn']);

/** Inferred strictness-mode union. */
export type StrictnessMode = z.infer<typeof StrictnessModeSchema>;

/** The mode a repository without a `mode` key runs in (today's behavior). */
export const DEFAULT_STRICTNESS_MODE: StrictnessMode = 'strict';

/**
 * Resolves the effective strictness mode of a config document.
 *
 * Args:
 *   config: the loaded config (the `mode` key is optional).
 *
 * Returns:
 *   StrictnessMode: the declared mode, or `strict` when absent.
 */
export function resolveStrictnessMode(config: { mode?: StrictnessMode | undefined }): StrictnessMode {
  return config.mode ?? DEFAULT_STRICTNESS_MODE;
}

/**
 * The debt a changed-scope decision can see: whether a diff was actually
 * resolved, and how many blocking items it touches.
 */
export interface ChangedBlockingScope {
  /** True when a diff provider produced the changed-file set. */
  active: boolean;
  /** Blocking verdicts + blocking entries attributable to the diff. */
  blockingInScope: number;
}

/** One gate decision under the owner's chosen strictness. */
export interface StrictnessDecision {
  /** The mode this decision was made under. */
  mode: StrictnessMode;
  /** What strict mode would have returned (the frozen exit-code meaning). */
  strictExitCode: 0 | 1 | 2;
  /** The exit code this process actually returns. */
  exitCode: 0 | 1 | 2;
  /** True when strict mode would have blocked (1) — honest under warn. */
  wouldBlock: boolean;
  /** Blocking items that still block under this mode. */
  blockingInScope: number;
  /** Total blocking items the strict decision saw. */
  blockingTotal: number;
}

/**
 * Maps a strict gate decision onto the owner's chosen strictness. Exit
 * codes keep their meaning: 2 (config/usage) is NEVER softened, because
 * a gate that cannot evaluate honestly has nothing to report; only the
 * debt exit 1 is affected. `changed` fails closed when no diff could be
 * resolved — you cannot narrow a gate to an unknown change.
 *
 * Args:
 *   input: mode, the strict decision, the total blocking count, and
 *     (for `changed`) the resolved diff scope.
 *
 * Returns:
 *   StrictnessDecision: the effective exit code plus what it hides.
 */
export function decideStrictness(input: {
  mode: StrictnessMode;
  strictExitCode: 0 | 1 | 2;
  blockingTotal: number;
  changed?: ChangedBlockingScope;
}): StrictnessDecision {
  const total = Math.max(0, input.blockingTotal);
  const base = {
    mode: input.mode,
    strictExitCode: input.strictExitCode,
    wouldBlock: input.strictExitCode === 1,
    blockingTotal: total,
  };
  if (input.strictExitCode !== 1) {
    return { ...base, exitCode: input.strictExitCode, blockingInScope: total };
  }
  if (input.mode === 'warn') {
    return { ...base, exitCode: 0, blockingInScope: 0 };
  }
  if (input.mode === 'changed') {
    const inScope = input.changed?.active === true ? Math.max(0, input.changed.blockingInScope) : total;
    if (inScope > 0) return { ...base, exitCode: 1, blockingInScope: inScope };
    if (input.changed?.active === true) return { ...base, exitCode: 0, blockingInScope: 0 };
  }
  return { ...base, exitCode: 1, blockingInScope: total };
}

/**
 * Renders the one-line strictness summary every text report shows, so a
 * softened gate always announces itself: `mode: warn (would block: 3)`.
 *
 * Args:
 *   decision: the decision to render.
 *
 * Returns:
 *   string: the single-line summary.
 */
export function strictnessSummaryLine(decision: StrictnessDecision): string {
  if (decision.strictExitCode !== 1) return `mode: ${decision.mode}`;
  return `mode: ${decision.mode} (would block: ${String(decision.blockingTotal)})`;
}
