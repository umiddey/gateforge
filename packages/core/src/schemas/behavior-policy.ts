/**
 * Behavior-policy schemas (plan 2026-09-19 §4.1–4.2, §15): the OWNER
 * document that enumerates every discovered endpoint's required cases.
 * Core accepts already-parsed data; YAML loading stays in the CLI.
 *
 * Absence of the document preserves today's basic table/transport
 * behavior. Presence is complete-behavior: no warnOnly, percentage, or
 * silent fallback. Unknown keys fail closed.
 */
import { z } from 'zod';
import { ContractNameSchema, SchemaVersionField } from './common.js';
import { FingerprintHexSchema } from './baseline.js';

/** Concrete HTTP methods a case may execute. `ANY` is never executable. */
export const BEHAVIOR_HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

/** Inferred executable HTTP method. */
export type BehaviorHttpMethod = (typeof BEHAVIOR_HTTP_METHODS)[number];

/** Case identity domain hashed into the stable case id. */
export const BEHAVIOR_CASE_DOMAIN = 'gateforge.case.v1';

/** Case-id slug: unique within the subject resource. */
export const BehaviorCaseIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "case id must match '[a-z0-9][a-z0-9._-]*'",
  );

/** Strong HTTP contracts introduced by this plan. */
export const HTTP_EFFECT_VERIFIED = 'http:effect-verified';
export const HTTP_READ_RESULT_VERIFIED = 'http:read-result-verified';

/** Existing weaker HTTP contracts retained with their transport meaning. */
export const HTTP_REQUEST_OBSERVED = 'http:request-observed';
export const HTTP_RESPONSE_STATUS_OK = 'http:response-status-ok';

/**
 * Closed contract vocabulary a behavior case may name: the two strong
 * HTTP contracts, the two retained transport contracts (operational-only
 * routes), and every existing domain contract spelling.
 */
export const BEHAVIOR_CONTRACTS = [
  HTTP_EFFECT_VERIFIED,
  HTTP_READ_RESULT_VERIFIED,
  HTTP_REQUEST_OBSERVED,
  HTTP_RESPONSE_STATUS_OK,
  'auth:role-allowed',
  'auth:role-denied',
  'auth:tenant-isolated',
  'auth:denied-no-side-effect',
  'auth:forged-token-rejected',
  'validation:boundary-accepted',
  'validation:boundary-rejected',
  'validation:no-side-effect-on-reject',
  'validation:error-message-explicit',
  'validation:envelope-shape-stable',
  'workflow:transition-allowed',
  'workflow:transition-rejected',
  'workflow:terminal-immutable',
  'workflow:audit-emitted',
  'workflow:persisted-final-state',
  'task:retry-policy-enforced',
  'task:idempotent',
  'task:terminal-handled',
  'task:observability-recorded',
  'task:duplicate-delivery-handled',
  'webhook:signature-accepted',
  'webhook:signature-rejected',
  'webhook:malformed-rejected',
  'webhook:replay-idempotent',
  'webhook:retry-bounded',
] as const;

/** Inferred behavior-contract name. */
export type BehaviorContract = (typeof BEHAVIOR_CONTRACTS)[number];

/** Contracts that require a paired positive-control case. */
export const CONTROL_REQUIRED_CONTRACTS: ReadonlySet<string> = new Set([
  'auth:role-denied',
  'auth:tenant-isolated',
  'auth:denied-no-side-effect',
  'auth:forged-token-rejected',
  'validation:boundary-rejected',
  'validation:no-side-effect-on-reject',
  'workflow:transition-rejected',
  'webhook:signature-rejected',
  'webhook:malformed-rejected',
]);

/** Contracts that may omit state rules (transport-only operational). */
export const TRANSPORT_ONLY_CONTRACTS: ReadonlySet<string> = new Set([
  HTTP_REQUEST_OBSERVED,
  HTTP_RESPONSE_STATUS_OK,
]);

/** Contracts whose proof is a mutation, rejection, or duplicate-delivery. */
export const MUTATION_PROOF_CONTRACTS: ReadonlySet<string> = new Set([
  HTTP_EFFECT_VERIFIED,
  HTTP_READ_RESULT_VERIFIED,
  'auth:role-allowed',
  'auth:role-denied',
  'auth:tenant-isolated',
  'auth:denied-no-side-effect',
  'auth:forged-token-rejected',
  'validation:boundary-accepted',
  'validation:boundary-rejected',
  'validation:no-side-effect-on-reject',
  'validation:error-message-explicit',
  'validation:envelope-shape-stable',
  'workflow:transition-allowed',
  'workflow:transition-rejected',
  'workflow:terminal-immutable',
  'workflow:audit-emitted',
  'workflow:persisted-final-state',
  'task:retry-policy-enforced',
  'task:idempotent',
  'task:terminal-handled',
  'task:observability-recorded',
  'task:duplicate-delivery-handled',
  'webhook:signature-accepted',
  'webhook:signature-rejected',
  'webhook:malformed-rejected',
  'webhook:replay-idempotent',
  'webhook:retry-bounded',
]);

/** Field names that must never carry YAML secret literals. */
const SECRET_FIELD_PATTERN =
  /^(authorization|cookie|set-cookie|token|password|secret|api[-_]?key|credential)$/i;

/** Lookup segments forbidden in fixture/request pointers. */
const FORBIDDEN_LOOKUP_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Finite JSON values (no NaN/Infinity, no class instances). */
export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);

/** JSON-representable value used in case literals. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Rejects lookup segments that would punch through the prototype chain.
 *
 * Args:
 *   key (string): dotted fixture key or JSON Pointer path.
 *   path (PropertyKey[]): zod issue path.
 *   ctx (z.RefinementCtx): schema context.
 */
function rejectUnsafeLookup(key: string, path: PropertyKey[], ctx: z.RefinementCtx): void {
  const segments = key.includes('/')
    ? key.split('/').filter((segment) => segment.length > 0)
    : key.split('.');
  for (const segment of segments) {
    if (FORBIDDEN_LOOKUP_SEGMENTS.has(segment)) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `lookup segment '${segment}' is forbidden (no prototype-chain traversal)`,
      });
    }
  }
}

/** Approved input: a case literal or a fixture-subject key. */
export const InputValueSchema = z.discriminatedUnion('from', [
  z
    .object({
      from: z.literal('literal'),
      value: JsonSchema,
    })
    .strict(),
  z
    .object({
      from: z.literal('fixture'),
      key: z.string().min(1),
    })
    .strict()
    .superRefine((value, ctx) => {
      rejectUnsafeLookup(value.key, ['key'], ctx);
    }),
]);

/** Inferred input-value shape. */
export type InputValue = z.infer<typeof InputValueSchema>;

/** Comparison transforms; exact identity is default. */
export const ValueTransformSchema = z.enum(['identity', 'trim', 'lowercase']);

/** Inferred transform name. */
export type ValueTransform = z.infer<typeof ValueTransformSchema>;

/** Expected values: literals, fixture keys, observed request, or before-state. */
export const ExpectedValueSchema = z.discriminatedUnion('from', [
  z
    .object({
      from: z.literal('literal'),
      value: JsonSchema,
    })
    .strict(),
  z
    .object({
      from: z.literal('fixture'),
      key: z.string().min(1),
    })
    .strict()
    .superRefine((value, ctx) => {
      rejectUnsafeLookup(value.key, ['key'], ctx);
    }),
  z
    .object({
      from: z.literal('request'),
      attempt: z.number().int().min(0),
      pointer: z.string().min(1),
      transform: ValueTransformSchema,
    })
    .strict()
    .superRefine((value, ctx) => {
      rejectUnsafeLookup(value.pointer, ['pointer'], ctx);
    }),
  z
    .object({
      from: z.literal('before'),
      scope: z.string().min(1),
      subject: InputValueSchema,
      field: z.string().min(1),
    })
    .strict(),
]);

/** Inferred expected-value shape. */
export type ExpectedValue = z.infer<typeof ExpectedValueSchema>;

/**
 * Bounded envelope-shape vocabulary (NOT JSON Schema). Recursive strict
 * union: object/array/string/number/integer/boolean/null. No remote
 * refs, callbacks, or coercion.
 */
export const EnvelopeShapeSchema: z.ZodType<EnvelopeShape> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('object'),
        properties: z.record(z.string(), EnvelopeShapeSchema),
        required: z.array(z.string().min(1)),
        additionalProperties: z.literal(false),
      })
      .strict()
      .superRefine((shape, ctx) => {
        for (const name of shape.required) {
          if (!(name in shape.properties)) {
            ctx.addIssue({
              code: 'custom',
              path: ['required'],
              message: `required field '${name}' is not a declared property`,
            });
          }
        }
      }),
    z
      .object({
        type: z.literal('array'),
        items: EnvelopeShapeSchema,
        minItems: z.number().int().min(0),
        maxItems: z.number().int().min(0),
      })
      .strict()
      .superRefine((shape, ctx) => {
        if (shape.maxItems < shape.minItems) {
          ctx.addIssue({
            code: 'custom',
            path: ['maxItems'],
            message: 'maxItems must be >= minItems',
          });
        }
      }),
    z
      .object({
        type: z.literal('string'),
        minLength: z.number().int().min(0),
        maxLength: z.number().int().min(0),
        enum: z.array(z.string()).min(1).optional(),
      })
      .strict()
      .superRefine((shape, ctx) => {
        if (shape.maxLength < shape.minLength) {
          ctx.addIssue({
            code: 'custom',
            path: ['maxLength'],
            message: 'maxLength must be >= minLength',
          });
        }
      }),
    z
      .object({
        type: z.literal('number'),
        minimum: z.number().finite(),
        maximum: z.number().finite(),
      })
      .strict(),
    z
      .object({
        type: z.literal('integer'),
        minimum: z.number().int(),
        maximum: z.number().int(),
      })
      .strict(),
    z.object({ type: z.literal('boolean') }).strict(),
    z.object({ type: z.literal('null') }).strict(),
  ]),
);

/** Inferred envelope-shape tree. */
export type EnvelopeShape =
  | {
      type: 'object';
      properties: Record<string, EnvelopeShape>;
      required: string[];
      additionalProperties: false;
    }
  | {
      type: 'array';
      items: EnvelopeShape;
      minItems: number;
      maxItems: number;
    }
  | {
      type: 'string';
      minLength: number;
      maxLength: number;
      enum?: string[];
    }
  | { type: 'number'; minimum: number; maximum: number }
  | { type: 'integer'; minimum: number; maximum: number }
  | { type: 'boolean' }
  | { type: 'null' };

/** Response observation rule. */
export const ResponseRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('equals'),
      pointer: z.string().min(1),
      value: ExpectedValueSchema,
    })
    .strict()
    .superRefine((rule, ctx) => {
      rejectUnsafeLookup(rule.pointer, ['pointer'], ctx);
    }),
  z
    .object({
      kind: z.literal('field-error'),
      field: z.string().min(1),
      fieldPointer: z.string().min(1),
      codePointer: z.string().min(1),
      allowedCodes: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('absent'),
      pointer: z.string().min(1),
    })
    .strict()
    .superRefine((rule, ctx) => {
      rejectUnsafeLookup(rule.pointer, ['pointer'], ctx);
    }),
  z
    .object({
      kind: z.literal('entity-set'),
      pointer: z.string().min(1),
      identityFields: z.array(z.string().min(1)).min(1),
      expected: z.array(InputValueSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('envelope'),
      schema: EnvelopeShapeSchema,
    })
    .strict(),
]);

/** Inferred response-rule shape. */
export type ResponseRule = z.infer<typeof ResponseRuleSchema>;

/** State observation rule over one declared effect scope. */
export const StateRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unchanged'), scope: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('updated'),
      scope: z.string().min(1),
      subject: InputValueSchema,
      fields: z.record(z.string(), ExpectedValueSchema),
    })
    .strict()
    .superRefine((rule, ctx) => {
      if (Object.keys(rule.fields).length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields'],
          message: 'updated fields must be nonempty',
        });
      }
    }),
  z
    .object({
      kind: z.literal('created'),
      scope: z.string().min(1),
      rows: z.array(z.object({ fields: z.record(z.string(), ExpectedValueSchema) }).strict()).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('absent'),
      scope: z.string().min(1),
      subjects: z.array(InputValueSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('archived'),
      scope: z.string().min(1),
      subject: InputValueSchema,
      fields: z.record(z.string(), ExpectedValueSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('exact-set'),
      scope: z.string().min(1),
      rows: z
        .array(
          z
            .object({
              subject: InputValueSchema,
              fields: z.record(z.string(), ExpectedValueSchema),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('append-only'),
      scope: z.string().min(1),
      rows: z.array(z.object({ fields: z.record(z.string(), ExpectedValueSchema) }).strict()).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('count-delta'),
      scope: z.string().min(1),
      delta: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('transition'),
      scope: z.string().min(1),
      subject: InputValueSchema,
      field: z.string().min(1),
      from: ExpectedValueSchema,
      to: ExpectedValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('attempts'),
      resourceId: z.string().min(1),
      count: z.number().int().min(0),
      terminal: z.enum(['succeeded', 'failed', 'rejected']),
    })
    .strict(),
]);

/** Inferred state-rule shape. */
export type StateRule = z.infer<typeof StateRuleSchema>;

/**
 * One independently observed effect of a subject. Identity fields are
 * the ordered real primary key (tenant included where needed) and cannot
 * drop columns the classification already declared.
 */
export const EffectScopeSchema = z
  .object({
    id: z.string().min(1),
    resourceId: z
      .string()
      .min(1)
      .regex(/^[^:]+$/, "resourceId must not contain ':' (normalized graph id)"),
    adapter: z.string().min(1),
    scope: z.string().min(1),
    identityFields: z.array(z.string().min(1)).min(1),
    fields: z.array(z.string().min(1)).min(1),
    completion: z.enum(['immediate', 'barrier']),
  })
  .strict();

/** Inferred effect-scope shape. */
export type EffectScope = z.infer<typeof EffectScopeSchema>;

const FieldMapSchema = z
  .record(z.string(), InputValueSchema)
  .superRefine((fields, ctx) => {
    for (const name of Object.keys(fields)) {
      if (SECRET_FIELD_PATTERN.test(name) && fields[name]?.from === 'literal') {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `secret field '${name}' must be an actor/signature reference, never a YAML literal`,
        });
      }
    }
  });

const RequestBodySchema = z.discriminatedUnion('encoding', [
  z
    .object({
      encoding: z.literal('json'),
      fields: FieldMapSchema,
    })
    .strict(),
  z
    .object({
      encoding: z.literal('form'),
      fields: FieldMapSchema,
    })
    .strict(),
  z
    .object({
      encoding: z.literal('multipart'),
      fields: FieldMapSchema,
      files: z.record(z.string(), z.string().min(1)),
    })
    .strict(),
  z
    .object({
      encoding: z.literal('raw'),
      fixture: z.string().min(1),
    })
    .strict(),
]);

/**
 * Origin-relative path template: no scheme, userinfo, traversal, or
 * encoded-separator ambiguity.
 *
 * Args:
 *   pathTemplate (string): candidate template.
 *
 * Returns:
 *   string | null: error message, or null when legal.
 */
export function pathTemplateError(pathTemplate: string): string | null {
  if (!pathTemplate.startsWith('/') || pathTemplate.startsWith('//')) {
    return 'pathTemplate must be origin-relative and start with a single /';
  }
  if (/^[a-zA-Z][a-zA-Z+.-]*:/.test(pathTemplate) || pathTemplate.includes('://')) {
    return 'pathTemplate must not be an absolute URL';
  }
  if (pathTemplate.includes('@')) {
    return 'pathTemplate must not contain userinfo';
  }
  if (pathTemplate.split('/').some((segment) => segment === '..' || segment === '.')) {
    return 'pathTemplate must not contain path traversal';
  }
  if (/%2f|%2e|%5c/i.test(pathTemplate)) {
    return 'pathTemplate must not contain encoded separators';
  }
  return null;
}

/** Surface / HTTP / delivery action (no nested sequences). */
export const PrimitiveActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('surface'),
      surface: z.string().min(1),
      operation: z.enum(['create', 'read', 'update', 'delete']),
      subject: InputValueSchema.optional(),
      fields: FieldMapSchema,
      files: z.record(z.string(), z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('request'),
      method: z.enum(BEHAVIOR_HTTP_METHODS),
      pathTemplate: z.string().min(1),
      path: z.record(z.string(), InputValueSchema),
      query: z.record(z.string(), InputValueSchema),
      body: RequestBodySchema,
      credentialVariant: z.enum(['valid', 'missing', 'corrupted']),
      signatureProfile: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((action, ctx) => {
      const error = pathTemplateError(action.pathTemplate);
      if (error !== null) {
        ctx.addIssue({ code: 'custom', path: ['pathTemplate'], message: error });
      }
    }),
  z
    .object({
      kind: z.literal('deliver'),
      resourceId: z
        .string()
        .min(1)
        .regex(/^[^:]+$/, "resourceId must not contain ':'"),
      payload: InputValueSchema,
      idempotencyKey: InputValueSchema,
      deliveryId: InputValueSchema,
      count: z.number().int().min(1),
      schedule: z.enum(['serial', 'concurrent']),
    })
    .strict(),
]);

/** Inferred primitive action. */
export type PrimitiveAction = z.infer<typeof PrimitiveActionSchema>;

const StatusListSchema = z
  .array(z.number().int().min(100).max(599))
  .superRefine((statuses, ctx) => {
    const sorted = [...statuses].sort((a, b) => a - b);
    for (let index = 0; index < statuses.length; index += 1) {
      if (statuses[index] !== sorted[index]) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'statuses must be sorted ascending and duplicate-free',
        });
        return;
      }
      if (index > 0 && statuses[index] === statuses[index - 1]) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `duplicate status ${String(statuses[index])}`,
        });
        return;
      }
    }
  });

const StepExpectSchema = z
  .object({
    statuses: StatusListSchema,
    state: z.array(StateRuleSchema),
  })
  .strict();

/** Finite nonempty sequence of primitive actions. */
export const SequenceActionSchema = z
  .object({
    kind: z.literal('sequence'),
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1),
            action: PrimitiveActionSchema,
            expect: StepExpectSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((sequence, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < sequence.steps.length; index += 1) {
      const stepId = sequence.steps[index]?.id;
      if (stepId === undefined) continue;
      if (seen.has(stepId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `duplicate sequence step id '${stepId}'`,
        });
      }
      seen.add(stepId);
    }
  });

/** Case action: one primitive or one finite sequence. */
export const BehaviorActionSchema = z.union([PrimitiveActionSchema, SequenceActionSchema]);

/** Inferred behavior action. */
export type BehaviorAction = z.infer<typeof BehaviorActionSchema>;

const VisibleExpectSchema = z
  .object({
    surface: z.string().min(1),
    subject: InputValueSchema,
    fields: z.record(z.string(), ExpectedValueSchema),
  })
  .strict();

const CaseExpectSchema = z
  .object({
    statuses: StatusListSchema,
    response: z.array(ResponseRuleSchema),
    state: z.array(StateRuleSchema),
    visible: VisibleExpectSchema.optional(),
  })
  .strict();

/**
 * Whether an action produces an HTTP/surface response that needs statuses.
 *
 * Args:
 *   action (BehaviorAction): the case action.
 *
 * Returns:
 *   boolean: true when statuses must be nonempty.
 */
function actionNeedsStatuses(action: BehaviorAction): boolean {
  if (action.kind === 'deliver') return false;
  if (action.kind === 'sequence') {
    return action.steps.some((step) => step.action.kind !== 'deliver');
  }
  return true;
}

/** One finite, deterministic behavior case. */
export const BehaviorCaseSchema = z
  .object({
    id: BehaviorCaseIdSchema,
    contract: z.enum(BEHAVIOR_CONTRACTS),
    channel: z.enum(['engine-browser', 'engine-http', 'engine-task']),
    fixture: z.string().min(1),
    actor: z.string().min(1),
    action: BehaviorActionSchema,
    expect: CaseExpectSchema,
    controlCase: BehaviorCaseIdSchema.optional(),
  })
  .strict()
  .superRefine((behaviorCase, ctx) => {
    if (CONTROL_REQUIRED_CONTRACTS.has(behaviorCase.contract) && behaviorCase.controlCase === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['controlCase'],
        message: `contract '${behaviorCase.contract}' requires controlCase (a passing authorized counterpart)`,
      });
    }
    if (actionNeedsStatuses(behaviorCase.action) && behaviorCase.expect.statuses.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['expect', 'statuses'],
        message: 'statuses is nonempty for every HTTP/surface step',
      });
    }
    if (
      behaviorCase.action.kind === 'deliver' &&
      behaviorCase.expect.statuses.length > 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['expect', 'statuses'],
        message: 'statuses is empty only for a purely queue-driven case',
      });
    }
    if (
      MUTATION_PROOF_CONTRACTS.has(behaviorCase.contract) &&
      behaviorCase.expect.state.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['expect', 'state'],
        message:
          'empty state rules cannot satisfy a mutation, no-side-effect or idempotency contract',
      });
    }
    if (
      behaviorCase.expect.state.length === 1 &&
      behaviorCase.expect.state[0]?.kind === 'count-delta' &&
      MUTATION_PROOF_CONTRACTS.has(behaviorCase.contract)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['expect', 'state', 0, 'kind'],
        message:
          'count-delta cannot be the sole state rule for mutation, rejection, idempotency or duplicate-delivery proof',
      });
    }
    if (
      behaviorCase.expect.visible !== undefined &&
      behaviorCase.channel === 'engine-http' &&
      behaviorCase.action.kind !== 'sequence'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['expect', 'visible'],
        message:
          'an engine-http case cannot assert browser visibility without a separately declared engine-browser step',
      });
    }
    if (behaviorCase.channel === 'engine-task' && behaviorCase.action.kind === 'surface') {
      ctx.addIssue({
        code: 'custom',
        path: ['action', 'kind'],
        message: "channel 'engine-task' cannot drive a surface action",
      });
    }
    if (behaviorCase.channel === 'engine-browser' && behaviorCase.action.kind === 'deliver') {
      ctx.addIssue({
        code: 'custom',
        path: ['action', 'kind'],
        message: "channel 'engine-browser' cannot drive a deliver action",
      });
    }
  });

/** Inferred behavior-case shape. */
export type BehaviorCase = z.infer<typeof BehaviorCaseSchema>;

/** Owner disposition for an endpoint that is not strongly tested. */
export const BehaviorDispositionSchema = z
  .object({
    kind: z.enum(['operational-only', 'out-of-scope']),
    reason: z.string().min(1),
  })
  .strict();

/** Inferred disposition. */
export type BehaviorDisposition = z.infer<typeof BehaviorDispositionSchema>;

/**
 * Validates unique case ids and that controlCase names a sibling case.
 *
 * Args:
 *   cases (BehaviorCase[]): cases of one subject.
 *   ctx (z.RefinementCtx): schema context.
 *   pathPrefix (PropertyKey[]): path to the cases array.
 */
function refineCases(
  cases: BehaviorCase[],
  ctx: z.RefinementCtx,
  pathPrefix: PropertyKey[],
): void {
  const seen = new Set<string>();
  for (let index = 0; index < cases.length; index += 1) {
    const id = cases[index]?.id;
    if (id === undefined) continue;
    if (seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: [...pathPrefix, index, 'id'],
        message: `duplicate case id '${id}' within the subject resource`,
      });
    }
    seen.add(id);
  }
  for (let index = 0; index < cases.length; index += 1) {
    const control = cases[index]?.controlCase;
    if (control === undefined) continue;
    if (!seen.has(control)) {
      ctx.addIssue({
        code: 'custom',
        path: [...pathPrefix, index, 'controlCase'],
        message: `controlCase '${control}' does not name a case on this subject`,
      });
    }
    if (control === cases[index]?.id) {
      ctx.addIssue({
        code: 'custom',
        path: [...pathPrefix, index, 'controlCase'],
        message: 'controlCase cannot name the same case',
      });
    }
  }
}

/**
 * Validates unique effect ids within a subject.
 *
 * Args:
 *   effects (EffectScope[]): declared effects.
 *   ctx (z.RefinementCtx): schema context.
 *   pathPrefix (PropertyKey[]): path to the effects array.
 */
function refineEffects(
  effects: EffectScope[],
  ctx: z.RefinementCtx,
  pathPrefix: PropertyKey[],
): void {
  const seen = new Set<string>();
  for (let index = 0; index < effects.length; index += 1) {
    const id = effects[index]?.id;
    if (id === undefined) continue;
    if (seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: [...pathPrefix, index, 'id'],
        message: `duplicate effect id '${id}' within the subject`,
      });
    }
    seen.add(id);
  }
}

/** One discovered HTTP endpoint's approved behavior. */
export const EndpointBehaviorSchema = z
  .object({
    resourceId: z
      .string()
      .min(1)
      .regex(/^[^:]+$/, "resourceId must not contain ':' (normalized http.endpoint graph id)"),
    effects: z.array(EffectScopeSchema),
    cases: z.array(BehaviorCaseSchema),
    disposition: BehaviorDispositionSchema.optional(),
  })
  .strict()
  .superRefine((endpoint, ctx) => {
    refineEffects(endpoint.effects, ctx, ['effects']);
    refineCases(endpoint.cases, ctx, ['cases']);
    if (endpoint.disposition === undefined && endpoint.cases.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'in-scope endpoints require at least one case or an owner disposition',
      });
    }
    if (endpoint.disposition?.kind === 'operational-only' && endpoint.cases.length === 0) {
      // Transport check is compiled even without owner cases.
      return;
    }
    for (let index = 0; index < endpoint.cases.length; index += 1) {
      const behaviorCase = endpoint.cases[index];
      if (behaviorCase === undefined) continue;
      for (let ruleIndex = 0; ruleIndex < behaviorCase.expect.state.length; ruleIndex += 1) {
        const rule = behaviorCase.expect.state[ruleIndex];
        if (rule === undefined || rule.kind === 'attempts') continue;
        if (!endpoint.effects.some((effect) => effect.id === rule.scope)) {
          ctx.addIssue({
            code: 'custom',
            path: ['cases', index, 'expect', 'state', ruleIndex, 'scope'],
            message: `state rule scope '${rule.scope}' is not a declared effect id`,
          });
        }
      }
    }
  });

/** Inferred endpoint-behavior shape. */
export type EndpointBehavior = z.infer<typeof EndpointBehaviorSchema>;

/** One domain/task/workflow resource's approved behavior. */
export const ResourceBehaviorSchema = z
  .object({
    resourceId: z
      .string()
      .min(1)
      .regex(/^[^:]+$/, "resourceId must not contain ':'"),
    effects: z.array(EffectScopeSchema),
    cases: z.array(BehaviorCaseSchema).min(1),
  })
  .strict()
  .superRefine((resource, ctx) => {
    refineEffects(resource.effects, ctx, ['effects']);
    refineCases(resource.cases, ctx, ['cases']);
  });

/** Inferred resource-behavior shape. */
export type ResourceBehavior = z.infer<typeof ResourceBehaviorSchema>;

/** The `.gateforge/behavior.yml` document. */
export const BehaviorPolicySchema = z
  .object({
    schemaVersion: SchemaVersionField,
    endpoints: z.array(EndpointBehaviorSchema),
    resources: z.array(ResourceBehaviorSchema),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seenEndpoints = new Set<string>();
    for (let index = 0; index < policy.endpoints.length; index += 1) {
      const id = policy.endpoints[index]?.resourceId;
      if (id === undefined) continue;
      if (seenEndpoints.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['endpoints', index, 'resourceId'],
          message: `duplicate endpoint '${id}': contradictory bindings are invalid configuration`,
        });
      }
      seenEndpoints.add(id);
    }
    const seenResources = new Set<string>();
    for (let index = 0; index < policy.resources.length; index += 1) {
      const id = policy.resources[index]?.resourceId;
      if (id === undefined) continue;
      if (seenResources.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources', index, 'resourceId'],
          message: `duplicate resource '${id}': contradictory bindings are invalid configuration`,
        });
      }
      seenResources.add(id);
    }
  });

/** Inferred behavior-policy document. */
export type BehaviorPolicy = z.infer<typeof BehaviorPolicySchema>;

/** Re-export for callers that hash case identities. */
export { FingerprintHexSchema, ContractNameSchema };
