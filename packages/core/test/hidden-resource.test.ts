/**
 * Hidden resources (plan 20261028_1945_gf_route_serves_no_table, P1) — RED
 * before P2 by design: `hiddenRules` is not implemented yet, so every case
 * below fails on the missing hidden feature (never on syntax, imports, or
 * type errors).
 *
 * Spec: docs/design/hidden-resources.md. The fixtures reuse the exact API
 * shape of packages/core/test/exposure-coverage.test.ts (classifyResources
 * over ClassifierResourceRef + ClassificationSignal + ClassifierPolicy +
 * ClassifierScanInput) and the endpoint-compiler's real signal shapes
 * (`adapter-binding` linking signal, endpoint-compiler detector identity).
 *
 * Cases (P1 line):
 * (a) hidden rule + one linked endpoint with passing ENDPOINT_BEHAVIOR
 *     proof → no ADAPTER_MISSING, no INCOMPLETE_PROOF_SCOPE, complete.
 * (b) same, behavior proof missing → blocked naming the endpoint.
 * (c) hidden rule, no linked endpoint → HIDDEN_RESOURCE_UNLINKED.
 * (d) hidden rule + positive read exposure → CLASSIFICATION_CONTRADICTION.
 * (e) no hiddenRules (empty list) → parses, byte-identical output.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyResources,
  type ClassificationResult,
  type ClassifierResourceRef,
  type ClassifierScanInput,
  type ClassifyResourcesInput,
} from '../src/classifier/classify.js';
import type { ClassificationSignal, SignalAssertion } from '../src/schemas/classification-signal.js';
import type { ClassifierPolicy } from '../src/schemas/scan-config.js';
import { ClassificationPolicySchema } from '../src/schemas/classification-policy.js';
import { HTTP_ENDPOINT_RESOURCE_KIND } from '../src/graph/schema.js';
import { canonicalJson, type JsonValue } from '../src/canonical-json.js';

const TABLE = 'password_reset_tokens';
const TABLE_SOURCE = 'backend/models/password_reset_token.py';
const TABLE_LOCATION = { file: TABLE_SOURCE, line: 8, col: 7 };
const ENDPOINT = 'http-post-password-reset-requests';
const ROUTE_SOURCE = 'backend/routes/auth_routes.py';
const ROUTE_LOCATION = { file: ROUTE_SOURCE, line: 40, col: 3 };
const SQL_DETECTOR = { id: 'gateforge.pack-sqlalchemy', version: '0.15.1' } as const;
const COMPILER_DETECTOR = { id: 'gateforge.endpoint-compiler', version: '1' } as const;

/**
 * Typed as a plain string on purpose: HIDDEN_RESOURCE_UNLINKED is not in
 * CLASSIFIER_BLOCK_CODES yet (that IS the missing feature), and a direct
 * union comparison would be a type error — these tests must stay green at
 * the type level while red at runtime.
 */
const HIDDEN_RESOURCE_UNLINKED = 'HIDDEN_RESOURCE_UNLINKED';

function tableResource(): ClassifierResourceRef {
  return {
    name: TABLE,
    id: `tenant.${TABLE}`,
    kind: 'sql.table',
    source: TABLE_SOURCE,
    location: TABLE_LOCATION,
    detector: SQL_DETECTOR,
    attributes: { plane: 'tenant' },
  };
}

/**
 * The writing endpoint, shaped like the endpoint compiler's graph record
 * (resourceName/method/canonicalPath/linkedResourceName attributes). The
 * `behaviorProof` stamp is the P2 pipeline's input channel per the design
 * note; `false` models a linked endpoint with no passing behavior proof.
 */
function endpointResource(options?: { behaviorProof?: boolean }): ClassifierResourceRef {
  return {
    name: ENDPOINT,
    id: `tenant.${ENDPOINT}`,
    kind: HTTP_ENDPOINT_RESOURCE_KIND,
    source: ROUTE_SOURCE,
    location: ROUTE_LOCATION,
    detector: COMPILER_DETECTOR,
    attributes: {
      plane: 'tenant',
      resourceName: ENDPOINT,
      method: 'POST',
      canonicalPath: '/api/v1/auth/password-reset-requests',
      linkedResourceName: TABLE,
      ...(options?.behaviorProof ? { behaviorProof: 'passing' } : {}),
    },
  };
}

function signal(
  dimension: ClassificationSignal['dimension'],
  assertion: SignalAssertion,
  target: string,
  detector: { id: string; version: string },
  location: { file: string; line: number; col: number },
): ClassificationSignal {
  return {
    schemaVersion: 1,
    target: { resourceName: target },
    dimension,
    assertion,
    basis: 'code-positive',
    source: detector.id,
    location,
    detector,
  };
}

/**
 * The scan's evidence set: table primary-key identity, the endpoint's own
 * identity, and — when `withLink` is true — the endpoint→table write link
 * exactly as endpoint-compiler.ts:1296 mints it (dimension
 * `adapter-binding`, assertion = the linked table name).
 */
function signalsWithLink(withLink: boolean): ClassificationSignal[] {
  return [
    signal('identity', ['id'], TABLE, SQL_DETECTOR, TABLE_LOCATION),
    signal('identity', ['method', 'path'], ENDPOINT, COMPILER_DETECTOR, ROUTE_LOCATION),
    ...(withLink
      ? [signal('adapter-binding', TABLE, ENDPOINT, COMPILER_DETECTOR, ROUTE_LOCATION)]
      : []),
  ];
}

function basePolicy(): ClassifierPolicy {
  return {
    schemaVersion: 1,
    scanRoots: ['**/*'],
    coverage: [],
    declarations: {},
    volatileFields: [],
    trustedInternalEntryPoints: [],
    internalRules: [],
    // The owner's delete-semantics answer for the table (same shape as
    // exposure-coverage.test.ts), so the delete dimension stays satisfied
    // and the cases isolate the HIDDEN dimension — not delete semantics.
    deleteRules: [
      { match: 'backend/models/**', semantics: 'hard', reason: 'tokens are rebuildable by reissue' },
    ],
  };
}

/**
 * The owner's `hiddenRules:` entry (match + reason, the internalRules
 * shape). Cast, not declared: the policy type does not carry the key
 * until P2 adds it — the cast keeps this file typecheck-green while the
 * behavior is red at runtime.
 */
function hiddenPolicy(match: { resourceName: string }): ClassifierPolicy {
  return {
    ...basePolicy(),
    hiddenRules: [{ match, reason: 'reset tokens must never be shown back to any user' }],
  } as ClassifierPolicy;
}

/** A complete-scan input; scope gates are irrelevant without internal intent. */
function scan(): ClassifierScanInput {
  return {
    requestedPaths: [TABLE_SOURCE, ROUTE_SOURCE],
    eligiblePaths: [TABLE_SOURCE, ROUTE_SOURCE],
    coverage: [
      { detector: SQL_DETECTOR.id, scannedPaths: [TABLE_SOURCE] },
      { detector: COMPILER_DETECTOR.id, scannedPaths: [ROUTE_SOURCE] },
    ],
    configuredDetectors: 2,
    successfulDetectors: 2,
    findings: [],
    unresolved: [],
  };
}

function classifyInput(policy: ClassifierPolicy, signals: ClassificationSignal[]): ClassifyResourcesInput {
  return {
    resources: [tableResource(), endpointResource()],
    signals,
    policy,
    adapters: [],
    scan: scan(),
  };
}

function decisionFor(result: ClassificationResult, name: string) {
  const decision = result.decisions.find((entry) => entry.name === name);
  expect(decision).toBeDefined();
  return decision as NonNullable<typeof decision>;
}

describe('hidden resources (plan 20261028_1945, D)', () => {
  it('(a) hidden rule + one linked endpoint with a passing behavior proof: no ADAPTER_MISSING, no INCOMPLETE_PROOF_SCOPE, resource complete', () => {
    const result = classifyResources(
      classifyInput(hiddenPolicy({ resourceName: TABLE }), signalsWithLink(true)),
    );
    expect(result.invalidSignals).toEqual([]);

    const table = decisionFor(result, TABLE);
    expect(table.classification?.exposure).toBe('hidden');
    expect(table.blocks.some((block) => block.code === 'ADAPTER_MISSING')).toBe(false);
    expect(table.blocks.some((block) => block.code === 'INCOMPLETE_PROOF_SCOPE')).toBe(false);
    expect(table.blocks).toEqual([]);
  });

  it('(b) linked endpoint without a passing behavior proof: blocked, naming the endpoint', () => {
    const result = classifyResources(
      classifyInput(hiddenPolicy({ resourceName: TABLE }), signalsWithLink(true)),
    );

    const table = decisionFor(result, TABLE);
    expect(table.classification?.exposure).toBe('hidden');
    expect(table.blocks.length).toBeGreaterThan(0);
    // The block must name the unproven WRITING endpoint, not just the table.
    const endpointNamed = table.blocks.some((block) => block.detail.includes(ENDPOINT));
    expect(endpointNamed).toBe(true);
    expect(table.blocks.some((block) => block.code === 'ADAPTER_MISSING')).toBe(false);
  });

  it('(c) hidden rule with no linked endpoint: HIDDEN_RESOURCE_UNLINKED', () => {
    const result = classifyResources(
      classifyInput(hiddenPolicy({ resourceName: TABLE }), signalsWithLink(false)),
    );

    const table = decisionFor(result, TABLE);
    const codes = table.blocks.map((block) => String(block.code));
    expect(codes).toContain(HIDDEN_RESOURCE_UNLINKED);
  });

  it('(d) hidden rule + positive read exposure: CLASSIFICATION_CONTRADICTION (never silenced)', () => {
    const signals: ClassificationSignal[] = [
      ...signalsWithLink(true),
      // A route DOES return the rows: positive external exposure of the table.
      signal('exposure', 'frontend-consumed', TABLE, COMPILER_DETECTOR, ROUTE_LOCATION),
    ];
    const result = classifyResources(classifyInput(hiddenPolicy({ resourceName: TABLE }), signals));

    const table = decisionFor(result, TABLE);
    const codes = table.blocks.map((block) => String(block.code));
    expect(codes).toContain('CLASSIFICATION_CONTRADICTION');
  });

  it('(e) no hiddenRules: the empty key parses and the output stays byte-identical', () => {
    // (i) The strict owner-answers schema must accept the key (it rejects
    // every unknown key today — the parse channel does not know it yet).
    const parsed = ClassificationPolicySchema.safeParse({
      schemaVersion: 1,
      trustedInternalEntryPoints: [],
      internalRules: [],
      hiddenRules: [],
    });
    expect(parsed.success).toBe(true);

    // (ii) An EMPTY hiddenRules list classifies byte-identically to a
    // policy without the key: absent = off, byte for byte.
    const without = classifyResources(classifyInput(basePolicy(), signalsWithLink(true)));
    const withEmpty = classifyResources(
      classifyInput({ ...basePolicy(), hiddenRules: [] } as ClassifierPolicy, signalsWithLink(true)),
    );
    expect(canonicalJson(withEmpty as unknown as JsonValue)).toBe(
      canonicalJson(without as unknown as JsonValue),
    );
  });
});
