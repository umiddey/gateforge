import { describe, expect, it } from 'vitest';
import { classifyResources, type ClassifierResourceRef, type ClassifierScanInput, type ClassifyResourcesInput } from '../src/classifier/classify.js';
import type { ClassificationSignal, SignalAssertion } from '../src/schemas/classification-signal.js';
import type { ClassifierPolicy } from '../src/schemas/scan-config.js';
import { ClassificationPolicySchema } from '../src/schemas/classification-policy.js';
import { HTTP_ENDPOINT_RESOURCE_KIND } from '../src/graph/schema.js';

const TABLE = 'seed_codes';
const ENDPOINT = 'POST /notes';
const MIGRATION = 'migrations/versions/0001_seed.py';
const ROUTE = 'app/routes.py';
const SQL_DETECTOR = 'gateforge.pack-sqlalchemy';
const COMPILER_DETECTOR = 'gateforge.compiler';

function tableResource(): ClassifierResourceRef {
  return { kind: 'sql.table', id: null, name: TABLE, source: 'app/models.py', location: { file: 'app/models.py', line: 1, col: 1 }, detector: { id: SQL_DETECTOR, version: '0.2.0' }, attributes: { plane: 'tenant' } };
}

function endpointResource(): ClassifierResourceRef {
  return {
    kind: HTTP_ENDPOINT_RESOURCE_KIND,
    id: null,
    name: ENDPOINT,
    detector: { id: COMPILER_DETECTOR, version: '1' },
    source: ROUTE,
    location: { file: ROUTE, line: 1, col: 1 },
    attributes: { resourceName: ENDPOINT, method: 'POST', canonicalPath: '/notes', linkedResourceName: TABLE },
  };
}

function signal(
  dimension: string,
  assertion: SignalAssertion,
  target: Record<string, string>,
  detector: string,
  location: Record<string, unknown>,
): ClassificationSignal {
  return {
    schemaVersion: 1,
    target,
    dimension,
    assertion,
    basis: 'code-positive',
    source: detector,
    location,
    detector: { id: detector, version: '0.2.0' },
  } as unknown as ClassificationSignal;
}

const reachability = signal(
  'internality' as ClassificationSignal['dimension'],
  'migration' as SignalAssertion,
  { resourceName: TABLE },
  SQL_DETECTOR,
  { file: MIGRATION, line: 1, col: 1 },
);

const binding = signal(
  'adapter-binding',
  TABLE as SignalAssertion,
  { resourceName: ENDPOINT },
  COMPILER_DETECTOR,
  { file: ROUTE, line: 1, col: 1 },
);

const primaryKey = signal(
  'identity' as ClassificationSignal['dimension'],
  ['id'] as unknown as SignalAssertion,
  { resourceName: TABLE },
  SQL_DETECTOR,
  { file: MIGRATION, line: 1, col: 1 },
);

const hardDelete = signal(
  'delete-semantics' as ClassificationSignal['dimension'],
  'hard' as SignalAssertion,
  { resourceName: TABLE },
  SQL_DETECTOR,
  { file: MIGRATION, line: 1, col: 1 },
);

const policy = {
  ...ClassificationPolicySchema.parse({
    schemaVersion: 1,
    internalRules: [{ match: { resourceName: TABLE }, reason: 'fixture: organization-declared internal table' }],
    trustedInternalEntryPoints: [{ category: 'migration', detector: SQL_DETECTOR }],
    deleteRules: [{ match: 'backend/models/**', semantics: 'hard', reason: 'fixture' }],
  }),
  // scanRoots and coverage come from the merged policy (`.gateforge.yml scan:` and owner coverage), not the strict answers schema.
  coverage: [{ capability: 'exposure.models', detector: SQL_DETECTOR, appliesTo: ['**/*.py'], exhaustive: true }],
  scanRoots: ['**'],
} as unknown as ClassifierPolicy;

// classify.ts compares configuredDetectors and successfulDetectors by reference (!==), so the fixture shares one array.
const DETECTORS = [SQL_DETECTOR];

function scan(): ClassifierScanInput {
  return {
    requestedPaths: [MIGRATION],
    eligiblePaths: [MIGRATION],
    coverage: [{ detector: SQL_DETECTOR, scannedPaths: [MIGRATION] }],
    configuredDetectors: DETECTORS,
    successfulDetectors: DETECTORS,
    findings: [],
    unresolved: [],
  } as unknown as ClassifierScanInput;
}

function input(withEndpoint: boolean, signals: ClassificationSignal[]): ClassifyResourcesInput {
  const resources = withEndpoint ? [tableResource(), endpointResource()] : [tableResource()];
  return { resources, signals, policy, adapters: [TABLE], scan: scan() } as unknown as ClassifyResourcesInput;
}

function decisionText(result: unknown, name: string): string {
  const decisions = (result as { decisions: Array<{ name: string }> }).decisions;
  const found = decisions.find((d) => d.name === name);
  expect(found).toBeDefined();
  return JSON.stringify(found);
}

describe('internal reachability guard', () => {
  it('G1 table with accepted internal reachability and no endpoint stays internal-certified', () => {
    const result = classifyResources(input(false, [reachability, primaryKey, hardDelete]));
    const text = decisionText(result, TABLE);
    expect(text).toContain('"exposure":"internal"');
    expect(text).toContain('EXPOSURE_INTERNAL_CERTIFICATE');
  });

  it('G2 linked endpoint downgrades internal reachability to user-facing with INCOMPLETE_PROOF_SCOPE', () => {
    const result = classifyResources(input(true, [reachability, binding, primaryKey, hardDelete]));
    const text = decisionText(result, TABLE);
    expect(text).toContain('"exposure":"user-facing"');
    expect(text).toContain('INCOMPLETE_PROOF_SCOPE');
    expect(text).toContain(ENDPOINT);
    expect(text).not.toContain('EXPOSURE_INTERNAL_CERTIFICATE');
  });

  it('untrusted reachability names the out-of-pattern file and locates only it', () => {
    const seed = { file: 'scripts/seed.py', line: 4, col: 1 };
    const outOfPattern = signal(
      'internality' as ClassificationSignal['dimension'],
      'migration' as SignalAssertion,
      { resourceName: TABLE },
      SQL_DETECTOR,
      seed,
    );
    const paths = [MIGRATION, seed.file];
    const result = classifyResources({
      ...input(false, [reachability, outOfPattern, primaryKey, hardDelete]),
      policy: {
        ...policy,
        trustedInternalEntryPoints: [{ category: 'migration', detector: SQL_DETECTOR, patterns: ['migrations/**'] }],
      },
      scan: { ...scan(), requestedPaths: paths, eligiblePaths: paths, coverage: [{ detector: SQL_DETECTOR, scannedPaths: paths }] },
    } as unknown as ClassifyResourcesInput);
    const block = result.decisions.find((d) => d.name === TABLE)?.blocks.find((b) => b.code === 'INCOMPLETE_PROOF_SCOPE');
    expect(block).toBeDefined();
    expect(block?.detail).toContain('migration at scripts/seed.py:4');
    expect(block?.detail).toContain('trusted migration patterns: migrations/**');
    expect(block?.detail).not.toContain('(trusted: migration)');
    expect(block?.locations).toEqual([seed]);
  });

  it('G4 a side-effect link downgrades internal reachability like a resource link: not internal-certified', () => {
    // The writing route links the table only through `sideEffectResourceNames`
    // (no `linkedResourceName`, no adapter-binding signal).
    const writer = { ...endpointResource(), attributes: { resourceName: ENDPOINT, method: 'POST', canonicalPath: '/notes', sideEffectResourceNames: [TABLE] } };
    const result = classifyResources({
      ...input(false, [reachability, primaryKey, hardDelete]),
      resources: [tableResource(), writer],
    } as unknown as ClassifyResourcesInput);
    const text = decisionText(result, TABLE);
    expect(text).toContain('"exposure":"user-facing"');
    expect(text).toContain('INCOMPLETE_PROOF_SCOPE');
    expect(text).toContain(ENDPOINT);
    expect(text).not.toContain('EXPOSURE_INTERNAL_CERTIFICATE');
  });
});
