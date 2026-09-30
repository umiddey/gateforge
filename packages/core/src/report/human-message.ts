import type { CauseCode } from '../schemas/verdict.js';

/** Minimal report data required to build a consistent human-readable message. */
export interface HumanMessageEntry {
  /** The stable cause code, when the entry has one. */
  cause?: CauseCode | null;
  /** Plain-language detail or verdict reason. */
  detail?: string;
  /** Resource or obligation identity used to choose a useful command. */
  id?: string;
  /** Suggested action associated with the cause. */
  nextAction?: string | null;
  /** Verdict reason, when the entry represents an obligation. */
  reason?: string | null;
  /** Blocking kind or verdict name used when no cause is available. */
  type?: string;
}

/**
 * Prefix of the refusal a receipt sealed by an older engine produces. The
 * receipt records the version that sealed it, so a version disagreement is
 * reportable fact, and it is the one cause a user acts on by re-sealing.
 */
export const ENGINE_UPGRADE_REFUSAL_PREFIX =
  'require-e2e: this receipt was sealed by Gateforge ';

/**
 * Builds the common sentence, copyable command, and final cause marker for a report entry.
 *
 * Args:
 *   entry: report detail, identity, cause, and suggested action.
 *
 * Returns:
 *   string: one deterministic sentence followed by a runnable command and `[CODE]`.
 */
export function humanMessage(entry: HumanMessageEntry): string {
  const sentence = (entry.reason ?? entry.detail ?? 'Gateforge found an unresolved item').trim();
  const command =
    entry.nextAction?.startsWith('gateforge ')
      ? entry.nextAction
      : entry.cause === 'TEST_MAPPING_MISSING' ||
          entry.cause === 'TEST_MAPPING_AMBIGUOUS' ||
          entry.cause === 'TEST_MAPPING_STALE' ||
          entry.cause === 'TEST_KIND_UNKNOWN'
        ? 'gateforge tests suggest'
        : entry.id !== undefined
          ? `gateforge explain ${entry.id}`
          : 'gateforge discover --json';
  const code = entry.cause ?? entry.type?.toUpperCase().replaceAll('-', '_') ?? 'BLOCKING_FINDING';
  return `${sentence}. Run \`${command}\`. [${code}]`;
}
