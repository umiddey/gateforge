/**
 * ADOPTION MODE — the one commit a repository with no gate may make
 * weaker in SCOPE, never in trust (0.10.2; REFERENCE "Adoption mode").
 *
 * The commit that wires the gate is the commit the gate cannot judge: it
 * always touches `.gateforge.yml`, the runner config and the specs, every
 * one of them a gate-defining input, so the evaluation expands to every
 * obligation in the repository — while the only affordable proof of a
 * large repository is a changed-scope receipt. The generated hook
 * (`check --staged`) refused that receipt as a scope mismatch, so every
 * adopting repository had to bypass the hook exactly once.
 *
 * A commit is an ADOPTION COMMIT when, and only when:
 *
 * 1. HEAD has NO gate — no `enforcement` block in its config, and no
 *    generated `.gateforge/hooks/gateforge-check.mjs`; and
 * 2. the candidate DOES wire one (it introduces the generated gate
 *    wiring, or turns `enforcement` on); and
 * 3. the candidate's trusted policy digest matches the owner-approved
 *    pin — checked by the CALLER, which reaches this verdict only after
 *    that gate passed, so a weakened candidate still fails closed.
 *
 * Condition 1 is what makes it safe: it is monotone and one-shot. Once a
 * gate exists at HEAD the condition can never hold again, so no later
 * commit can re-enter adoption mode. There is no flag, no config key and
 * no environment variable — nothing a candidate can set.
 *
 * This module only DECIDES. What adoption mode changes is the caller's
 * receipt-coverage requirement; it never relaxes `CHANGE_UNMAPPED`,
 * never relaxes the policy pin, and never forgives an obligation.
 */
import { parse as parseYaml } from 'yaml';

/** The generated pre-commit hook `init --blocking` installs. */
export const GENERATED_HOOK_PATH = '.gateforge/hooks/gateforge-check.mjs';

/** The generated gate wiring directories a first adoption commit writes. */
const GENERATED_WIRING_PREFIXES: readonly string[] = ['.gateforge/hooks/', '.gateforge/ci/'];

/** What the caller knows about the candidate it is judging. */
export interface AdoptionCommitInput {
  /**
   * The base revision's text reader (HEAD for the staged diff). `null`
   * means the base could not be read at all — then nothing may be claimed
   * about the gate at HEAD, and adoption mode is refused.
   */
  baseText: ((path: string) => string | null) | null;
  /** Repo-relative config path the candidate declares (always `.gateforge.yml`). */
  configPath: string;
  /** Whether the CANDIDATE's own config carries an enforcement block. */
  candidateEnforcement: boolean;
  /** The frozen change set this evaluation grades. */
  changedFiles: readonly string[];
}

/** Whether this candidate is an adoption commit, and why not when it is not. */
export interface AdoptionCommitVerdict {
  /** True only when conditions 1–3 hold. */
  adoptionCommit: boolean;
  /** One sentence explaining a refusal; empty when it is an adoption commit. */
  reason: string;
}

/**
 * Whether the base revision's config document declares an `enforcement`
 * block — the header that turns a configured repository into a gated one.
 *
 * A document that cannot be parsed is treated as DECLARING one: the
 * engine refuses to read a base it does not understand as "no gate
 * there", because that reading would hand adoption mode to any candidate
 * that could make HEAD unreadable.
 *
 * @param text: the base revision's config bytes, or null when absent.
 *
 * @returns
 *   boolean: true when an enforcement block is present.
 */
function declaresEnforcement(text: string | null): boolean {
  if (text === null) return false;
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch {
    return true;
  }
  if (typeof document !== 'object' || document === null || !('enforcement' in document)) return false;
  const enforcement: unknown = document.enforcement;
  return typeof enforcement === 'object' && enforcement !== null && Object.keys(enforcement).length > 0;
}

/**
 * Decides whether the candidate is an ADOPTION COMMIT.
 *
 * @param input: the base reader, the candidate's config path and
 *   enforcement header, and the frozen change set.
 *
 * @returns
 *   AdoptionCommitVerdict: the decision and, for a refusal, the one
 *   sentence that says why. The caller checks the policy pin itself, so
 *   reaching a verdict here never weakens the owner approval.
 */
export function evaluateAdoptionCommit(input: AdoptionCommitInput): AdoptionCommitVerdict {
  if (input.baseText === null) {
    return {
      adoptionCommit: false,
      reason: 'the base revision could not be read, so what gate exists at HEAD is unknown',
    };
  }
  const baseEnforcement = declaresEnforcement(input.baseText(input.configPath));
  const baseHook = input.baseText(GENERATED_HOOK_PATH);
  if (baseEnforcement || baseHook !== null) {
    return {
      adoptionCommit: false,
      reason:
        'the base revision already carries the gate, so this commit is judged exactly like every later one',
    };
  }
  const wiresGate = input.changedFiles.some(
    (file) => file === GENERATED_HOOK_PATH || GENERATED_WIRING_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
  if (!wiresGate && !input.candidateEnforcement) {
    return {
      adoptionCommit: false,
      reason: 'the candidate wires no gate, so there is nothing to adopt',
    };
  }
  return { adoptionCommit: true, reason: '' };
}