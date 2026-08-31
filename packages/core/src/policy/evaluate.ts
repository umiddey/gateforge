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
import { LocationSchema, SchemaVersionField, type ContractName, type Location } from '../schemas/common.js';
import { ObligationSchema, type Obligation } from '../schemas/obligation.js';
import { PolicyFileSchema, type Policy, type PolicyFile } from '../schemas/policy.js';
import { ClaimSchema, type Claim } from '../schemas/claim.js';
import type { GraphResource, ResourceGraph } from '../graph/schema.js';
import { compareStrings } from '../graph/util.js';

/** The CRUD contract namespace gated by lifecycle flags. */
export const CRUD_CONTRACT_PREFIX = 'crud:';

/** The four lifecycle-gated operations, in canonical order. */
const CRUD_OPERATIONS = ['create', 'read', 'update', 'delete'] as const;

/**
 * Fail-closed policy-engine error: thrown for policy documents that
 * are structurally invalid (zod) or use the `crud:` namespace with an
 * unknown operation — a config/usage problem, never a silent skip.
 */
export class PolicyEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyEvaluationError';
  }
}

/** Why a resource currently generates no obligations. */
export const BlockingEntrySchema = z
  .strictObject({
    /** `unclassified` = resolved but lacking business meaning; `unresolved` = identity not statically resolvable. */
    kind: z.enum(['unclassified', 'unresolved']),
    /** Plane-qualified id when one could be derived, else `null`. */
    resourceId: z.string().min(1).nullable(),
    /** Bare resource name when known, else `null`. */
    name: z.string().min(1).nullable(),
    /** Single-cause human explanation (invariant 8: explain every block). */
    detail: z.string().min(1),
    /** Source location when known, else `null`. */
    location: LocationSchema.nullable(),
  });

/** Inferred blocking-entry shape. */
export type BlockingEntry = z.infer<typeof BlockingEntrySchema>;

/** Assessment of one watched claim against the generated obligations. */
export const ClaimAssessmentSchema = z
  .strictObject({
    claim: ClaimSchema,
    status: z.enum(['valid', 'invalid']),
    /** Single-cause reason for `invalid`; `null` when valid. */
    reason: z.string().min(1).nullable(),
  });

/** Inferred claim-assessment shape. */
export type ClaimAssessment = z.infer<typeof ClaimAssessmentSchema>;

/** The complete policy-engine result. Deterministic; fully sorted. */
export const PolicyEvaluationResultSchema = z
  .strictObject({
    schemaVersion: SchemaVersionField,
    /** Generated obligations, sorted by id (unique — first policy wins). */
    obligations: z.array(ObligationSchema),
    /** Unclassified + unresolved entries, sorted deterministically. */
    blocking: z.array(BlockingEntrySchema),
    /** Claim assessments, sorted by obligation id then test id. */
    claims: z.array(ClaimAssessmentSchema),
  });

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
export function lifecycleAllowsContract(
  contract: ContractName,
  lifecycle: { create: boolean; read: boolean; update: boolean; delete: boolean },
): boolean {
  if (!contract.startsWith(CRUD_CONTRACT_PREFIX)) return true;
  const operation = contract.slice(CRUD_CONTRACT_PREFIX.length);
  if (!(CRUD_OPERATIONS as readonly string[]).includes(operation)) {
    throw new PolicyEvaluationError(
      `policy requires '${contract}' but the crud namespace is limited to: ${CRUD_OPERATIONS.map((op) => `crud:${op}`).join(', ')}`,
    );
  }
  return lifecycle[operation as (typeof CRUD_OPERATIONS)[number]] === true;
}

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
export function evaluatePolicies(input: PolicyEvaluationInput): PolicyEvaluationResult {
  const policyFile = PolicyFileSchema.parse(input.policies);
  const obligations: Obligation[] = [];
  const obligationIds = new Set<string>();
  const blocking: BlockingEntry[] = [];

  for (const resource of input.graph.resources) {
    if (resource.classification === null) {
      blocking.push({
        kind: 'unclassified',
        resourceId: resource.id,
        name: resource.name,
        detail: `resource '${resource.id ?? resource.name}' is not classified; add it to the classifications document (exposure, plane, lifecycle)`,
        location: resource.location,
      });
      continue;
    }
    generateObligations(resource, policyFile.policies, obligations, obligationIds);
  }

  for (const entry of input.graph.unresolved) {
    blocking.push({
      kind: 'unresolved',
      resourceId: null,
      name: null,
      detail: `${entry.reason.code}: ${entry.reason.detail}`,
      location: entry.reason.location,
    });
  }

  const claims = assessClaims(input.claims ?? [], obligationIds, input.graph.resources);

  return {
    schemaVersion: 1,
    obligations: sortObligations(obligations),
    blocking: sortBlocking(blocking),
    claims: sortClaims(claims),
  };
}

/**
 * Generates obligations for one classified resource: every matching
 * policy's required contract that the lifecycle allows, deduplicated
 * by obligation id (first matching policy owns the id).
 */
function generateObligations(
  resource: GraphResource,
  policies: Policy[],
  obligations: Obligation[],
  obligationIds: Set<string>,
): void {
  const classification = resource.classification;
  if (classification === null || resource.id === null) return;
  const exposure = classification.exposure;
  for (const policy of policies) {
    if (!policyMatches(policy, resource, exposure)) continue;
    for (const contract of policy.require) {
      if (contract.startsWith(CRUD_CONTRACT_PREFIX)) {
        if (exposure === 'internal') continue; // ADR 0001: internal ⇒ no CRUD obligations
        if (!lifecycleAllowsContract(contract, classification.lifecycle)) continue;
      }
      const id = `${resource.id}:${contract}`;
      if (obligationIds.has(id)) continue;
      obligationIds.add(id);
      obligations.push({
        schemaVersion: 1,
        id,
        resourceId: resource.id,
        contract,
        policyId: policy.id,
        lifecycle: classification.lifecycle,
      });
    }
  }
}

function policyMatches(
  policy: Policy,
  resource: GraphResource,
  exposure: 'user-facing' | 'internal',
): boolean {
  const when = policy.when;
  if (when.kind !== undefined && when.kind !== resource.kind) return false;
  if (when.exposure !== undefined && when.exposure !== exposure) return false;
  if (when.plane !== undefined && when.plane !== resource.plane) return false;
  return true;
}

/**
 * Assesses claims against the generated obligation set. Claims on
 * internal resources are invalid outright (ADR 0001 — internal
 * resources carry no CRUD obligations and never accept claims);
 * claims whose obligation id was not generated are invalid as unknown;
 * the rest are valid linkages (validity ≠ satisfaction — pin #9).
 */
function assessClaims(
  claims: Claim[],
  obligationIds: Set<string>,
  resources: GraphResource[],
): ClaimAssessment[] {
  const internalIds = new Set<string>();
  for (const resource of resources) {
    if (resource.id !== null && resource.classification?.exposure === 'internal') {
      internalIds.add(resource.id);
    }
  }
  return claims.map((claim) => {
    const resourceId = claim.obligationId.slice(0, claim.obligationId.indexOf(':'));
    if (internalIds.has(resourceId)) {
      return {
        claim,
        status: 'invalid' as const,
        reason: `resource '${resourceId}' is internal: internal resources carry no CRUD obligations and their claims are invalid (ADR 0001)`,
      };
    }
    if (!obligationIds.has(claim.obligationId)) {
      return {
        claim,
        status: 'invalid' as const,
        reason: `claim references '${claim.obligationId}' which no policy generates`,
      };
    }
    return { claim, status: 'valid' as const, reason: null };
  });
}

function sortObligations(obligations: Obligation[]): Obligation[] {
  return [...obligations].sort((a, b) => compareStrings(a.id, b.id));
}

function sortBlocking(blocking: BlockingEntry[]): BlockingEntry[] {
  return [...blocking].sort(
    (a, b) =>
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.resourceId ?? '', b.resourceId ?? '') ||
      compareStrings(a.name ?? '', b.name ?? '') ||
      compareStrings(a.detail, b.detail),
  );
}

function sortClaims(claims: ClaimAssessment[]): ClaimAssessment[] {
  return [...claims].sort(
    (a, b) =>
      compareStrings(a.claim.obligationId, b.claim.obligationId) ||
      compareStrings(a.claim.testId, b.claim.testId),
  );
}
