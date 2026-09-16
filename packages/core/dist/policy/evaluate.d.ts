/**
 * Policy engine (plan §5.2, G2): evaluates declarative policies
 * (`PolicyFile`) against the classified resources of a built
 * {@link ResourceGraph} and produces obligations plus the blocking
 * verdict entries the gate must stay visible for (invariants 1, 8).
 *
 * Semantics (plan §5.2 + ADR 0001):
 * - `crud:create|read|update|delete` obligations are LIFECYCLE-GATED:
 *   a contract is emitted only when the classification's lifecycle
 *   flag for that operation is `true` (user-facing + `lifecycle.create`
 *   ⇒ `crud:create`, etc.). Non-uniform lifecycles fall out naturally:
 *   immutable/read-only resources generate only `crud:read`, append-only
 *   resources `crud:create` + `crud:read`, archive-not-delete resources
 *   `crud:delete` with `deleteSemantics: 'archive'` in the fingerprint.
 * - Non-`crud:` contracts pass through ungated (the policy author
 *   explicitly required them).
 * - Internal resources generate NO CRUD obligations — their claims are
 *   invalid (ADR 0001). Non-CRUD contracts still apply.
 * - Unclassified and unresolved resources produce blocking entries and
 *   no obligations until classified/resolved, but stay gate-visible.
 *   So do detector/graph `findings` (a partial discovery must never
 *   yield a green gate) and `stale` references (invariant 9).
 * - Policies are evaluated in file order; the first policy generating
 *   a given `<resourceId>:<contract>` owns it (obligation ids are
 *   unique identities — pin #1's fingerprint keys on them).
 */
import { z } from 'zod';
import { type ContractName } from '../schemas/common.js';
import { type PolicyFile } from '../schemas/policy.js';
import { type Claim } from '../schemas/claim.js';
import { type ResourceGraph } from '../graph/schema.js';
/** The CRUD contract namespace gated by lifecycle flags. */
export declare const CRUD_CONTRACT_PREFIX = "crud:";
/**
 * The persistence-level CRUD contract namespace (audit round 5):
 * lifecycle-gated exactly like `crud:`, but graded on the witness's own
 * engine-side observations (absence/presence, before/after deltas,
 * owner-declared archive state). UI-semantic `crud:` contracts stay
 * fail-closed in the verdict engine until a witness-controlled UI
 * observation channel exists.
 */
export declare const PERSISTENCE_CONTRACT_PREFIX = "persistence:";
/**
 * Fail-closed policy-engine error: thrown for policy documents that
 * are structurally invalid (zod) or use the `crud:` namespace with an
 * unknown operation — a config/usage problem, never a silent skip.
 */
export declare class PolicyEvaluationError extends Error {
    constructor(message: string);
}
/** Why a resource currently generates no obligations. */
export declare const BlockingEntrySchema: z.ZodObject<{
    kind: z.ZodEnum<{
        unclassified: "unclassified";
        unresolved: "unresolved";
        classification: "classification";
        finding: "finding";
        "stale-reference": "stale-reference";
    }>;
    resourceId: z.ZodNullable<z.ZodString>;
    name: z.ZodNullable<z.ZodString>;
    detail: z.ZodString;
    location: z.ZodNullable<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>>;
    cause: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        TEST_INVENTORY_INCOMPLETE: "TEST_INVENTORY_INCOMPLETE";
        TEST_KIND_UNKNOWN: "TEST_KIND_UNKNOWN";
        TEST_MAPPING_MISSING: "TEST_MAPPING_MISSING";
        TEST_MAPPING_AMBIGUOUS: "TEST_MAPPING_AMBIGUOUS";
        TEST_MAPPING_STALE: "TEST_MAPPING_STALE";
        EVIDENCE_NOT_COLLECTED: "EVIDENCE_NOT_COLLECTED";
        VERIFIER_UNSUPPORTED: "VERIFIER_UNSUPPORTED";
        TEST_NOT_EXECUTED: "TEST_NOT_EXECUTED";
        TEST_FAILED: "TEST_FAILED";
        RUN_INCOMPLETE: "RUN_INCOMPLETE";
        EVIDENCE_STALE: "EVIDENCE_STALE";
        CHANGE_UNMAPPED: "CHANGE_UNMAPPED";
        EVIDENCE_SCOPE_INCOMPLETE: "EVIDENCE_SCOPE_INCOMPLETE";
        ENFORCEMENT_UNTRUSTED: "ENFORCEMENT_UNTRUSTED";
        EVIDENCE_VALUE_MISMATCH: "EVIDENCE_VALUE_MISMATCH";
        SERVER_PROBE_UNAVAILABLE: "SERVER_PROBE_UNAVAILABLE";
        CRUD_COVERAGE_MISSING: "CRUD_COVERAGE_MISSING";
        DIAGNOSTIC_TEST_FAILURE: "DIAGNOSTIC_TEST_FAILURE";
        DIAGNOSTIC_RUN_INCOMPLETE: "DIAGNOSTIC_RUN_INCOMPLETE";
        DIAGNOSTIC_RESULT_STALE: "DIAGNOSTIC_RESULT_STALE";
    }>>>;
    nextAction: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
/** Inferred blocking-entry shape. */
export type BlockingEntry = z.infer<typeof BlockingEntrySchema>;
/**
 * The adopted identity of a classification-blocked resource (two-layer
 * adoption): the ONE canonical string both `gateforge adopt` captures
 * into the receipt's `classificationBlocked` set and the check matches
 * against when waiving — so the two sides can never disagree.
 *
 * - The plane-qualified `resourceId` when the entry carries one (blocks
 *   on otherwise-classified resources, e.g. delete-semantics).
 * - Else the bare resource name under a `name:` namespace — a resource
 *   with NO derivable plane (PLANE_UNRESOLVED) has no plane-qualified id
 *   by definition, and its bare name is the stable, merge-surviving
 *   identity. The `name:` prefix keeps the fallback out of the
 *   plane-qualified id space (`tenant.users` et al.).
 * - Both the `classification` entry (the typed block) AND the
 *   `unclassified` shadow entry (the definitional "no effective
 *   classification" block the policy engine emits for the SAME resource)
 *   map to the same identity: waiving the resource waives its whole
 *   adopted block, or the gate could never return to green.
 *
 * Returns null for entries that are never resource-scoped (document-level
 * classifier blocks — stale targets, invalid signals — and
 * unresolved/finding/stale-reference kinds): those can never be adopted
 * by this layer.
 */
export declare function classificationBlockedIdentity(entry: BlockingEntry): string | null;
/** Assessment of one watched claim against the generated obligations. */
export declare const ClaimAssessmentSchema: z.ZodObject<{
    claim: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        obligationId: z.ZodString;
        testId: z.ZodString;
        testFile: z.ZodOptional<z.ZodString>;
        location: z.ZodOptional<z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    status: z.ZodEnum<{
        invalid: "invalid";
        valid: "valid";
    }>;
    reason: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/** Inferred claim-assessment shape. */
export type ClaimAssessment = z.infer<typeof ClaimAssessmentSchema>;
/** The complete policy-engine result. Deterministic; fully sorted. */
export declare const PolicyEvaluationResultSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    obligations: z.ZodArray<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodString;
        resourceId: z.ZodString;
        contract: z.ZodString;
        policyId: z.ZodString;
        lifecycle: z.ZodObject<{
            create: z.ZodBoolean;
            read: z.ZodBoolean;
            update: z.ZodBoolean;
            delete: z.ZodBoolean;
            deleteSemantics: z.ZodOptional<z.ZodEnum<{
                hard: "hard";
                archive: "archive";
            }>>;
            archiveFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
            updateableFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    blocking: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            unclassified: "unclassified";
            unresolved: "unresolved";
            classification: "classification";
            finding: "finding";
            "stale-reference": "stale-reference";
        }>;
        resourceId: z.ZodNullable<z.ZodString>;
        name: z.ZodNullable<z.ZodString>;
        detail: z.ZodString;
        location: z.ZodNullable<z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>>;
        cause: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            TEST_INVENTORY_INCOMPLETE: "TEST_INVENTORY_INCOMPLETE";
            TEST_KIND_UNKNOWN: "TEST_KIND_UNKNOWN";
            TEST_MAPPING_MISSING: "TEST_MAPPING_MISSING";
            TEST_MAPPING_AMBIGUOUS: "TEST_MAPPING_AMBIGUOUS";
            TEST_MAPPING_STALE: "TEST_MAPPING_STALE";
            EVIDENCE_NOT_COLLECTED: "EVIDENCE_NOT_COLLECTED";
            VERIFIER_UNSUPPORTED: "VERIFIER_UNSUPPORTED";
            TEST_NOT_EXECUTED: "TEST_NOT_EXECUTED";
            TEST_FAILED: "TEST_FAILED";
            RUN_INCOMPLETE: "RUN_INCOMPLETE";
            EVIDENCE_STALE: "EVIDENCE_STALE";
            CHANGE_UNMAPPED: "CHANGE_UNMAPPED";
            EVIDENCE_SCOPE_INCOMPLETE: "EVIDENCE_SCOPE_INCOMPLETE";
            ENFORCEMENT_UNTRUSTED: "ENFORCEMENT_UNTRUSTED";
            EVIDENCE_VALUE_MISMATCH: "EVIDENCE_VALUE_MISMATCH";
            SERVER_PROBE_UNAVAILABLE: "SERVER_PROBE_UNAVAILABLE";
            CRUD_COVERAGE_MISSING: "CRUD_COVERAGE_MISSING";
            DIAGNOSTIC_TEST_FAILURE: "DIAGNOSTIC_TEST_FAILURE";
            DIAGNOSTIC_RUN_INCOMPLETE: "DIAGNOSTIC_RUN_INCOMPLETE";
            DIAGNOSTIC_RESULT_STALE: "DIAGNOSTIC_RESULT_STALE";
        }>>>;
        nextAction: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    claims: z.ZodArray<z.ZodObject<{
        claim: z.ZodObject<{
            schemaVersion: z.ZodLiteral<1>;
            obligationId: z.ZodString;
            testId: z.ZodString;
            testFile: z.ZodOptional<z.ZodString>;
            location: z.ZodOptional<z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                col: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        status: z.ZodEnum<{
            invalid: "invalid";
            valid: "valid";
        }>;
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred policy-evaluation-result shape. */
export type PolicyEvaluationResult = z.infer<typeof PolicyEvaluationResultSchema>;
/**
 * Whether a contract is allowed by a lifecycle. `crud:` and
 * `persistence:` contracts map to their lifecycle flag (`crud:create` ⇔
 * `lifecycle.create === true`, etc. — unknown operations in either
 * namespace are a policy-authoring error); every other contract passes
 * through ungated.
 *
 * Args:
 *   contract: the required contract name, e.g. `crud:update`.
 *   lifecycle: the classification's lifecycle flags.
 *
 * Returns:
 *   boolean: true when an obligation for this contract must be generated.
 * @throws PolicyEvaluationError for `crud:`/`persistence:` contracts
 *   outside the four lifecycle operations.
 */
export declare function lifecycleAllowsContract(contract: ContractName, lifecycle: {
    create: boolean;
    read: boolean;
    update: boolean;
    delete: boolean;
    archiveFields?: Record<string, string | number | boolean>;
}): boolean;
export interface PolicyEvaluationInput {
    /** A graph built by `buildResourceGraph`. */
    graph: ResourceGraph;
    /** The declarative policies document (validated fail-closed). */
    policies: PolicyFile;
    /** Claims to assess against the generated obligations (ADR 0001). */
    claims?: Claim[];
    /**
     * Pre-projected blocking entries from the classifier (plan phase 5),
     * appended verbatim before the deterministic sort.
     */
    extraBlocking?: BlockingEntry[];
}
/**
 * Evaluates the policy document against a built resource graph.
 *
 * Args:
 *   input: graph + policies (+ claims to assess). The policy document
 *     is validated fail-closed; resources are consumed in the graph's
 *     deterministic order.
 *
 * Returns:
 *   PolicyEvaluationResult: obligations, blocking entries, and claim
 *   assessments — all sorted, byte-for-byte deterministic.
 * @throws z.ZodError when the policy document is invalid (config error).
 * @throws PolicyEvaluationError for `crud:` contracts outside the four
 *   lifecycle operations.
 */
export declare function evaluatePolicies(input: PolicyEvaluationInput): PolicyEvaluationResult;
//# sourceMappingURL=evaluate.d.ts.map