/**
 * Classifier-engine tests (ADR 0003, plan improvement Phase 1): the
 * deterministic conservative lattice — no signals ⇒ user-facing (never
 * internal), unknown lifecycle ⇒ enabled (never silently dropped),
 * positive signals beat internal intent and block the contradiction,
 * parse findings invalidate closed-world certificates, byte-identical
 * decisions under input permutation, and monotone obligation surface
 * under added positive signals. Plus hostile-input handling: stale
 * targets, malformed assertions, no-confidence-score authority.
 */
import { describe, expect, it } from 'vitest';
import {
  ClassificationSignalSchema,
  canonicalJson,
  classifierBlocking,
  classifyResources,
  RULES,
  signalId,
  type ClassificationPolicy,
  type ClassificationSignal,
  type ClassificationResult,
  type ClassifierResourceRef,
  type JsonValue,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOC = { file: 'backend/models/account.py', line: 14, col: 0 };
const ROUTE_LOC = { file: 'backend/api/accounts.py', line: 61, col: 0 };

/** The default policy every test starts from (complete-scan roots set).
 * Coverage rules (red-team round 3): a scan is only provably complete
 * against DECLARED per-detector coverage — the fixture declares the
 * sqlalchemy detector for the whole backend tree. */
function policy(overrides: Partial<ClassificationPolicy> = {}): ClassificationPolicy {
  return {
    schemaVersion: 1,
    scanRoots: ['backend/**'],
    trustedInternalEntryPoints: [
      // Reachability for the worker category is bound to ONE trusted
      // detector (red-team round 5): signals from anything else are
      // rejected as suppressive-in-effect.
      { category: 'worker', patterns: ['backend/workers/**'], detector: 'test.worker-detector' },
      { category: 'migration', patterns: [] },
    ],
    internalRules: [],
    coverage: [
      // The org DECLARES this detector an exhaustive exposure parser for
      // the backend tree (round 6): only such a declared rule can serve
      // the exposure negative proof the certificate needs.
      { capability: 'exposure.http', exhaustive: true, detector: 'test.exposure-detector', appliesTo: ['backend/**'] },
      { capability: 'models.sqlalchemy', detector: 'gateforge.pack-sqlalchemy', appliesTo: ['backend/**'] },
    ],
    declarations: { internality: 'gateforge:internal', archiveState: 'gateforge:archive-state' },
    volatileFields: ['updated_at'],
    ...overrides,
  };
}

/** One table resource with plane + identity attributes. */
function resource(overrides: Partial<ClassifierResourceRef> = {}): ClassifierResourceRef {
  return {
    name: 'accounts',
    id: 'tenant.accounts',
    kind: 'sqlalchemy.table',
    source: 'backend/models/account.py',
    location: LOC,
    detector: { id: 'gateforge.pack-sqlalchemy', version: '0.1.0' },
    attributes: {},
    ...overrides,
  };
}

/** The identity + plane every clean fixture decision needs. */
function structuralSignals(overrides: Partial<ClassificationSignal> = {}): ClassificationSignal[] {
  return [
    signal({
      dimension: 'identity',
      assertion: ['id'],
      location: LOC,
      ...overrides,
    }),
    signal({
      dimension: 'plane',
      assertion: 'tenant',
      location: LOC,
      detector: { id: 'gateforge.pack-sqlalchemy', version: '0.1.0' },
      ...overrides,
    }),
  ];
}

/** Builds a signal with sensible defaults. */
function signal(overrides: Partial<ClassificationSignal> & { dimension: ClassificationSignal['dimension']; assertion: ClassificationSignal['assertion'] }): ClassificationSignal {
  return ClassificationSignalSchema.parse({
    schemaVersion: 1,
    target: { resourceName: 'accounts' },
    basis: 'code-positive',
    source: 'gateforge:internal',
    location: { file: 'backend/models/account.py', line: 20, col: 0 },
    detector: { id: 'gateforge.core', version: '1' },
    ...overrides,
  });
}

/** The complete-scan fixture: an explicit request scope whose every file
 * is covered by the policy rule's reported coverage. */
const EMPTY_SCAN = {
  requestedPaths: [
    'backend/models/account.py',
    'backend/api/accounts.py',
    'backend/workers/sync.py',
  ],
  scannedPaths: [
    'backend/models/account.py',
    'backend/api/accounts.py',
    'backend/workers/sync.py',
  ],
  findings: [] as Array<{ code: string; locations: Array<{ file: string; line: number; col: number }> }>,
  unresolved: [] as Array<{ location: { file: string; line: number; col: number } }>,
  coverage: [
    {
      detector: 'gateforge.pack-sqlalchemy',
      scannedPaths: [
        'backend/models/account.py',
        'backend/api/accounts.py',
        'backend/workers/sync.py',
      ],
    },
    {
      detector: 'test.worker-detector',
      scannedPaths: ['backend/workers/sync.py'],
    },
    {
      detector: 'test.exposure-detector',
      scannedPaths: [
        'backend/models/account.py',
        'backend/api/accounts.py',
        'backend/workers/sync.py',
      ],
    },
  ],
};

/**
 * Test wrapper with automatic channel routing (ADR 0003 D2): suppressive
 * shapes are routed to the host-issued authority channel — these tests'
 * intent is always that hand-authored suppressive signals are engine-
 * issued. Detector-channel rejection is covered by the dedicated
 * red-team tests at the bottom, which call `classifyResources` directly.
 */
function classify(
  input: Omit<import('../src/index.js').ClassifyResourcesInput, 'authority'> & {
    authority?: ClassificationSignal[];
  },
): ClassificationResult {
  const suppressive = (signal: ClassificationSignal): boolean =>
    (signal.dimension === 'internality' &&
      (signal.basis === 'declaration' || signal.basis === 'organization-policy')) ||
    (signal.dimension.startsWith('lifecycle.') && signal.basis === 'code-negative-closed-world');
  return classifyResources({
    ...input,
    signals: input.signals.filter((signal) => !suppressive(signal)),
    authority: [...(input.authority ?? []), ...input.signals.filter(suppressive)],
  });
}

/** The baseline full-signal set: structural + hard delete + adapter. */
function cleanInput(
  extraSignals: ClassificationSignal[] = [],
  overrides: {
    resources?: ClassifierResourceRef[];
    adapters?: string[];
    policy?: ClassificationPolicy;
    scan?: { findings: Array<{ code: string; locations: Array<{ file: string; line: number; col: number }> }>; unresolved: Array<{ location: { file: string; line: number; col: number } }> };
  } = {},
) {
  return {
    resources: overrides.resources ?? [resource()],
    signals: [...structuralSignals(), signal({ dimension: 'delete-semantics', assertion: 'hard' }), ...extraSignals],
    policy: overrides.policy ?? policy(),
    adapters: overrides.adapters ?? ['accounts'],
    scan: overrides.scan ?? EMPTY_SCAN,
  };
}

function decision(result: ClassificationResult, name = 'accounts') {
  const found = result.decisions.find((entry) => entry.name === name);
  expect(found, `decision for ${name}`).toBeDefined();
  return found as NonNullable<ClassificationResult['decisions'][number]>;
}

// ---------------------------------------------------------------------------
// Checklist: conservative defaults
// ---------------------------------------------------------------------------

describe('conservative defaults', () => {
  it('no signals: every dimension blocks — nothing is silently decided or dropped', () => {
    const result = classify({
      resources: [resource()],
      signals: [],
      policy: policy(),
      adapters: [],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result);
    expect(entry.classification).toBeNull();
    // Definitional failures report single-cause, plane first; neither
    // block is ever `internal`.
    expect(entry.blocks.map((block) => block.code)).toEqual(['PLANE_UNRESOLVED']);
    expect(entry.blocks[0]?.detail).not.toContain('internal');
  });

  it('no exposure/lifecycle signals: user-facing by conservative default, never internal', () => {
    const result = classifyResources(cleanInput());
    const entry = decision(result);
    expect(entry.blocks).toEqual([]);
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(entry.classification?.rules).toContain(RULES.exposureDefault);
    expect(entry.classification?.defaultsApplied).toContain(RULES.exposureDefault);
  });

  it('unknown lifecycle operations default enabled; delete without semantics blocks', () => {
    // Structural signals only: no delete-semantics evidence at all.
    const result = classify({
      resources: [resource()],
      signals: structuralSignals(),
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result);
    // The block only fires because the conservative default ENABLED
    // delete; a delete=true lifecycle without semantics is not a valid
    // Classification, so the decision stays null behind the typed block.
    expect(entry.blocks.map((block) => block.code)).toEqual(['DELETE_SEMANTICS_UNRESOLVED']);
    expect(entry.classification).toBeNull();
    // The enabled-by-default surface itself is observable on the clean
    // variant (hard delete proven):
    const clean = classify({ ...cleanInput(), resources: [resource()] });
    expect(decision(clean).classification?.lifecycle).toEqual({
      create: true,
      read: true,
      update: true,
      delete: true,
      deleteSemantics: 'hard',
    });
    expect(decision(clean).classification?.defaultsApplied.join('\n')).toContain(
      'LIFECYCLE_DEFAULT_ENABLED(create)',
    );
  });

  it('a full clean signal set (hard delete + adapter) yields a complete decision', () => {
    const result = classifyResources(cleanInput());
    // Same input but with the delete-semantics the clean baseline needs:
    const withArchive = classify({
      ...cleanInput(),
      signals: [
        ...structuralSignals(),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
    });
    const entry = decision(withArchive);
    expect(entry.blocks).toEqual([]);
    expect(entry.classification?.lifecycle.deleteSemantics).toBe('hard');
    expect(entry.classification?.evidenceAdapter).toBe('accounts');
    expect(entry.classification?.primaryKey).toEqual(['id']);
    expect(entry.classification?.decisionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.staleTargets).toEqual([]);
    expect(result.invalidSignals).toEqual([]);
  });

  it('archive delete semantics require owner-owned archive state', () => {
    const result = classify({
      ...cleanInput(),
      signals: [
        ...structuralSignals(),
        signal({ dimension: 'delete-semantics', assertion: 'archive' }),
      ],
    });
    const entry = decision(result);
    expect(entry.blocks.map((block) => block.code)).toEqual(['DELETE_SEMANTICS_UNRESOLVED']);
    // With owner-owned archive state the decision completes:
    const proven = classify({
      ...cleanInput(),
      signals: [
        ...structuralSignals(),
        signal({ dimension: 'delete-semantics', assertion: 'archive' }),
        signal({ dimension: 'archive-state', assertion: { status: 'archived' } }),
      ],
    });
    const ok = decision(proven);
    expect(ok.blocks).toEqual([]);
    expect(ok.classification?.lifecycle.deleteSemantics).toBe('archive');
    expect(ok.classification?.lifecycle.archiveFields).toEqual({ status: 'archived' });
  });

  it('composite primary keys preserve ordered columns', () => {
    const result = classify({
      ...cleanInput(),
      signals: [
        signal({ dimension: 'identity', assertion: ['region', 'code'] }),
        signal({ dimension: 'plane', assertion: 'tenant' }),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
    });
    const entry = decision(result);
    expect(entry.blocks).toEqual([]);
    expect(entry.classification?.primaryKey).toEqual(['region', 'code']);
  });
});

// ---------------------------------------------------------------------------
// Checklist: internality certificate and contradictions
// ---------------------------------------------------------------------------

describe('internality certificate', () => {
  const internalIntent = signal({
    dimension: 'internality',
    assertion: true,
    basis: 'declaration',
    location: LOC,
  });
  const workerReachability = signal({
    dimension: 'internality',
    assertion: { category: 'worker' },
    basis: 'code-positive',
    location: { file: 'backend/workers/sync.py', line: 5, col: 0 },
    detector: { id: 'test.worker-detector', version: '1.0.0' },
  });

  function closedWorldDelete(): ClassificationSignal {
    return signal({
      dimension: 'lifecycle.delete',
      assertion: false,
      basis: 'code-negative-closed-world',
      location: LOC,
    });
  }

  it('full certificate: declaration + complete scan + trusted reachability ⇒ internal', () => {
    const result = classify({
      resources: [resource()],
      signals: [
        ...structuralSignals(),
        internalIntent,
        workerReachability,
        closedWorldDelete(),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
      policy: policy(),
      adapters: [],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result);
    expect(entry.blocks).toEqual([]);
    expect(entry.classification?.exposure).toBe('internal');
    expect(entry.classification?.rules).toContain(RULES.exposureInternalCertificate);
    expect(entry.classification?.lifecycle.delete).toBe(false);
    expect(entry.classification?.rules.join('\n')).toContain(RULES.lifecycleClosedWorldDisabled);
    // Internal resources need no adapter:
    expect(entry.classification?.evidenceAdapter).toBeUndefined();
  });

  it('authority-channel declarations require a configured source (untrusted sources are inert)', () => {
    // Channel model (ADR 0003 D2): a declaration on the authority channel
    // with an UNCONFIGURED source proves nothing. Detector-channel
    // suppressive shapes are rejected outright (dedicated red-team test
    // below); closed-world proofs on the authority channel are engine-
    // attested by the complete-scan requirement, not by source strings.
    const forged = signal({
      source: 'gateforge.evil',
      dimension: 'internality',
      assertion: true,
      basis: 'declaration',
    });
    const result = classify({
      resources: [resource()],
      signals: [
        ...structuralSignals(),
        forged,
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result);
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(result.unauthorizedSuppressive).toEqual([]);
  });

  it('a positive route signal overrides internal intent and blocks the contradiction', () => {
    const routeSignal = signal({
      dimension: 'exposure',
      assertion: 'route',
      location: ROUTE_LOC,
      detector: { id: 'gateforge.pack-http', version: '0.1.0' },
    });
    const result = classify({
      resources: [resource()],
      signals: [
        ...structuralSignals(),
        internalIntent,
        workerReachability,
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
        routeSignal,
      ],
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result);
    // Conservative decision stands AND the contradiction blocks:
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(entry.classification?.contradictions).toHaveLength(1);
    expect(entry.classification?.contradictions[0]?.dimension).toBe('exposure');
    expect(entry.blocks.map((block) => block.code)).toEqual(['CLASSIFICATION_CONTRADICTION']);
    expect(entry.blocks[0]?.detail).toContain('backend/models/account.py:14');
    expect(entry.blocks[0]?.detail).toContain('backend/api/accounts.py:61');
    expect(entry.classification?.rules).toContain(RULES.exposurePositive);
  });

  it('a parse finding in scope invalidates the closed-world certificate', () => {
    const result = classify({
      resources: [resource()],
      signals: [
        ...structuralSignals(),
        internalIntent,
        workerReachability,
        closedWorldDelete(),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
      policy: policy(),
      adapters: ['accounts'],
      scan: {
        findings: [
          { code: 'PARSE_ERROR', locations: [{ file: 'backend/api/accounts.py', line: 1, col: 0 }] },
        ],
        unresolved: [],
      },
    });
    const entry = decision(result);
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(entry.classification?.lifecycle.delete).toBe(true); // closed-world disable lost its proof too
    expect(entry.blocks.map((block) => block.code)).toEqual([
      'INCOMPLETE_PROOF_SCOPE',
      'INCOMPLETE_PROOF_SCOPE',
    ]);
    expect(
      entry.blocks.find((block) => block.code === 'INCOMPLETE_PROOF_SCOPE')?.detail,
    ).toContain('complete-scan attestation fails');
  });

  it('internal intent without reachability signals cannot certify', () => {
    const result = classify({
      resources: [resource()],
      signals: [
        ...structuralSignals(),
        internalIntent,
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result);
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(entry.blocks.map((block) => block.code)).toEqual(['INCOMPLETE_PROOF_SCOPE']);
    expect(entry.blocks.find((block) => block.code === 'INCOMPLETE_PROOF_SCOPE')?.detail).toContain(
      'no trusted-internal reachability signal',
    );
  });

  it('untrusted entry-point categories cannot certify', () => {
    const result = classify({
      resources: [resource()],
      signals: [
        ...structuralSignals(),
        internalIntent,
        signal({
          dimension: 'internality',
          assertion: { category: 'public-handler' },
          basis: 'code-positive',
        }),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result);
    expect(entry.classification?.exposure).toBe('user-facing');
    // The 'public-handler' category is not trusted at all: its reachability
    // signal is rejected outright (round 5) and the certificate cannot fire.
    expect(
      entry.blocks.find((block) => block.code === 'INCOMPLETE_PROOF_SCOPE')?.detail,
    ).toContain('no trusted-internal reachability');
  });

  it('an organization internal rule alone is not proof (certificate still required)', () => {
    const result = classify({
      resources: [
        resource({ name: 'audit_log', id: 'tenant.audit_log' }),
      ],
      signals: [
        signal({ dimension: 'identity', assertion: ['id'], target: { resourceName: 'audit_log' } }),
        signal({ dimension: 'plane', assertion: 'tenant', target: { resourceName: 'audit_log' } }),
        signal({
          dimension: 'delete-semantics',
          assertion: 'hard',
          target: { resourceName: 'audit_log' },
        }),
      ],
      policy: policy({
        internalRules: [{ match: { resourceName: '*_log' }, reason: 'compliance ledger' }],
      }),
      adapters: ['audit_log'],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result, 'audit_log');
    // The name rule matched, but without reachability + declaration the
    // conservative default holds:
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(entry.blocks.map((block) => block.code)).toEqual(['INCOMPLETE_PROOF_SCOPE']);
    expect(entry.classification?.rules).toContain(RULES.exposureDefault);
  });
});

// ---------------------------------------------------------------------------
// Checklist: lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle lattice', () => {
  it('a positive mutation signal enables the operation and wins over declarations', () => {
    const result = classify({
      ...cleanInput(),
      signals: [
        ...structuralSignals(),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
        signal({ dimension: 'lifecycle.create', assertion: true }),
        signal({ dimension: 'lifecycle.create', assertion: false, basis: 'declaration' }),
      ],
    });
    const entry = decision(result);
    expect(entry.blocks.map((block) => block.code)).toEqual(['LIFECYCLE_CONTRADICTION']);
    expect(entry.classification?.lifecycle.create).toBe(true);
    expect(entry.classification?.contradictions[0]?.dimension).toBe('lifecycle.create');
  });

  it('a lone unsupported declaration never disables (conservative default)', () => {
    const result = classify({
      ...cleanInput(),
      signals: [
        ...structuralSignals(),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
        signal({ dimension: 'lifecycle.update', assertion: false, basis: 'declaration' }),
      ],
    });
    const entry = decision(result);
    expect(entry.blocks).toEqual([]);
    expect(entry.classification?.lifecycle.update).toBe(true);
    expect(entry.classification?.defaultsApplied.join('\n')).toContain('LIFECYCLE_DEFAULT_ENABLED(update)');
  });

  it('closed-world disable requires a complete scan; incomplete scope keeps it enabled and blocks', () => {
    const signals = [
      ...structuralSignals(),
      signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      signal({ dimension: 'lifecycle.update', assertion: false, basis: 'code-negative-closed-world' }),
    ];
    const complete = classify({
      ...cleanInput(),
      signals,
      scan: EMPTY_SCAN,
    });
    expect(decision(complete).classification?.lifecycle.update).toBe(false);

    const broken = classify({
      ...cleanInput(),
      signals,
      scan: {
        findings: [{ code: 'PARSE_ERROR', locations: [{ file: 'backend/x.py', line: 3, col: 0 }] }],
        unresolved: [],
      },
    });
    const entry = decision(broken);
    expect(entry.classification?.lifecycle.update).toBe(true);
    expect(entry.blocks.map((block) => block.code)).toEqual(['INCOMPLETE_PROOF_SCOPE']);
  });
});

// ---------------------------------------------------------------------------
// Checklist: plane, identity, adapter, hostile inputs
// ---------------------------------------------------------------------------

describe('plane, identity, adapter, hostile input', () => {
  it('conflicting plane assertions block (never guess across planes)', () => {
    const result = classify({
      ...cleanInput(),
      signals: [
        signal({ dimension: 'plane', assertion: 'tenant' }),
        signal({ dimension: 'plane', assertion: 'master' }),
        signal({ dimension: 'identity', assertion: ['id'] }),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
    });
    expect(decision(result).blocks.map((block) => block.code)).toEqual(['PLANE_CONTRADICTION']);
  });

  it('conflicting identity assertions block (never guess the key)', () => {
    const result = classify({
      ...cleanInput(),
      signals: [
        signal({ dimension: 'plane', assertion: 'tenant' }),
        signal({ dimension: 'identity', assertion: ['id'] }),
        signal({ dimension: 'identity', assertion: ['uuid'] }),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
    });
    expect(decision(result).blocks.map((block) => block.code)).toEqual(['IDENTITY_CONTRADICTION']);
  });

  it('user-facing without an adapter blocks as ADAPTER_MISSING', () => {
    const result = classify({ ...cleanInput(), adapters: [] });
    expect(decision(result).blocks.map((block) => block.code)).toEqual(['ADAPTER_MISSING']);
  });

  it('stale signal targets surface as typed blocks', () => {
    const result = classify({
      ...cleanInput(),
      signals: [
        ...structuralSignals(),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
        signal({
          dimension: 'exposure',
          assertion: 'route',
          target: { resourceName: 'removed_table' },
        }),
      ],
    });
    expect(result.staleTargets).toHaveLength(1);
    expect(result.staleTargets[0]?.code).toBe('STALE_SIGNAL_TARGET');
    expect(result.staleTargets[0]?.name).toBe('removed_table');
  });

  it('malformed assertions become INVALID_SIGNAL blocks (hostile input)', () => {
    const result = classify({
      ...cleanInput(),
      signals: [
        ...structuralSignals(),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
        { ...signal({ dimension: 'plane', assertion: 'tenant' }), assertion: ' Explode ' as unknown as string },
      ],
    });
    expect(result.invalidSignals).toHaveLength(1);
    expect(result.invalidSignals[0]?.code).toBe('INVALID_SIGNAL');
  });

  it('duplicate signals deduplicate into one contributing id', () => {
    const dup = signal({ dimension: 'exposure', assertion: 'route' });
    const result = classifyResources(cleanInput([dup, { ...dup }]));
    const entry = decision(result);
    expect(entry.blocks).toEqual([]); // delete-semantics hard present in the baseline
    const routeId = signalId(dup);
    expect(entry.classification?.contributingSignalIds.filter((id) => id === routeId)).toHaveLength(1);
  });

  it('signals bind by symbol (classQname) and by plane-qualified id', () => {
    const bySymbol = resource({ id: null, attributes: { classQname: 'app.models.Account' } });
    const result = classify({
      resources: [bySymbol],
      signals: [
        signal({ dimension: 'identity', assertion: ['id'], target: { symbol: 'app.models.Account' } }),
        signal({ dimension: 'plane', assertion: 'tenant', target: { symbol: 'app.models.Account' } }),
        signal({ dimension: 'delete-semantics', assertion: 'hard', target: { resourceName: 'accounts' } }),
        signal({ dimension: 'exposure', assertion: 'route', target: { symbol: 'app.models.Account' } }),
      ],
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result);
    expect(entry.blocks).toEqual([]);
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(entry.classification?.evidenceAdapter).toBe('accounts');
    expect(entry.classification?.rules).toContain(RULES.exposurePositive);
  });

  it('the signal schema rejects a confidence-score field (no authority channel)', () => {
    expect(() =>
      ClassificationSignalSchema.parse({
        ...signal({ dimension: 'exposure', assertion: true }),
        confidence: 0.97,
      }),
    ).toThrow();
  });

  it('the signal schema rejects signals without a location or detector identity', () => {
    const missingLocation = signal({ dimension: 'exposure', assertion: true });
    const { location: _location, ...noLocation } = missingLocation;
    expect(() => ClassificationSignalSchema.parse(noLocation)).toThrow();
    const missingDetector = signal({ dimension: 'exposure', assertion: true });
    const { detector: _detector, ...noDetector } = missingDetector;
    expect(() => ClassificationSignalSchema.parse(noDetector)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Checklist: determinism and monotonicity
// ---------------------------------------------------------------------------

describe('determinism and monotonicity', () => {
  it('input-order permutations produce byte-identical decisions', () => {
    const signals = [
      signal({ dimension: 'identity', assertion: ['id'] }),
      signal({ dimension: 'plane', assertion: 'tenant' }),
      signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      signal({ dimension: 'exposure', assertion: 'route', location: ROUTE_LOC }),
      signal({ dimension: 'lifecycle.create', assertion: true }),
    ];
    const forward = classify({
      resources: [resource()],
      signals,
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    const reversed = classify({
      resources: [resource()],
      signals: [...signals].reverse(),
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    expect(canonicalJson(reversed as unknown as JsonValue)).toBe(
      canonicalJson(forward as unknown as JsonValue),
    );
  });

  it('any signal-content change moves the decision fingerprint (stale-awareness)', () => {
    const before = classifyResources(cleanInput([signal({ dimension: 'exposure', assertion: 'route', location: ROUTE_LOC })]));
    const movedRoute = signal({
      dimension: 'exposure',
      assertion: 'route',
      location: { file: 'backend/api/accounts.py', line: 62, col: 0 },
    });
    const after = classifyResources(cleanInput([movedRoute]));
    expect(decision(after).classification?.decisionFingerprint).not.toBe(
      decision(before).classification?.decisionFingerprint,
    );
  });

  it('adding positive signals never reduces the enabled lifecycle surface (property sweep)', () => {
    // Monotonicity invariant (ADR 0003 D3), restricted to POSITIVE
    // signals: for every pair of positive-only signal sets A ⊆ B,
    // enabled(B) ⊇ enabled(A) and internal(B) ⇒ internal(A). (Closed-
    // world negatives are suppressive by design and exempt — a VALID
    // negative proof is exactly what is allowed to reduce obligations.)
    const positiveUniverse: ClassificationSignal[] = [
      signal({ dimension: 'lifecycle.create', assertion: true }),
      signal({ dimension: 'lifecycle.update', assertion: true }),
      signal({ dimension: 'exposure', assertion: 'route', location: ROUTE_LOC }),
      signal({
        dimension: 'internality',
        assertion: { category: 'worker' },
        basis: 'code-positive',
      }),
    ];
    const total = 1 << positiveUniverse.length;
    const classifySubset = (signals: ClassificationSignal[]): ClassificationResult =>
      classify({
        resources: [resource()],
        signals: [
          ...structuralSignals(),
          signal({ dimension: 'delete-semantics', assertion: 'hard' }),
          ...signals,
        ],
        policy: policy(),
        adapters: ['accounts'],
        scan: EMPTY_SCAN,
      });
    for (let a = 0; a < total; a++) {
      for (let b = 0; b < total; b++) {
        if ((a & ~b) !== 0) continue; // only A ⊆ B pairs
        const setA = positiveUniverse.filter((_, i) => (a & (1 << i)) !== 0);
        const setB = positiveUniverse.filter((_, i) => (b & (1 << i)) !== 0);
        const decisionA = decision(classifySubset(setA));
        const decisionB = decision(classifySubset(setB));
        const lifecycleA = decisionA.classification?.lifecycle;
        const lifecycleB = decisionB.classification?.lifecycle;
        if (!lifecycleA || !lifecycleB) continue; // blocked ⇒ no obligations on either side
        const enabled = (lifecycle: typeof lifecycleA): number =>
          (lifecycle.create ? 1 : 0) + (lifecycle.read ? 2 : 0) + (lifecycle.update ? 4 : 0) + (lifecycle.delete ? 8 : 0);
        // Adding positive signals can enable more operations, never fewer.
        expect(enabled(lifecycleB) & enabled(lifecycleA), `subset ${a} ⊆ ${b}`).toBe(
          enabled(lifecycleA),
        );
        // And internal never silently appears where user-facing was:
        if (decisionB.classification?.exposure === 'internal') {
          expect(decisionA.classification?.exposure).toBe('internal');
        }
      }
    }
  }, 20_000);

  it('scan-root globs match nested paths (complete-scan scope soundness)', () => {
    const result = classify({
      resources: [resource()],
      signals: [
        ...structuralSignals(),
        signal({ dimension: 'internality', assertion: true, basis: 'declaration' }),
        signal({ dimension: 'internality', assertion: { category: 'worker' }, basis: 'code-positive' }),
        signal({ dimension: 'lifecycle.delete', assertion: false, basis: 'code-negative-closed-world' }),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      ],
      policy: policy(),
      adapters: ['accounts'],
      scan: {
        findings: [
          { code: 'PARSE_ERROR', locations: [{ file: 'backend/api/routes.py', line: 2, col: 0 }] },
        ],
        unresolved: [],
      },
    });
    const entry = decision(result);
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(entry.classification?.lifecycle.delete).toBe(true);
    expect(entry.blocks.map((block) => block.code)).toEqual([
      'INCOMPLETE_PROOF_SCOPE',
      'INCOMPLETE_PROOF_SCOPE',
    ]);
  });

  it('removing all evidence never yields internal (the certificate is never persisted)', () => {
    const signals = [
      signal({ dimension: 'identity', assertion: ['id'] }),
      signal({ dimension: 'plane', assertion: 'tenant' }),
      signal({ dimension: 'delete-semantics', assertion: 'hard' }),
      signal({ dimension: 'internality', assertion: true, basis: 'declaration' }),
      signal({
        dimension: 'internality',
        assertion: { category: 'worker' },
        basis: 'code-positive',
        location: { file: 'backend/workers/sync.py', line: 5, col: 0 },
        detector: { id: 'test.worker-detector', version: '1.0.0' },
      }),
    ];
    const internal = classify({
      resources: [resource()],
      signals,
      policy: policy(),
      adapters: [],
      scan: EMPTY_SCAN,
    });
    expect(decision(internal).classification?.exposure).toBe('internal');
    // Now the same run with a finding anywhere in scope: back to user-facing.
    const invalidated = classify({
      resources: [resource()],
      signals: [...signals, signal({ dimension: 'delete-semantics', assertion: 'hard' })],
      policy: policy(),
      adapters: ['accounts'],
      scan: {
        findings: [{ code: 'PARSE_ERROR', locations: [{ file: 'backend/workers/sync.py', line: 9, col: 0 }] }],
        unresolved: [],
      },
    });
    expect(decision(invalidated).classification?.exposure).toBe('user-facing');
    expect(decision(invalidated).blocks.map((b) => b.code)).toEqual(['INCOMPLETE_PROOF_SCOPE']);
  });
});

// ---------------------------------------------------------------------------
// Red-team regressions (V1/V2): channel-bound authority
// ---------------------------------------------------------------------------

describe('suppressive authority is channel-bound, never identity-claimed', () => {
  it('detector-channel suppressive signals are rejected LOUDLY, whatever identity they claim', () => {
    // A plugin emitting a full forged certificate — even claiming the
    // engine's own `gateforge.core@1` identity — is rejected by CHANNEL:
    // typed block, conservative decision, gate red.
    const forged = classifyResources({
      resources: [resource()],
      signals: [
        ...structuralSignals(),
        signal({ dimension: 'delete-semantics', assertion: 'hard' }),
        signal({
          dimension: 'internality',
          assertion: true,
          basis: 'declaration',
          source: 'gateforge:internal',
          location: ROUTE_LOC,
        }),
        signal({
          dimension: 'lifecycle.delete',
          assertion: false,
          basis: 'code-negative-closed-world',
          source: 'gateforge:internal',
          location: ROUTE_LOC,
        }),
      ],
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    const entry = decision(forged);
    // Conservative defaults stand: user-facing, delete enabled.
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(entry.classification?.lifecycle.delete).toBe(true);
    // The attempt is VISIBLE (never silently ignored) and blocks the gate:
    // the document-level blocks project into blocking entries.
    expect(forged.unauthorizedSuppressive).toHaveLength(2);
    expect(forged.unauthorizedSuppressive.every((b) => b.code === 'UNAUTHORIZED_SUPPRESSIVE_SIGNAL')).toBe(true);
    const blocking = classifierBlocking(forged, {
      schemaVersion: 1,
      resources: [],
      unresolved: [],
      findings: [],
      stale: [],
    } as never);
    expect(blocking.some((b) => b.detail.includes('UNAUTHORIZED_SUPPRESSIVE_SIGNAL'))).toBe(true);
  });

  it('authority-channel declarations still require a CONFIGURED source', () => {
    // An engine-channel declaration whose source is not configured proves
    // nothing: `gateforge.policy:*` is not a configured declaration source.
    const result = classifyResources({
      resources: [resource()],
      signals: [...structuralSignals(), signal({ dimension: 'delete-semantics', assertion: 'hard' })],
      authority: [
        signal({
          dimension: 'internality',
          assertion: true,
          basis: 'declaration',
          source: 'gateforge.policy:shadow-rule',
          location: ROUTE_LOC,
        }),
      ],
      policy: policy(),
      adapters: ['accounts'],
      scan: EMPTY_SCAN,
    });
    const entry = decision(result);
    expect(entry.classification?.exposure).toBe('user-facing');
    expect(result.unauthorizedSuppressive).toEqual([]);
    expect(entry.blocks).toEqual([]);
  });

  it('duplicate signal emission does not move the decision fingerprint (idempotent evidence)', () => {
    const base = cleanInput([
      signal({
        dimension: 'internality',
        assertion: true,
        basis: 'declaration',
        source: 'gateforge:internal',
        location: ROUTE_LOC,
      }),
    ]);
    const once = classify(base);
    const duplicated: typeof base.signals = [...base.signals, ...base.signals.slice(-1)];
    const twice = classify({ ...base, signals: duplicated });
    expect(decision(once).classification?.decisionFingerprint).toBe(
      decision(twice).classification?.decisionFingerprint,
    );
  });
});
