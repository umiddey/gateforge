/**
 * @gateforge/core — the frozen public surface of the gateforge engine.
 *
 * STABILITY CONTRACT: every export here is a stable name. Later waves
 * (graph, policy, verdict, baselines, waivers, reports, harness) add to
 * this file; existing exports are never renamed or reshaped. Each export
 * below is documented; if you need a new primitive, add it — do not
 * repurpose an existing one.
 *
 * Layers:
 * - canonical JSON + hashing (pin #1) — the substrate for ALL hashes
 * - artifact schemas (zod) + inferred types — the frozen data ontology
 *   (ADR 0001; pins #2-#6, #9, #11)
 * - fingerprints (pin #2) — baseline identity
 * - config loading (pin #6) — fail-closed `.gateforge.yml` handling
 *
 * @module @gateforge/core
 */

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (pin #1)
// ---------------------------------------------------------------------------

/**
 * Any JSON-representable value; the input domain of canonical hashing.
 */
export type { JsonValue } from './canonical-json.js';

/**
 * Type predicate narrowing an unknown value to {@link JsonValue}.
 */
export { isJsonValue } from './canonical-json.js';

/**
 * Serializes a value to GF-canonical-JSON (pin #1): UTF-8, recursively
 * key-sorted, no whitespace, integers plain. Array order is preserved.
 * Throws on NaN/Infinity (no canonical representation).
 */
export { canonicalJson } from './canonical-json.js';

/**
 * Lowercase hex sha256 of a string or byte buffer.
 */
export { sha256Hex } from './canonical-json.js';

/**
 * `sha256(canonicalJson(value))` — the single primitive behind
 * fingerprints, GPP/3 digests, and witness record ids (pin #1).
 */
export { sha256Canonical } from './canonical-json.js';

// ---------------------------------------------------------------------------
// Witness provenance (pin #7, GF-23)
// ---------------------------------------------------------------------------

/**
 * Derives the service-issued witness record id: sha256 over the
 * GF-canonical JSON of `{runId, obligationId, kind, testId, origin,
 * payload}`. The single source of truth shared by the witness
 * (issuance) and every verifier (checking).
 */
export { recordIdOf, type RecordIdentity } from './provenance.js';

/**
 * Lenient provenance check (never throws): a record is provenanced only
 * when its 64-hex recordId recomputes from its own contents. Records
 * failing it demote to claimed tier (GF-23).
 */
export { isProvenancedRecord, isWitnessedRecord } from './provenance.js';

/**
 * Witness-ledger attestation (pin #7): HMAC-SHA256 over the canonical
 * `{runId, recordIds}` set, keyed by the verifier key the tested suite
 * never receives. Makes the suite-writable manifest append tamper-
 * evident; `GET /ledger-attestation` serves the same authenticated set
 * live.
 */
export { ledgerMac, verifyLedgerMac } from './provenance.js';

// ---------------------------------------------------------------------------
// Schema version (ADR 0001)
// ---------------------------------------------------------------------------

/**
 * The only accepted `schemaVersion` on any artifact (currently `1`).
 * Unknown versions are rejected everywhere; gateforge never migrates.
 */
export { GATEFORGE_SCHEMA_VERSION } from './schemas/common.js';

// ---------------------------------------------------------------------------
// Shared artifact vocabulary
// ---------------------------------------------------------------------------

/**
 * Source location shape (file, 1-based line, 0-based col) used by
 * unresolved reasons and detector provenance.
 */
export { LocationSchema } from './schemas/common.js';
export type { Location } from './schemas/common.js';
/** Contract-name grammar: interior colons legal (`crud:update`), no leading colon. */
export { ContractNameSchema } from './schemas/common.js';
/** Inferred contract-name type. */
export type { ContractName } from './schemas/common.js';

/** Exposure enum schema: `user-facing | internal`. */
export { ExposureSchema } from './schemas/common.js';
/** Inferred exposure type. */
export type { Exposure } from './schemas/common.js';

/** Plane enum schema: `tenant | master | global`. */
export { PlaneSchema } from './schemas/common.js';
/** Inferred plane type. */
export type { Plane } from './schemas/common.js';

/** Transport enum schema: `subprocess | in-process` (ADR 0002). */
export { TransportSchema } from './schemas/common.js';
/** Inferred transport type. */
export type { Transport } from './schemas/common.js';

/** Trust-tier enum schema: `claimed | witnessed` (ADR 0001). */
export { TrustTierSchema } from './schemas/common.js';
/** Inferred trust-tier type. */
export type { TrustTier } from './schemas/common.js';

// ---------------------------------------------------------------------------
// Artifact schemas (zod) + inferred types — the frozen ontology
// ---------------------------------------------------------------------------

/**
 * Resource (plan §4.2): stable code-derived object discovered by a
 * detector — id, kind, source, location, detector version, attributes.
 */
export { ResourceSchema } from './schemas/resource.js';
/** Inferred resource type. */
export type { Resource } from './schemas/resource.js';

/**
 * Classification (plan §4.3): exposure, plane, lifecycle, ordered
 * `primaryKey`, evidence adapter. User-facing entries require an
 * adapter; internal entries default to no CRUD obligations.
 */
export { ClassificationSchema, ClassificationFileSchema, LifecycleSchema } from './schemas/classification.js';
/** Inferred per-resource classification type. */
export type { Classification } from './schemas/classification.js';
/** Inferred classifications-document type. */
export type { ClassificationFile } from './schemas/classification.js';
/** Inferred lifecycle type (create/read/update/delete + semantics). */
export type { Lifecycle } from './schemas/classification.js';

/**
 * Policy (plan §4.4): declarative when/require mapping from resource
 * attributes to required contracts. Pure data, no code escape hatch.
 */
export { PolicySchema, PolicyFileSchema, PolicyWhenSchema } from './schemas/policy.js';
/** Inferred single-policy type. */
export type { Policy } from './schemas/policy.js';
/** Inferred policies-document type. */
export type { PolicyFile } from './schemas/policy.js';
/** Inferred policy-matcher type. */
export type { PolicyWhen } from './schemas/policy.js';

/**
 * Obligation (plan §4.5): `<resourceId>:<contract>` requirement with
 * policyId and relevant lifecycle (fingerprint identity inputs).
 */
export { ObligationSchema } from './schemas/obligation.js';
/** Inferred obligation type. */
export type { Obligation } from './schemas/obligation.js';

/**
 * Claim (plan §4.6): a test's declared coverage of one obligation via
 * native framework metadata. Claims are not proof.
 */
export { ClaimSchema, ObligationIdSchema } from './schemas/claim.js';
/** Inferred claim type. */
export type { Claim } from './schemas/claim.js';
/** Inferred `<resourceId>:<contract>` id type. */
export type { ObligationId } from './schemas/claim.js';

/**
 * EvidenceRecord (plan §4.7, pins #7/#11): witness-issued trusted
 * record — recordId, runId, trust tier, obligation, kind, optional
 * bulk scope. Only `witnessed` can satisfy (GF-23).
 */
export {
  EvidenceRecordSchema,
  BulkScopeSchema,
  RecordOriginSchema,
  type RecordOrigin,
} from './schemas/evidence.js';
/** Inferred evidence-record type. */
export type { EvidenceRecord } from './schemas/evidence.js';
/** Inferred bulk-scope type (pin #11). */
export type { BulkScope } from './schemas/evidence.js';

/**
 * Waiver (ADR 0001): ALL FIVE mandatory fields — owner,
 * justificationUrl, approver, exact scope (resourceId + fingerprint),
 * expiresAt. Missing any = config error. Expiry ⇒ `invalid`, not
 * `waived`.
 */
export { WaiverSchema, WaiverScopeSchema } from './schemas/waiver.js';
/** Inferred waiver type. */
export type { Waiver } from './schemas/waiver.js';
/** Inferred waiver-scope type. */
export type { WaiverScope } from './schemas/waiver.js';

/**
 * Baseline (pin #3): `.gateforge/baselines/obligations.json` —
 * `{schemaVersion, fingerprints}` with a sorted, duplicate-free list.
 */
export { BaselineSchema, FingerprintHexSchema } from './schemas/baseline.js';
/** Inferred baseline-document type. */
export type { Baseline } from './schemas/baseline.js';
/** Inferred fingerprint-hex string type. */
export type { FingerprintHex } from './schemas/baseline.js';

/**
 * RunManifest (pin #4): runId, injected-clock startedAt, gitSha (or
 * null), provider, plugin set, attestationScope. Every verdict and
 * witnessed record references its run.
 */
export { RunManifestSchema, ChangedProviderSchema } from './schemas/run-manifest.js';
/** Inferred run-manifest type. */
export type { RunManifest } from './schemas/run-manifest.js';
/** Inferred changed-provider type. */
export type { ChangedProvider } from './schemas/run-manifest.js';

/**
 * Verdict (ADR 0001): the seven verdicts — satisfied, missing, invalid,
 * unclassified, unresolved, waived, stale. Blocking verdicts are all
 * except `satisfied` and `waived`.
 */
export { VerdictSchema } from './schemas/verdict.js';
/** Inferred verdict union type. */
export type { Verdict } from './schemas/verdict.js';

/**
 * UnresolvedReason (pin #5): `{code, detail, location{file,line,col}}` —
 * single-cause, machine-readable, no stack dumps.
 */
export { UnresolvedReasonSchema } from './schemas/verdict.js';
/** Inferred unresolved-reason type. */
export type { UnresolvedReason } from './schemas/verdict.js';

/**
 * PluginRegistration: pinned plugin identity `{id, version, transport}`
 * shared by run manifests (pin #4) and the GPP/3 handshake (pin #5).
 */
export { PluginRegistrationSchema } from './schemas/plugin.js';
/** Inferred plugin-registration type. */
export type { PluginRegistration } from './schemas/plugin.js';

// ---------------------------------------------------------------------------
// Fingerprints (pin #2)
// ---------------------------------------------------------------------------

/**
 * Obligation fingerprint (pin #2):
 * `sha256(canonical({resourceId, contract, policyId, lifecycle}))`.
 * Key-order independent; this is the identity baselines store.
 */
export { fingerprint, FingerprintInputSchema } from './fingerprints.js';
/** Blocking-entry fingerprint (phase 8 C): baseline identity for gate red
 * that is not an obligation (findings, unclassified, stale references). */
export { blockingEntryFingerprint } from './fingerprints.js';
/** Inferred fingerprint-input type. */
export type { FingerprintInput } from './fingerprints.js';

// ---------------------------------------------------------------------------
// Config (pin #6) — fail-closed `.gateforge.yml` handling
// ---------------------------------------------------------------------------

/**
 * `.gateforge.yml` document schema (pin #6): project paths, plugins,
 * policies/classifications/adapters/waivers/baselines paths, changed
 * provider, witness bounds, clock mode. Unknown keys and unknown
 * schemaVersion are rejected.
 */
export { GateforgeConfigSchema, ConfigPluginSchema } from './config/index.js';
/** Inferred `.gateforge.yml` type. */
export type { GateforgeConfig } from './config/index.js';
/** Inferred config-plugin-entry type. */
export type { ConfigPlugin } from './config/index.js';

/** One actionable config diagnostic (file, jsonPath, expected vs got). */
export type { ConfigDiagnostic } from './config/index.js';

/** Error for any fail-closed config problem; carries `.diagnostics`. */
export { GateforgeConfigError } from './config/index.js';

/**
 * Validates an already-parsed config document; throws
 * {@link GateforgeConfigError} with actionable diagnostics on failure.
 */
export { parseConfig } from './config/index.js';

/**
 * Loads and validates `.gateforge.yml` from disk (default
 * `.gateforge.yml` in cwd); fail-closed on missing/unparsable/invalid.
 */
export { loadConfig } from './config/index.js';

/**
 * Diagnostics helpers: `diagnosticsFromZodError` converts zod issues,
 * `jsonPathFor` renders JSON paths, `formatDiagnostics` renders the
 * human-readable multi-line listing used in error messages.
 */
export { diagnosticsFromZodError, jsonPathFor, formatDiagnostics } from './config/index.js';

// ---------------------------------------------------------------------------
// Resource graph (Phase 1) — detector ingestion, normalization,
// symbol-table inheritance resolution, duplicates, stale references
// ---------------------------------------------------------------------------

/**
 * Detector finding (discovery-spike lineage, e.g.
 * `DUPLICATE_TABLE_NAME`): a non-resource observation about scanned
 * sources. Canonical home of the shape; the plugin protocol carries a
 * wire-compatible copy.
 */
export { FindingSchema } from './graph/index.js';
/** Inferred finding type. */
export type { Finding } from './graph/index.js';

/**
 * Finding with detector provenance: graph-issued findings carry
 * detectorId `gateforge.graph`.
 */
export { GraphFindingSchema } from './graph/index.js';
/** Inferred graph-finding type. */
export type { GraphFinding } from './graph/index.js';

/**
 * One detector's contribution: pinned identity (pluginId + version)
 * plus the pinned discovery shape (`resources`, `unresolved`,
 * `findings`).
 */
export { DetectorOutputSchema } from './graph/index.js';
/** Inferred detector-contribution type. */
export type { DetectorOutput } from './graph/index.js';

/** Reserved resource `kind` for symbol-table class declarations. */
export { CLASS_SYMBOL_KIND, EVIDENCE_ONLY_RESOURCE_KINDS, HTTP_ENDPOINT_RESOURCE_KIND, isEvidenceOnlyKind } from './graph/index.js';
/** Attribute payload of a class-symbol resource. */
export { ClassSymbolAttributesSchema } from './graph/index.js';
/** Inferred class-symbol attribute type. */
export type { ClassSymbolAttributes } from './graph/index.js';

/** Canonical detector attribute carrying a resource's identity name. */
export { RESOURCE_NAME_ATTRIBUTE } from './graph/index.js';

/**
 * Normalized graph resource: plane-qualified `plane.name` id (D5.3),
 * repo-root-relative source, bound classification (or `null` while
 * unclassified), and detector provenance.
 */
export { GraphResourceSchema } from './graph/index.js';
/** Inferred normalized-resource type. */
export type { GraphResource } from './graph/index.js';

/** Gate-visible unresolved entry with detector provenance. */
export { GraphUnresolvedSchema } from './graph/index.js';
/** Inferred graph-unresolved type. */
export type { GraphUnresolved } from './graph/index.js';

/** A reference to a removed/renamed resource (invariant 9, GF-06). */
export { StaleReferenceSchema, StaleReferenceKindSchema } from './graph/index.js';
/** Inferred stale-reference type. */
export type { StaleReference } from './graph/index.js';
/** Inferred stale-reference-kind type. */
export type { StaleReferenceKind } from './graph/index.js';

/** Inferred resource-graph input type (detectors + watched artifacts). */
export type { ResourceGraphInput } from './graph/index.js';

/** The built resource graph: deterministic, fully sorted. */
export { ResourceGraphSchema } from './graph/index.js';
/** Inferred resource-graph type. */
export type { ResourceGraph } from './graph/index.js';

/**
 * Builds the resource graph from detector contributions +
 * classifications + watched claim/adapter/waiver populations. Pure:
 * same inputs → identical graph byte-for-byte. Throws (fail closed)
 * on an invalid classifications document.
 */
export { buildResourceGraph } from './graph/index.js';

/** The repo-wide class-symbol table and base-chain resolution. */
export { buildSymbolTable, resolveInheritedName, sortUnresolved } from './graph/index.js';
/** Inferred class-symbol type. */
export type { ClassSymbol } from './graph/index.js';
/** Inferred inheritance-resolution outcome type. */
export type { InheritanceResolution } from './graph/index.js';

/** Codepoint-wise deterministic comparison helpers (never localeCompare). */
export { compareStrings, compareLocations } from './graph/index.js';

// ---------------------------------------------------------------------------
// Automatic conservative classification (ADR 0003) — signals, policy,
// deterministic lattice, decision traces, typed blocks
// ---------------------------------------------------------------------------

/**
 * ClassificationSignal (ADR 0003 D1): a source-located, detector-
 * versioned FACT a detector emits about one classification dimension.
 * Signals carry a `basis`, never a confidence score; only
 * `code-negative-closed-world` can ever suppress, and only over a
 * complete scan.
 */
export { ClassificationSignalSchema, signalId, SignalTargetSchema, SignalDimensionSchema, SignalBasisSchema, SignalAssertionSchema, SIGNAL_DIMENSIONS } from './schemas/classification-signal.js';
/** Inferred classification-signal type. */
export type { ClassificationSignal, SignalTarget, SignalDimension, SignalBasis, SignalAssertion } from './schemas/classification-signal.js';

/**
 * ClassificationPolicy: the `classification-policy.yml` document —
 * scan roots, trusted internal entry-point categories, organization
 * internal rules (certificate inputs, never overrides), supported
 * declaration syntax, and volatile fields.
 */
export {
  ClassificationPolicySchema,
  InternalEntryPointCategorySchema,
  InternalRuleSchema,
  InternalRuleMatchSchema,
} from './schemas/classification-policy.js';
/** Inferred classification-policy type. */
export type { ClassificationPolicy, InternalEntryPointCategory, InternalRule, InternalRuleMatch } from './schemas/classification-policy.js';

/**
 * The deterministic conservative classifier (ADR 0003 D2):
 * `classifyResources()` resolves signals into effective classifications
 * or typed machine-actionable blocks; uncertainty adds obligations and
 * never removes them.
 */
export {
  RULES,
  classifyResources,
  ClassifierBlockSchema,
  ClassifierBlockCodeSchema,
  CLASSIFIER_BLOCK_CODES,
  BLOCK_DIMENSIONS,
  ClassifierContradictionSchema,
  ClassificationDecisionTraceSchema,
  EffectiveClassificationSchema,
  compileGlob,
  globMatch,
  pathInScope,
  classifierBlocking,
  resourceRef,
  runClassification,
} from './classifier/index.js';
/** Inferred classifier types. */
export type {
  ClassifierResourceRef,
  ClassificationDecision,
  ClassificationResult,
  ClassifierScanInput,
  ClassifyResourcesInput,
  ClassifierBlock,
  ClassifierBlockCode,
  ClassifierContradiction,
  ClassificationDecisionTrace,
  EffectiveClassification,
} from './classifier/index.js';

// ---------------------------------------------------------------------------
// Policy engine (Phase 1) — declarative policies → obligations
// ---------------------------------------------------------------------------

/** The lifecycle-gated CRUD contract namespace (`crud:create`, …). */
export { CRUD_CONTRACT_PREFIX } from './policy/index.js';

/**
 * Why a resource currently generates no obligations: `unclassified` or
 * `unresolved` — gate-visible blocking entries (invariants 1, 8).
 */
export { BlockingEntrySchema } from './policy/index.js';
/** Inferred blocking-entry type. */
export type { BlockingEntry } from './policy/index.js';

/** Assessment of one claim against the generated obligations. */
export { ClaimAssessmentSchema } from './policy/index.js';
/** Inferred claim-assessment type. */
export type { ClaimAssessment } from './policy/index.js';

/** The complete policy-engine result: obligations + blocking + claims. */
export { PolicyEvaluationResultSchema } from './policy/index.js';
/** Inferred policy-evaluation-result type. */
export type { PolicyEvaluationResult } from './policy/index.js';

/** Fail-closed policy-engine error (invalid policy document / contract). */
export { PolicyEvaluationError } from './policy/index.js';

/**
 * Evaluates policies against a built graph: lifecycle-gated obligation
 * generation (plan §5.2), no CRUD obligations for internal resources
 * (ADR 0001), blocking entries for unclassified/unresolved resources,
 * and claim assessment. Pure; deterministic.
 */
export { evaluatePolicies, lifecycleAllowsContract } from './policy/index.js';

// ---------------------------------------------------------------------------
// Verdict engine (Phase 2, pin #9) — the pure obligation evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates ONE obligation against claims, records, waivers,
 * classification, and the injected clock: pure `evaluateObligation(
 * obligation, {claims, records, waivers, classification, now})`
 * → `{verdict, reason, recordIds}` (pin #9). `satisfied` requires
 * complete witnessed evidence (D2, GF-23); same-entity enforcement is
 * column-keyed for composite identity (D3); expired waivers yield
 * `invalid` (D4).
 */
export { evaluateObligation } from './verdict/index.js';

/**
 * Batch wrapper: evaluates obligations against one context and returns
 * report-ready entries (obligation + verdict + trustTier), sorted by
 * obligation id.
 */
export { evaluateObligations } from './verdict/index.js';

/** The five gate-blocking verdicts (`satisfied`/`waived` are clean). */
export { BLOCKING_VERDICTS } from './verdict/index.js';
export {
  registerContractVerifier,
  verifierFor,
  registeredNamespaces,
  type ClaimEvidenceInput,
  type ClaimOutcome,
  type ContractVerifier,
} from './verdict/index.js';

/** Fail-closed verdict-engine error (malformed obligation / clock). */
export { GateforgeVerdictError } from './verdict/index.js';

/** Normalizes the injected clock (`Date | string`) to a `Date`. */
export { parseInstant } from './verdict/index.js';

/** The pinned pin-#9 result shape: `{verdict, reason, recordIds}`. */
export type { VerdictOutcome } from './verdict/index.js';
/** Report-ready per-obligation verdict (adds obligation + trustTier). */
export type { ObligationVerdict } from './verdict/index.js';
/** The pin-#9 evaluation context. */
export type { VerdictContext } from './verdict/index.js';
/** A waiver plus the engine-only `ownerStale` flag (GF-17). */
export type { WaiverRef } from './verdict/index.js';

// ---------------------------------------------------------------------------
// Waivers (GF-15/16/17) — fail-closed directory loading
// ---------------------------------------------------------------------------

/**
 * Loads and validates every `*.json` waiver file in a directory against
 * the injected clock: all five fields mandatory (GF-15), expiry judged
 * by `now` (GF-16), optional stale-owner hook (GF-17). Synchronous.
 */
export { loadWaivers } from './waivers/index.js';

/** Fail-closed waiver-configuration error; carries every problem found. */
export { GateforgeWaiverError } from './waivers/index.js';
/** One file-scoped waiver-loading problem. */
export type { WaiverProblem } from './waivers/index.js';
/** Loader result partitions: valid / stale-owner / expired. */
export type { WaiverLoadResult, WaiverLoadOptions } from './waivers/index.js';

// ---------------------------------------------------------------------------
// Baselines (GF-07/08) — strict-subset update semantics (invariant 4)
// ---------------------------------------------------------------------------

/** Loads and validates `.gateforge/baselines/obligations.json` (pin #3). */
export { loadBaseline } from './baselines/index.js';

/**
 * Whether a baseline update is a strict subset (invariant 4): only
 * removals allowed — `[A, B] → [A, NEW]` fails (GF-07), `[A, B] → [A]`
 * passes (GF-08).
 */
export { canUpdate } from './baselines/index.js';

/** Builds the next baseline, enforcing the strict-subset rule. */
export { updateBaseline } from './baselines/index.js';

/** Serializes a baseline to reviewable 2-space JSON with newline. */
export { serializeBaseline } from './baselines/index.js';

/** Writes a baseline, creating parent directories as needed. */
export { writeBaseline } from './baselines/index.js';

/** Fail-closed baseline error (load, validation, or update rejection). */
export { GateforgeBaselineError } from './baselines/index.js';

/**
 * THE ONE SANCTIONED BULK-ADD (phase 8 workstream C): builds the
 * adoption baseline without the subset check — `gateforge adopt` is the
 * only caller; `updateBaseline` stays shrink-only (GF-07/08 unchanged).
 */
export { adoptBaseline } from './baselines/index.js';

/** The adoption record (phase 8 C): the loud, one-time bulk-add receipt. */
export { AdoptionRecordSchema } from './schemas/adoption.js';
/** Inferred adoption-record type. */
export type { AdoptionRecord } from './schemas/adoption.js';
/** Loads `.gateforge/baselines/adoption.json` (null = pre-adoption). */
export { loadAdoptionRecord, ADOPTION_RECORD_FILENAME } from './baselines/adoption.js';
/** Writes the adoption record, creating parent directories as needed. */
export { writeAdoptionRecord } from './baselines/adoption.js';
/**
 * The classification layer of the adoption (two-layer adoption):
 * `adoptClassificationBlocked` normalizes the captured ids for the
 * receipt; `shrinkClassificationBlocked` is the set's ONLY post-adoption
 * mutation — strict-subset, shrink-only (GF-07/08 mirrored).
 */
export { adoptClassificationBlocked, shrinkClassificationBlocked } from './baselines/adoption.js';

// ---------------------------------------------------------------------------
// Reports (contract 4, pin #10) — canonical JSON / SARIF 2.1.0 / text
// ---------------------------------------------------------------------------

/**
 * Renders per-obligation verdicts: `json` (GF-canonical JSON),
 * `sarif` (SARIF 2.1.0 projection, pin #10), or `text` (the
 * invariant-8 detector → policy → obligation → evidence-gap trace plus
 * waiver counts). Deterministic; identical inputs serialize identically.
 */
export { renderRun } from './report/index.js';

/** Exit codes (contract 4): 0 clean/waived, 1 unresolved, 2 config. */
export { runExitCode } from './report/index.js';
/** The run exit-code union. */
export type { RunExitCode } from './report/index.js';
/** Waiver-population counts for report summaries. */
export type { WaiverCounts } from './report/index.js';
/** Options for renderRun (format, blocking entries, counts, manifest). */
export type { RenderRunOptions } from './report/index.js';

// ---------------------------------------------------------------------------
// Fixture harness (G7) — deterministic temp repos, injected clock/env,
// gate-runner pipeline, GF-19 malformed-source rule, red-probe discipline
// ---------------------------------------------------------------------------

/**
 * Temporary git repository under the OS tmpdir with pinned
 * author/committer identity and dates: identical file-tree specs yield
 * identical commit SHAs. `withTempRepo` wraps a fixture body with
 * guaranteed cleanup.
 */
export { FIXED_GIT_DATE, TempRepo, withTempRepo } from './testing/index.js';
/** Inferred git-invocation result type. */
export type { GitResult, TempRepoOptions } from './testing/index.js';

/**
 * Injected clocks: `{fixedAt}` constant, `{sequence}` ordered instants
 * (exhaustion throws — no silent repetition), or `{startAt, stepMs}`
 * stepping. `now()` always returns canonical ISO-8601.
 */
export { makeClock, toIso } from './testing/index.js';
/** Inferred clock types. */
export type { ClockSpec, TestClock } from './testing/index.js';

/**
 * Injected environment (`withEnv`) and changed-file provider stubs:
 * `fakeProvider` impersonates any provider identity from an explicit
 * list; `localStagedProvider` reads a temp repo's real index — the two
 * halves of GF-09 parity.
 */
export {
  fakeProvider,
  localStagedProvider,
  normalizeChangedFiles,
  withEnv,
} from './testing/index.js';
/** Inferred changed-file-provider type. */
export type { ChangedFileProvider } from './testing/index.js';

/**
 * The GF-19 rule: malformed source ⇒ guaranteed `PARSE_ERROR` finding
 * with a line number, no crash, no silent resources. `stubDetector` is
 * the in-process toy-parser detector fixtures use; G5 reuses the rule
 * with its real detector audit.
 */
export {
  PARSE_ERROR_FINDING,
  applyParseErrorRule,
  hasParseErrors,
  stubDetector,
} from './testing/index.js';
/** Inferred parse-audit and rule types. */
export type {
  ParseAudit,
  ParseAuditEntry,
  ParseErrorRuleInput,
  ParseErrorRuleResult,
  StubDetectorOptions,
  StubDetectorResult,
} from './testing/index.js';

/**
 * Gate-runner helper: discover → obligations → evaluate over a temp repo
 * with injected clock/env/provider and a pin-#9 evaluator (fixtures use
 * a local double; the real verdict engine conforms structurally).
 */
export { runGates } from './testing/index.js';
/** Inferred gate-runner types. */
export type {
  DetectorContribution,
  EvaluatorVerdict,
  GateRunResult,
  ObligationEvaluator,
  ObligationEvaluatorInput,
  GateRunVerdict,
  RunGatesInput,
} from './testing/index.js';

/**
 * RED-PROBE discipline: run the same guard against correct and
 * deliberately-broken behavior; a broken probe that passes is a fake
 * green and fails loudly. Suite-level proof spawns vitest twice
 * (`spawnVitest` + `writeProbeSuite`); see docs/testing/RED_PROBE.md.
 */
export {
  RedProbeFailure,
  RedProbeSuiteError,
  cleanupProbeSuite,
  formatProbeRecords,
  runRedProbe,
  runRedProbes,
  spawnVitest,
  writeProbeRecords,
  writeProbeSuite,
} from './testing/index.js';
/** Inferred red-probe types. */
export type {
  RedProbe,
  RedProbeRecord,
  VitestRunOptions,
  VitestRunResult,
} from './testing/index.js';
