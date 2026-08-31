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
 * - Policies are evaluated in file order; the first policy generating
 *   a given `<resourceId>:<contract>` owns it (obligation ids are
 *   unique identities — pin #1's fingerprint keys on them).
 */
import { z } from 'zod';
import { type ContractName } from '../schemas/common.js';
import { type PolicyFile } from '../schemas/policy.js';
import { type Claim } from '../schemas/claim.js';
import type { ResourceGraph } from '../graph/schema.js';
/** The CRUD contract namespace gated by lifecycle flags. */
export declare const CRUD_CONTRACT_PREFIX = "crud:";
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
    }>;
    resourceId: z.ZodNullable<z.ZodString>;
    name: z.ZodNullable<z.ZodString>;
    detail: z.ZodString;
    location: z.ZodNullable<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred blocking-entry shape. */
export type BlockingEntry = z.infer<typeof BlockingEntrySchema>;
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
        }, z.core.$strict>;
    }, z.core.$strict>>;
    blocking: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            unclassified: "unclassified";
            unresolved: "unresolved";
        }>;
        resourceId: z.ZodNullable<z.ZodString>;
        name: z.ZodNullable<z.ZodString>;
        detail: z.ZodString;
        location: z.ZodNullable<z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>>;
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
 * Whether a contract is allowed by a lifecycle. `crud:` contracts map
 * to their lifecycle flag (`crud:create` ⇔ `lifecycle.create === true`,
 * etc. — unknown `crud:<op>` contracts are a policy-authoring error);
 * every other contract passes through ungated.
 *
 * Args:
 *   contract: the required contract name, e.g. `crud:update`.
 *   lifecycle: the classification's lifecycle flags.
 *
 * Returns:
 *   boolean: true when an obligation for this contract must be generated.
 * @throws PolicyEvaluationError for `crud:` contracts outside the four
 *   lifecycle operations.
 */
export declare function lifecycleAllowsContract(contract: ContractName, lifecycle: {
    create: boolean;
    read: boolean;
    update: boolean;
    delete: boolean;
}): boolean;
export interface PolicyEvaluationInput {
    /** A graph built by `buildResourceGraph`. */
    graph: ResourceGraph;
    /** The declarative policies document (validated fail-closed). */
    policies: PolicyFile;
    /** Claims to assess against the generated obligations (ADR 0001). */
    claims?: Claim[];
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