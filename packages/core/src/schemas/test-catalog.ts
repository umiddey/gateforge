/**
 * Test-catalog schemas (plan 2026-09-13 §5.1 row 1 + §5.2): the derived
 * inventory of a repository's existing tests.
 *
 * Identity rules (§5.2, hard):
 * - The `logicalKey` is the stable manual-mapping identity: an explicit
 *   slug when a mapping declares one, otherwise deterministically derived
 *   from runner + project + repo-relative file + full title path
 *   ({@link deriveLogicalKey}).
 * - Line numbers are DIAGNOSTICS, never identity: adding a comment keeps
 *   the logical key stable while `sourceDigest` changes.
 * - Duplicate logical keys are a typed parse error listing BOTH sources —
 *   never "bind the first match".
 *
 * Discovery is data, not a gate result: `unresolved` entries and
 * `parseErrors` are first-class catalog rows so a failed scan can never
 * be misread as "no tests".
 */
import { z } from 'zod';
import { LocationSchema, SchemaVersionField } from './common.js';

/** Runner names with an implemented adapter (plan phase 2 item 6). */
export const SUPPORTED_TEST_RUNNERS = ['playwright', 'pytest'] as const;

/**
 * A runner name. `playwright` and `pytest` are the adapters implemented
 * so far; any other string is legal data (an adapter must exist before
 * its entries drive gates — plan phase 2 item 6).
 */
export const TestRunnerSchema = z.string().min(1);

/** Inferred test-runner type. */
export type TestRunner = z.infer<typeof TestRunnerSchema>;

/**
 * What a test IS (plan §3.2). `unknown` is a kept, visible outcome.
 *
 * `server-e2e` (server-witnessed persistence channel) declares an
 * existing test whose persistence evidence is witnessed SERVER-side:
 * the engine's own adapter probe observes the app database directly,
 * because the obligated state (e.g. a transactional outbox) can never
 * honestly appear in a UI. Browser-kind tests never grade through it —
 * the witness stamps the channel only for obligations registered
 * `server-e2e` on the verifier-key supervisor surface, and the verdict
 * engine admits `channel: 'server'` records only with that stamp.
 */
export const TestKindSchema = z.enum([
  'browser-e2e',
  'server-e2e',
  'api-e2e',
  'unit',
  'integration',
  'component',
  'unknown',
]);

/** Inferred test-kind type. */
export type TestKind = z.infer<typeof TestKindSchema>;

/** Catalog row discovery status (plan §5.1 row 1). */
export const DiscoveryStatusSchema = z.enum(['discovered', 'unresolved', 'parse-error']);

/** Inferred discovery-status type. */
export type DiscoveryStatus = z.infer<typeof DiscoveryStatusSchema>;

/** Reconciliation outcome against the runner's native enumeration. */
export const ReconciliationStatusSchema = z.enum(['matched', 'static-only', 'list-only', 'unavailable']);

/** Inferred reconciliation-status type. */
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

/** One inference rule that fired, with the code location that fed it. */
export const RuleEvidenceSchema = z
  .object({
    /** Stable rule id, e.g. `browser-fixture` or `category-keywords`. */
    ruleId: z.string().min(1),
    /** Single-cause explanation of what the rule observed. */
    evidence: z.string().min(1),
    /** Source location the rule's evidence came from. */
    location: LocationSchema,
  })
  .strict();

/** Inferred rule-evidence type. */
export type RuleEvidence = z.infer<typeof RuleEvidenceSchema>;

/**
 * A strong kind signal: a rule that proposes a {@link TestKind} with its
 * code evidence. Conflicting proposals resolve to `unknown` — never to
 * whichever rule ran last (plan phase 2 item 5: no opaque confidence).
 */
export const KindSignalSchema = RuleEvidenceSchema.extend({
  /** The kind this rule proposes. */
  kind: TestKindSchema,
}).strict();

/** Inferred kind-signal type. */
export type KindSignal = z.infer<typeof KindSignalSchema>;

/**
 * A weak signal (title/folder hints). Weak signals are recorded for the
 * agent but must NEVER decide a kind by themselves (plan §3.2).
 */
export const WeakSignalSchema = RuleEvidenceSchema.strict();

/** Inferred weak-signal type. */
export type WeakSignal = z.infer<typeof WeakSignalSchema>;

/**
 * A behavior-category hint (plan §3.2): extensible dotted labels such as
 * `persistence.create`. Hints only — a label never creates or satisfies
 * a contract.
 */
export const CategorySignalSchema = z
  .object({
    /** Dotted category label, e.g. `persistence.delete`. */
    label: z.string().min(1),
    /** The rule that produced the hint. */
    ruleId: z.string().min(1),
    /** Source location the hint came from. */
    location: LocationSchema,
  })
  .strict();

/** Inferred category-signal type. */
export type CategorySignal = z.infer<typeof CategorySignalSchema>;

/**
 * Suppression/mock signals: skip, only, fixme, and known mock patterns.
 * These qualify (and can disqualify) later proof; discovery only records
 * them with locations (plan §3.2/§3.3).
 */
export const SuppressionSignalKindSchema = z.enum(['skip', 'only', 'fixme', 'mock']);

/** Inferred suppression-signal-kind type. */
export type SuppressionSignalKind = z.infer<typeof SuppressionSignalKindSchema>;

/** One recorded suppression/mock signal with its location. */
export const SuppressionSignalSchema = z
  .object({
    kind: SuppressionSignalKindSchema,
    /** Single-cause explanation, e.g. `test.skip modifier` or `page.route`. */
    detail: z.string().min(1),
    location: LocationSchema,
  })
  .strict();

/** Inferred suppression-signal type. */
export type SuppressionSignal = z.infer<typeof SuppressionSignalSchema>;

/**
 * One catalog row (plan §5.1 row 1): what test exists, plus the signals
 * discovery gathered. Rows are NEVER dropped — an unresolvable call is
 * a row with `discoveryStatus: 'unresolved'`, not an omission.
 */
export const TestCatalogEntrySchema = z
  .object({
    /**
     * Stable mapping identity (§5.2): explicit slug or the deterministic
     * derivation of {@link deriveLogicalKey}. Unique across the catalog.
     */
    logicalKey: z.string().min(1),
    /** Runner the test executes under, e.g. `playwright`. */
    runner: TestRunnerSchema,
    /**
     * Runner project, e.g. `chromium`. `null` for rows no native
     * enumeration has bound to a project yet (static-only rows).
     */
    project: z.string().min(1).nullable(),
    /** Repo-root-relative posix path of the test file. */
    file: z.string().min(1),
    /** Full title path: enclosing describe titles, then the test title. */
    titlePath: z.array(z.string().min(1)).min(1),
    /** Last segment of {@link titlePath} (the test's own title). */
    title: z.string().min(1),
    /** Where the test is declared (file:startLine:startCol) — diagnostics. */
    sourceLocation: LocationSchema,
    /**
     * Framework repeat/parameter identity, e.g. a `test.each` template
     * slot or the native spec id. `null` when the case is not
     * parameterized.
     */
    parameterIdentity: z.string().min(1).nullable(),
    /** sha256 of the test file's bytes (stale-proof check input, §5.2). */
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/, 'sourceDigest must be 64-char lowercase hex'),
    /**
     * Which enumeration resolved this row's identity (plan phase 2 item
     * 4, static-first with native fallback): `'static'` when the static
     * scan derived the case (the native list at most confirmed it);
     * `'native-list'` when ONLY the runner's native enumeration produced
     * it (the static scan could not or did not derive it). Absent for
     * rows whose enumeration is neither (e.g. pytest collection).
     * Honesty label: a `'native-list'` row's kind/category signals are
     * necessarily weaker — its call-site facts were never read.
     */
    resolutionOrigin: z.enum(['static', 'native-list']).optional(),
    discoveryStatus: DiscoveryStatusSchema,
    /**
     * Reconciliation verdict against the runner's native enumeration.
     * `unavailable` = no native enumeration ran (e.g. no playwright
     * config); recorded, not silent.
     */
    reconciliation: ReconciliationStatusSchema,
    /** The kind inference concluded (default `unknown`; §3.2). */
    inferredKind: TestKindSchema,
    /** Strong kind rules that fired with their code evidence. */
    kindSignals: z.array(KindSignalSchema),
    /** Weak title/folder hints — never kind-deciding (§3.2). */
    weakSignals: z.array(WeakSignalSchema),
    /** Every inference rule that fired (rule id + source location). */
    rulesFired: z.array(RuleEvidenceSchema),
    /** Behavior-category hints (labels only, never proof; §3.2). */
    categorySignals: z.array(CategorySignalSchema),
    /** skip/only/fixme/mock signals with locations (§3.2). */
    suppressionSignals: z.array(SuppressionSignalSchema),
    /** Why the row is `unresolved` (required in that state). */
    unresolvedReason: z
      .object({ code: z.string().min(1), detail: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.discoveryStatus === 'unresolved' && entry.unresolvedReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['discoveryStatus'],
        message: "unresolved entries require 'unresolvedReason' (fail closed: an unexplained gap is not data)",
      });
    }
    if (entry.discoveryStatus !== 'unresolved' && entry.unresolvedReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['unresolvedReason'],
        message: "'unresolvedReason' is only valid with discoveryStatus 'unresolved'",
      });
    }
    if (entry.title !== entry.titlePath[entry.titlePath.length - 1]) {
      ctx.addIssue({
        code: 'custom',
        path: ['title'],
        message: "title must equal the last segment of titlePath",
      });
    }
  });

/** Inferred test-catalog-entry type. */
export type TestCatalogEntry = z.infer<typeof TestCatalogEntrySchema>;

/** One parser failure with its source location (never swallowed). */
export const CatalogParseErrorSchema = z
  .object({
    /** Repo-root-relative posix path of the file that failed to parse. */
    file: z.string().min(1),
    /** The parser's message, first line only (no stack dumps). */
    message: z.string().min(1),
    /** Where the parser failed. */
    location: LocationSchema,
  })
  .strict();

/** Inferred catalog-parse-error type. */
export type CatalogParseError = z.infer<typeof CatalogParseErrorSchema>;

/** One runner-level summary line (playwright reconciliation, pytest suites). */
export const RunnerSummarySchema = z
  .object({
    /** Runner the summary is about, e.g. `playwright` or `pytest`. */
    runner: TestRunnerSchema,
    /** Suite/config name (`playwright` for the native reconciliation). */
    name: z.string().min(1),
    /** `discovered` = enumerated; `registered` = configured, not collected. */
    status: z.enum(['discovered', 'registered', 'unavailable']),
    /** Single-cause human detail (e.g. why enumeration is unavailable). */
    detail: z.string().min(1),
  })
  .strict();

/** Inferred runner-summary type. */
export type RunnerSummary = z.infer<typeof RunnerSummarySchema>;

/**
 * The derived test catalog (plan §5.1). Every case is a row in
 * `entries`; `unresolved` and `parseErrors` are the typed roll-ups of
 * the rows needing attention. `inventoryComplete` captures scan
 * completeness SEPARATELY from classification uncertainty: `unknown`
 * kinds do not make an inventory incomplete, a failed scan does.
 */
export const TestCatalogSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Every discovered case, sorted by (file, titlePath, project). */
    entries: z.array(TestCatalogEntrySchema),
    /** Roll-up of entries with discoveryStatus `unresolved`. */
    unresolved: z.array(
      z
        .object({
          /** Logical key of the corresponding entry row. */
          logicalKey: z.string().min(1),
          /** Stable reason code, e.g. `traversal-budget-exceeded`. */
          code: z.string().min(1),
          /** Single-cause human explanation. */
          detail: z.string().min(1),
          /** Call/import location the gap was detected at. */
          location: LocationSchema,
        })
        .strict(),
    ),
    /** Parser failures with locations — a failed scan is never "no tests". */
    parseErrors: z.array(CatalogParseErrorSchema),
    /** True only when every scan and reconciliation step completed. */
    inventoryComplete: z.boolean(),
    /** Per-runner status lines (native reconciliation, pytest suites). */
    runnerSummaries: z.array(RunnerSummarySchema),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    // §5.2: validate uniqueness — duplicate keys list BOTH sources, and
    // never bind the first match.
    const seen = new Map<string, TestCatalogEntry>();
    for (let index = 0; index < catalog.entries.length; index += 1) {
      const entry = catalog.entries[index];
      if (entry === undefined) continue;
      const previous = seen.get(entry.logicalKey);
      if (previous !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'logicalKey'],
          message:
            `duplicate logical key '${entry.logicalKey}' — sources: ` +
            `${previous.file}:${String(previous.sourceLocation.line)} and ` +
            `${entry.file}:${String(entry.sourceLocation.line)}`,
        });
        continue;
      }
      seen.set(entry.logicalKey, entry);
    }
    // The roll-up arrays must agree with the entry rows (a mismatch would
    // let a consumer read "no unresolved" while a row says otherwise).
    const unresolvedKeys = new Set(catalog.unresolved.map((entry) => entry.logicalKey));
    for (const entry of catalog.entries) {
      const inRollup = unresolvedKeys.has(entry.logicalKey);
      if (entry.discoveryStatus === 'unresolved' && !inRollup) {
        ctx.addIssue({
          code: 'custom',
          path: ['unresolved'],
          message: `entry '${entry.logicalKey}' is unresolved but missing from the unresolved roll-up`,
        });
      }
    }
  });

/** Inferred test-catalog type. */
export type TestCatalog = z.infer<typeof TestCatalogSchema>;

/** One catalog roll-up row (inferred, for builders). */
export type CatalogUnresolved = z.infer<
  (typeof TestCatalogSchema)['shape']['unresolved']['element']
>;

/** Inputs of the deterministic logical-key derivation (§5.2). */
export interface LogicalKeyInput {
  /** Runner name, e.g. `playwright`. */
  runner: string;
  /** Runner project, or `null` when none is bound yet. */
  project: string | null;
  /** Repo-root-relative posix file path. */
  file: string;
  /** Full title path (describe stack + title). */
  titlePath: readonly string[];
}

/**
 * Derives the deterministic logical key for a test (§5.2): runner,
 * project (`-` when unbound), repo-relative file, then the full title
 * path joined with `>`. Pure string shaping — stable across line moves
 * and comment edits (line numbers are never identity input).
 *
 * Args:
 *   input: runner, project, file, and title path.
 *
 * Returns:
 *   string: e.g. `playwright:chromium:e2e/accounts.spec.ts:Accounts>creates an account`.
 */
export function deriveLogicalKey(input: LogicalKeyInput): string {
  return `${input.runner}:${input.project ?? '-'}:${input.file}:${input.titlePath.join('>')}`;
}
