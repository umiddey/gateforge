/**
 * Owner-declared BUSINESS RULES (plan 2026-10-05 §4 D1/D2) and the test
 * type table that decides what proof each rule's declared test type
 * requires.
 *
 * Two deliberate separations:
 * - A RULE is a DECLARATION, never an obligation. It has no detector
 *   resource, no contract namespace and no verifier; it is graded by a
 *   pure evaluator over the run's SEALED facts (see `policy/business-rules.ts`).
 *   Nothing here mints an obligation id.
 * - The TYPE TABLE is DATA, one row per supported `test:` value. Proof
 *   strength follows the type, and a weaker kind never satisfies a
 *   stronger one. Adding a type later is one row plus its honest proof
 *   level, never a change to the evaluator.
 *
 * The claim id per case is `business-rule:<ruleId>/<caseId>`, which
 * satisfies the existing `<resourceId>:<contract>` shape so the sidecar
 * schema is unchanged — the sidecar stores it under the SAME `claims`
 * list it already uses for obligations.
 *
 * YAML parsing stays in the CLI (the existing core/CLI split); this
 * module speaks validated plain data only.
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';

/** The claim namespace every business-rule case id lives in. */
export const BUSINESS_RULE_NAMESPACE = 'business-rule';

/**
 * The claim id one case is mapped by: `business-rule:<ruleId>/<caseId>`.
 * Deterministic and stable, so a sidecar entry survives a re-order of
 * `cases:` and the evaluator can join bindings to cases by string.
 */
export function businessRuleClaimId(ruleId: string, caseId: string): string {
  return `${BUSINESS_RULE_NAMESPACE}:${ruleId}/${caseId}`;
}

/** Whether one claim id belongs to the business-rule namespace. */
export function isBusinessRuleClaimId(claimId: string): boolean {
  return claimId.startsWith(`${BUSINESS_RULE_NAMESPACE}:`);
}

/**
 * The `<ruleId>/<caseId>` pair a business-rule claim id carries, or null
 * when the id is not a business-rule claim or carries no case part.
 */
export function parseBusinessRuleClaimId(claimId: string): { ruleId: string; caseId: string } | null {
  if (!isBusinessRuleClaimId(claimId)) return null;
  const rest = claimId.slice(`${BUSINESS_RULE_NAMESPACE}:`.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { ruleId: rest.slice(0, slash), caseId: rest.slice(slash + 1) };
}

/** Rule ids are stable, filesystem- and URL-safe slugs. */
const RULE_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** Case ids follow the same rule inside their rule. */
const CASE_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** The test types this release ships. More are one table row each. */
export const BUSINESS_RULE_TEST_TYPES = ['e2e', 'pytest'] as const;

/** Union of the supported rule test types. */
export type BusinessRuleTestType = (typeof BUSINESS_RULE_TEST_TYPES)[number];

/** One declared observable consequence of a rule (typically both sides). */
export const BusinessRuleCaseSchema = z
  .object({
    /** Case id, unique inside its rule; joined as `<ruleId>/<caseId>`. */
    id: z.string().regex(CASE_ID, 'case id must match [a-z0-9][a-z0-9._-]*'),
    /** What the case says must be observed; required (a case with no words cannot be reviewed). */
    describe: z.string().trim().min(1),
  })
  .strict();

/** Inferred business-rule-case shape. */
export type BusinessRuleCase = z.infer<typeof BusinessRuleCaseSchema>;

/**
 * Ranking-only hints for `tests suggest`. They NEVER grade: a hint can
 * promote a candidate, never prove anything, and a rule with no hints
 * behaves exactly like a rule with them.
 */
export const BusinessRuleHintsSchema = z
  .object({
    /** URL path globs the proving test is expected to send. */
    routes: z.array(z.string().min(1)).optional(),
    /** Repo-relative file globs the proving test is expected to live in. */
    globs: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** Inferred business-rule-hints shape. */
export type BusinessRuleHints = z.infer<typeof BusinessRuleHintsSchema>;

/**
 * One owner-declared business rule. Every field is a DECLARATION: it
 * changes the trusted policy digest (the rule lives in the owner-answers
 * document) and therefore can never be self-approved by an agent.
 */
export const BusinessRuleSchema = z
  .object({
    /** Stable rule id; unique in the document. */
    id: z.string().regex(RULE_ID, 'rule id must match [a-z0-9][a-z0-9._-]*'),
    /** The rule in the owner's own words (required: a rule with no title cannot be reviewed). */
    title: z.string().trim().min(1),
    /** Optional longer prose; the title stays the one-line statement. */
    describe: z.string().trim().min(1).optional(),
    /** Optional resource name; validated against the run's inventory (never proof). */
    subject: z.string().trim().min(1).optional(),
    /** Which kind of test must prove it. `e2e` is the default. */
    test: z.enum(BUSINESS_RULE_TEST_TYPES).default('e2e'),
    /** `block` (default) or `advisory`; advisory findings never reach the exit code. */
    enforcement: z.enum(['block', 'advisory']).default('block'),
    /** REQUIRED iff `enforcement: advisory` — an advisory with no reason hides itself. */
    advisoryReason: z.string().trim().min(1).optional(),
    /** Observable cases; absent means the single implicit case `default`. */
    cases: z.array(BusinessRuleCaseSchema).min(1).optional(),
    /** Ranking-only hints for `tests suggest`. */
    hints: BusinessRuleHintsSchema.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.enforcement === 'advisory' && rule.advisoryReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['advisoryReason'],
        message:
          "rule '" + rule.id + "' is advisory but declares no advisoryReason: an advisory rule must say why it does not block",
      });
    }
    if (rule.enforcement === 'block' && rule.advisoryReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['advisoryReason'],
        message:
          "rule '" + rule.id + "' blocks but declares advisoryReason: the reason belongs on an advisory rule only",
      });
    }
    const seen = new Set<string>();
    for (let index = 0; index < (rule.cases ?? []).length; index += 1) {
      const id = rule.cases?.[index]?.id;
      if (id === undefined) continue;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cases', index, 'id'],
          message: `duplicate case id '${id}' in rule '${rule.id}'`,
        });
      }
      seen.add(id);
    }
  });

/** Inferred business-rule shape. */
export type BusinessRule = z.infer<typeof BusinessRuleSchema>;

/**
 * The `rules:` section. Duplicate rule ids are an ambiguity, not a
 * last-one-wins: two rules with one id cannot be graded deterministically.
 */
export const BusinessRulesSchema = z
  .array(BusinessRuleSchema)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < rules.length; index += 1) {
      const id = rules[index]?.id;
      if (id === undefined) continue;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `duplicate business rule id '${id}' — every rule must be separately addressable`,
        });
      }
      seen.add(id);
    }
  });

/** Inferred business-rules section shape. */
export type BusinessRules = z.infer<typeof BusinessRulesSchema>;

/** The case id a rule without `cases:` uses. */
export const IMPLICIT_CASE_ID = 'default';

/**
 * The rule's cases with the implicit `default` case materialized. Pure:
 * a rule that declares cases returns exactly those, in order.
 */
export function casesOf(rule: BusinessRule): BusinessRuleCase[] {
  if (rule.cases !== undefined && rule.cases.length > 0) return [...rule.cases];
  return [{ id: IMPLICIT_CASE_ID, describe: rule.title }];
}

/**
 * The owners-answers document's RULE section: `rules:` is optional and
 * an ABSENT section means the feature is off — byte-identical findings,
 * report and digests to a release without it (plan invariant 1).
 */
export const BusinessRulePolicySchema = z
  .object({
    /** Owner-declared business rules. */
    rules: z.array(BusinessRuleSchema),
  })
  .strict();

/** Inferred business-rule-policy section shape. */
export type BusinessRulePolicy = z.infer<typeof BusinessRulePolicySchema>;

/**
 * One row of the TYPE TABLE (plan D2). `acceptedKinds` is closed-world:
 * a binding of any other kind is `wrong-type`, never quietly accepted,
 * and a no-weaker-kind rule means a row never inherits another row's
 * kinds.
 */
export interface BusinessRuleTypeRow {
  /** The `test:` value this row answers to. */
  readonly id: BusinessRuleTestType;
  /** Human label used in every message and starter test. */
  readonly label: string;
  /** The runner every accepted test must execute under. */
  readonly runner: string;
  /** Test kinds that may satisfy this type (closed-world). */
  readonly acceptedKinds: readonly string[];
  /** Proof channel per accepted kind, named in the report. */
  readonly kindChannels: Readonly<Record<string, string>>;
  /** The channel named when the row's tests all carry the same one. */
  readonly defaultChannel: string;
  /**
   * True when the proof additionally requires the run's WITNESSED suite
   * for the type's runner (`diagnostics.suites[].witnessed`). A pytest
   * rule without one stays `unproven` — no weaker labelled proof.
   */
  readonly requiresWitnessedSuite: boolean;
  /** What `next` prints as the starter test for this type. */
  readonly starter: 'playwright' | 'pytest';
}

/**
 * THE type table: one row per supported `test:` value. Proof strength
 * follows the type, and a weaker kind is never accepted by a stronger
 * row — `e2e` is never satisfied by `api-e2e`, `server-e2e`, `unit`, a
 * mocked spec, or a test that did not run.
 */
export const BUSINESS_RULE_TYPE_TABLE: Readonly<Record<BusinessRuleTestType, BusinessRuleTypeRow>> = Object.freeze({
  e2e: Object.freeze({
    id: 'e2e',
    label: 'e2e',
    runner: 'playwright',
    acceptedKinds: Object.freeze(['browser-e2e', 'observed-e2e']),
    kindChannels: Object.freeze({ 'browser-e2e': 'engine', 'observed-e2e': 'observe' }),
    defaultChannel: 'observe',
    requiresWitnessedSuite: false,
    starter: 'playwright',
  }),
  pytest: Object.freeze({
    id: 'pytest',
    label: 'pytest',
    runner: 'pytest',
    acceptedKinds: Object.freeze(['unit', 'integration', 'server-e2e']),
    kindChannels: Object.freeze({ unit: 'execution', integration: 'execution', 'server-e2e': 'execution' }),
    defaultChannel: 'execution',
    requiresWitnessedSuite: true,
    starter: 'pytest',
  }),
});

/** The type table as a deterministic list (sorted by type id). */
export function businessRuleTypeRows(): BusinessRuleTypeRow[] {
  return [...BUSINESS_RULE_TEST_TYPES].sort().map((id) => BUSINESS_RULE_TYPE_TABLE[id]);
}

/**
 * The per-case status the evaluator reports. `satisfied` carries the
 * proof channel in its label (`satisfied (observe)`), because "satisfied"
 * read as "the rule holds" is exactly the overclaim invariant 6 forbids.
 */
export const BUSINESS_RULE_CASE_STATUSES = ['unmapped', 'wrong-type', 'unproven', 'failing', 'satisfied'] as const;

/** Union of the per-case statuses. */
export type BusinessRuleCaseStatus = (typeof BUSINESS_RULE_CASE_STATUSES)[number];

/**
 * The `rules:` key as it appears in the owner-answers document, named
 * once so the loader, the migrator and the init template cannot drift.
 */
export const BUSINESS_RULES_KEY = 'rules';

/** The `schemaVersion` every engine document carries. */
export const BusinessRuleSchemaVersionField = SchemaVersionField;