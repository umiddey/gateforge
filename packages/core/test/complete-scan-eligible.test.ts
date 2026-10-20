/**
 * Run-wide complete-scan scope (plan 20261020_1130, item a): the
 * RUN-WIDE `completeScanHolds` branch counts only files a detector can
 * READ — requested paths inside the pipeline-reported detector input
 * set (`eligiblePaths`) — mirroring `exposureCoverageHolds` in the same
 * module. Before the fix the run-wide branch scoped to every requested
 * path, so unruled non-code files inside `scanRoots` (README, lock
 * files, images — 2867 of them on a real project) were "coverage gaps"
 * and the run could never attest a complete scan. Fail-closed is
 * untouched: with no reported input set every requested path stays in
 * scope, and a detector-eligible file a rule applies to that the
 * detector did not report scanning is still a hole.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyResources,
  type ClassifierResourceRef,
  type ClassifierScanInput,
  type ClassifyResourcesInput,
} from '../src/classifier/classify.js';
import type { ClassificationSignal } from '../src/schemas/classification-signal.js';
import type { ClassifierPolicy } from '../src/schemas/scan-config.js';

const MODEL_SOURCE = 'backend/models/meter_reading.py';
const MODEL_LOCATION = { file: MODEL_SOURCE, line: 12, col: 7 };
const BASE_SOURCE = 'backend/models/base.py';
const ROUTE_SOURCE = 'backend/routes/meter_routes.py';
const SQL_DETECTOR = { id: 'gateforge.pack-sqlalchemy', version: '0.15.1' } as const;
const CODE_FILES = [MODEL_SOURCE, BASE_SOURCE, ROUTE_SOURCE];
/** Non-code files the broad scanRoots request but NO detector can parse. */
const NON_CODE_FILES = ['README.md', 'package-lock.json'];

function modelResource(): ClassifierResourceRef {
  return {
    name: 'meter_readings',
    id: 'tenant.meter_readings',
    kind: 'sql.table',
    source: MODEL_SOURCE,
    location: MODEL_LOCATION,
    detector: SQL_DETECTOR,
    attributes: { plane: 'tenant' },
  };
}

/** Identity evidence plus trusted reachability for the model category. */
function modelSignals(): ClassificationSignal[] {
  return [
    {
      schemaVersion: 1,
      target: { resourceName: 'meter_readings' },
      dimension: 'identity',
      assertion: ['id'],
      basis: 'code-positive',
      source: 'gateforge.pack-sqlalchemy',
      location: MODEL_LOCATION,
      detector: SQL_DETECTOR,
    },
    {
      schemaVersion: 1,
      target: { resourceName: 'meter_readings' },
      dimension: 'internality',
      assertion: 'model',
      basis: 'code-positive',
      source: 'gateforge.pack-sqlalchemy',
      location: MODEL_LOCATION,
      detector: SQL_DETECTOR,
    },
  ];
}

/**
 * A scan whose requested set includes unruled non-code files while the
 * detector reported scanning every CODE file it was handed
 * (`eligiblePaths`).
 */
function completeScan(options?: {
  eligiblePaths?: boolean;
  baseScanned?: boolean;
}): ClassifierScanInput {
  const eligible = options?.eligiblePaths ?? true;
  const baseScanned = options?.baseScanned ?? true;
  return {
    requestedPaths: [...NON_CODE_FILES, ...CODE_FILES],
    ...(eligible ? { eligiblePaths: [...CODE_FILES] } : {}),
    coverage: [
      {
        detector: 'gateforge.pack-sqlalchemy',
        scannedPaths: CODE_FILES.filter((path) => path !== BASE_SOURCE || baseScanned),
      },
    ],
    configuredDetectors: 1,
    successfulDetectors: 1,
    findings: [],
    unresolved: [],
  };
}

function policy(): ClassifierPolicy {
  return {
    schemaVersion: 1,
    scanRoots: ['**/*'],
    coverage: [
      {
        capability: 'exposure.models',
        detector: 'gateforge.pack-sqlalchemy',
        appliesTo: ['backend/**'],
        exhaustive: true,
      },
      {
        capability: 'models.sqlalchemy',
        detector: 'gateforge.pack-sqlalchemy',
        appliesTo: ['backend/**'],
      },
    ],
    declarations: {},
    volatileFields: [],
    trustedInternalEntryPoints: [{ category: 'model', detector: 'gateforge.pack-sqlalchemy' }],
    internalRules: [
      { match: { resourceKind: 'sql.table' }, reason: 'database tables are internal' },
    ],
    deleteRules: [
      {
        match: 'backend/models/**',
        semantics: 'hard',
        reason: 'tables are rebuildable from migrations',
      },
    ],
  };
}

function classify(scan: ClassifierScanInput): ClassifyResourcesInput {
  return {
    resources: [modelResource()],
    signals: modelSignals(),
    policy: policy(),
    adapters: ['tenant.meter_readings'],
    scan,
  };
}

describe('run-wide complete-scan scope (detector-eligible files only)', () => {
  it('(a) attests the run-wide complete scan with unruled non-code files requested, every eligible code file scanned', () => {
    const result = classifyResources(classify(completeScan()));

    expect(result.invalidSignals).toEqual([]);
    expect(result.decisions).toHaveLength(1);
    const decision = result.decisions[0];
    expect(decision).toBeDefined();
    const incomplete = decision?.blocks.filter((block) => block.code === 'INCOMPLETE_PROOF_SCOPE');
    // No block at all: the run-wide attestation AND the exposure
    // certificate both hold on this scan.
    expect(incomplete).toEqual([]);
    expect(decision?.classification?.exposure).toBe('internal');
    expect(decision?.classification?.rules).toContain('EXPOSURE_INTERNAL_CERTIFICATE');
  });

  it('stays fail-closed when the pipeline reports no detector input set (eligiblePaths undefined)', () => {
    const result = classifyResources(classify(completeScan({ eligiblePaths: false })));

    const decision = result.decisions[0];
    expect(decision).toBeDefined();
    const incomplete = decision?.blocks.filter((block) => block.code === 'INCOMPLETE_PROOF_SCOPE');
    expect(incomplete?.length).toBe(1);
    expect(incomplete?.[0]?.detail).toContain('complete-scan attestation fails');
    expect(decision?.classification?.exposure).toBe('user-facing');
  });

  it('stays fail-closed when an eligible code file the rule applies to was not scanned', () => {
    const result = classifyResources(classify(completeScan({ baseScanned: false })));

    const decision = result.decisions[0];
    expect(decision).toBeDefined();
    const incomplete = decision?.blocks.filter((block) => block.code === 'INCOMPLETE_PROOF_SCOPE');
    expect(incomplete?.length).toBe(1);
    expect(incomplete?.[0]?.detail).toContain('complete-scan attestation fails');
    expect(decision?.classification?.exposure).toBe('user-facing');
  });
});
