/**
 * The ONE reader of the owner-answers document
 * (`.gateforge/classification-policy.yml`).
 *
 * Two callers need it and neither may re-derive it: the pipeline, which
 * composes the classifier policy and hands the `planes:` / `endpoints:`
 * sections to the detectors, and `collectRoutePlaneFacts`, which compiles
 * endpoints for the `init` plane proposals and must see the SAME
 * declarations. Reading the file in two places is how the two drift, and
 * a proposal pass that disagrees with the run it proposes for is worse
 * than no proposal at all.
 *
 * The read FAILS CLOSED on every way the document can be wrong: a
 * pre-0.11 owner-answer file still on disk, a scanner key that moved to
 * `.gateforge.yml`, and an invalid document each raise a `UsageError`
 * naming the command that fixes it.
 */
import {
  ClassificationPolicySchema,
  compareStrings,
  isMovedScannerKey,
  type ClassificationPolicy,
  type GateforgeConfig,
} from '@gate-forge/core';
import { UsageError } from './errors.js';
import { rejectMovedOwnerDocuments } from './moved-owner-documents.js';
import { resolveRepoPath } from './repo-path.js';
import { firstIssueText, loadYaml } from './yaml.js';

/**
 * Loads, validates and returns the owner-answers document.
 *
 * @param cwd - Repository root.
 * @param config - The loaded `.gateforge.yml`; only its
 *   `classificationPolicy` path is read.
 * @returns The validated answers document.
 * @throws UsageError (exit 2) when a moved owner-answer file is still
 *   present, when the document carries a key that moved to `.gateforge.yml`
 *   under `scan:`, or when the document is invalid.
 */
export function loadOwnerAnswers(cwd: string, config: GateforgeConfig): ClassificationPolicy {
  rejectMovedOwnerDocuments(cwd);
  const raw = loadYaml(resolveRepoPath(cwd, config.classificationPolicy), 'classification-policy');
  // Upgrade posture (0.11.0): the four scanner settings moved OUT of this
  // document into `.gateforge.yml` under `scan:`. Checked BEFORE the parse,
  // because the strict schema would only report "unrecognized key" — this
  // refusal names the command that moves them, like every other
  // consolidated declaration.
  const movedKeys = Object.keys(raw ?? {})
    .filter((key) => isMovedScannerKey(key))
    .sort(compareStrings);
  if (movedKeys.length > 0) {
    throw new UsageError(
      `${config.classificationPolicy} carries ${movedKeys.join(', ')}: since 0.11 the scanner ` +
        'settings live in .gateforge.yml under `scan:` — run `gateforge migrate` (preview, then ' +
        '--confirm), then re-approve the policy digest (gateforge enforcement pin --pin-file <path> --confirm)',
    );
  }
  const parsed = ClassificationPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `classification-policy document is invalid: ${firstIssueText(parsed.error, 'unknown issue')}`,
    );
  }
  return parsed.data;
}
