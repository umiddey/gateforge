import { describe, expect, it } from 'vitest';
import {
  PARSE_ERROR_FINDING,
  TempRepo,
  applyParseErrorRule,
  hasParseErrors,
  runGates,
  stubDetector,
  type ClassificationFile,
  type DetectorOutput,
} from '../src/index.js';

/** Standard fixture sources: two valid files and one malformed file. */
const FIXTURE_FILES = {
  'src/good.py': 'alpha = 1\nbeta = 2\n',
  'src/broken.py': 'gamma = 3\nthis is !not valid(\n',
  'src/nested/deep.py': 'delta = 4\n',
};

/**
 * Builds a fully classified single-resource classification document.
 *
 * Args:
 *   name: resource name to classify.
 */
function oneResourceClassifications(name: string): ClassificationFile {
  return {
    schemaVersion: 1,
    resources: {
      [name]: {
        exposure: 'user-facing',
        plane: 'tenant',
        lifecycle: {
          create: true,
          read: true,
          update: false,
          delete: false,
          deleteSemantics: 'archive', archiveFields: { status: 'archived' },
        },
        primaryKey: ['id'],
        evidenceAdapter: `${name}-adapter`,
      },
    },
  };
}

/** Minimal CRUD-create policy over stub declarations. */
function createPolicy() {
  return {
    schemaVersion: 1 as const,
    policies: [{ id: 'crud-required', when: { kind: 'stub.declaration' }, require: ['crud:create'] }],
  };
}

/** A minimal well-formed Resource sourced from a given file. */
function resourceFrom(id: string, file: string, line: number) {
  return {
    schemaVersion: 1 as const,
    id,
    kind: 'stub.declaration',
    source: file,
    location: { file, line, col: 0 },
    detectorVersion: '1.0.0',
    attributes: { resourceName: id },
  };
}

describe('stub detector', () => {
  it('parses valid files; malformed file yields PARSE_ERROR with line number and no crash', () => {
    const repo = new TempRepo({ files: FIXTURE_FILES });
    try {
      const detection = stubDetector(repo, { suffixes: ['.py'] });

      // Parse audit: broken.py reported with its line number.
      expect(detection.audit).toHaveLength(3);
      const broken = detection.audit.find((entry) => entry.file === 'src/broken.py');
      expect(broken).toMatchObject({ ok: false, line: 2 });
      expect(detection.audit.find((entry) => entry.file === 'src/good.py')).toMatchObject({ ok: true });
      expect(detection.audit.find((entry) => entry.file === 'src/nested/deep.py')).toMatchObject({ ok: true });

      // The malformed file contributes NO silent resources.
      const names = detection.output.resources.map((resource) => resource.id).sort();
      expect(names).toEqual(['alpha', 'beta', 'delta']);
      expect(detection.output.resources.map((resource) => resource.source)).not.toContain('src/broken.py');

      // The finding carries the canonical code and the exact location.
      expect(detection.output.findings).toHaveLength(1);
      expect(detection.output.findings[0]).toMatchObject({
        code: PARSE_ERROR_FINDING,
        locations: [{ file: 'src/broken.py', line: 2, col: 0 }],
      });
      expect(detection.output.detectorId).toBe('gateforge.stub-detector');
    } finally {
      repo.cleanup();
    }
  });

  it('comments and blank lines are legal grammar', () => {
    const repo = new TempRepo({
      files: { 'a.py': '# heading\n\nx = 1\n  # indented comment\n' },
    });
    try {
      const detection = stubDetector(repo);
      expect(detection.audit).toEqual([{ file: 'a.py', ok: true }]);
      expect(detection.output.resources.map((resource) => resource.id)).toEqual(['x']);
      expect(detection.output.findings).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});

describe('GF-19 rule', () => {
  it('honest detector: findings pass through with provenance, no violations', () => {
    const repo = new TempRepo({ files: FIXTURE_FILES });
    try {
      const detection = stubDetector(repo);
      const result = applyParseErrorRule({
        detectorId: 'gateforge.stub-detector',
        detectorVersion: '0.0.0',
        audit: detection.audit,
        output: detection.output,
      });
      expect(result.violations).toEqual([]);
      expect(result.parseErrors).toHaveLength(1);
      expect(result.parseErrors[0]).toMatchObject({
        code: PARSE_ERROR_FINDING,
        detectorId: 'gateforge.stub-detector',
        locations: [{ file: 'src/broken.py', line: 2, col: 0 }],
      });
      expect(result.resources.map((resource) => resource.id)).toEqual(['alpha', 'beta', 'delta']);
    } finally {
      repo.cleanup();
    }
  });

  it('dishonest detector: silent resources stripped and PARSE_ERROR synthesized', () => {
    const dishonest: DetectorOutput = {
      detectorId: 'sneaky.detector',
      detectorVersion: '9.9.9',
      resources: [
        resourceFrom('ghost', 'src/broken.py', 1),
        resourceFrom('alpha', 'src/good.py', 1),
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [],
    };
    const audit = [
      { file: 'src/good.py', ok: true },
      { file: 'src/broken.py', ok: false, line: 2, detail: 'syntax error at line 2' },
    ];
    const result = applyParseErrorRule({
      detectorId: 'sneaky.detector',
      detectorVersion: '9.9.9',
      audit,
      output: dishonest,
    });

    expect(result.violations).toHaveLength(2);
    expect(result.violations.some((violation) => violation.includes('silent resource'))).toBe(true);
    expect(result.violations.some((violation) => violation.includes('no PARSE_ERROR finding'))).toBe(true);
    // The silent resource is gone; the well-sourced resource passes.
    expect(result.resources.map((resource) => resource.id)).toEqual(['alpha']);
    // The finding is guaranteed to exist with the audited line number.
    expect(result.parseErrors).toEqual([
      expect.objectContaining({
        code: PARSE_ERROR_FINDING,
        detectorId: 'sneaky.detector',
        locations: [{ file: 'src/broken.py', line: 2, col: 0 }],
      }),
    ]);
  });

  it('audit entries without line numbers fail closed at line 1', () => {
    const result = applyParseErrorRule({
      detectorId: 'd',
      detectorVersion: '1',
      audit: [{ file: 'f.py', ok: false }],
      output: {
        detectorId: 'd',
        detectorVersion: '1',
        resources: [],
        unresolved: [],
        findings: [],
        classificationSignals: [],
      },
    });
    expect(result.violations.some((violation) => violation.includes('failing closed at line 1'))).toBe(true);
    expect(result.parseErrors[0]?.locations[0]).toEqual({ file: 'f.py', line: 1, col: 0 });
  });

  it('hasParseErrors detects the canonical code', () => {
    const finding = {
      code: PARSE_ERROR_FINDING,
      detail: 'd',
      locations: [{ file: 'f.py', line: 1, col: 0 }],
      detectorId: 'd',
    };
    expect(hasParseErrors([finding])).toBe(true);
    expect(hasParseErrors([])).toBe(false);
    expect(hasParseErrors([{ ...finding, code: 'OTHER' }])).toBe(false);
  });
});

describe('GF-19 gate-runner integration', () => {
  it('malformed source fails the gate closed without crashing or leaking resources', () => {
    const repo = new TempRepo({ files: FIXTURE_FILES });
    try {
      repo.stage();
      repo.commit('fixture');
      const detection = stubDetector(repo, { suffixes: ['.py'] });
      const result = runGates({
        repo,
        detectors: [{ ...detection.output, audit: detection.audit }],
        classificationPolicy: {
          schemaVersion: 1,
          scanRoots: ['src/**/*.py'],
          trustedInternalEntryPoints: [],
          internalRules: [],
          declarations: { internality: 'gateforge:internal' },
          volatileFields: [],
        },
        policies: createPolicy(),
        evaluate: () => ({ verdict: 'missing', reason: 'no evidence records', recordIds: [] }),
        clock: { now: () => '2026-06-01T00:00:00.000Z' },
      });

      // No crash (we got here); the run is not clean.
      expect(result.clean).toBe(false);
      // The PARSE_ERROR finding is gate-visible with its line number.
      const parseErrors = result.findings.filter((finding) => finding.code === PARSE_ERROR_FINDING);
      expect(parseErrors).toHaveLength(1);
      expect(parseErrors[0]?.locations[0]).toMatchObject({ file: 'src/broken.py', line: 2 });
      // No silent resources: the malformed file's name is gone from the
      // graph (valid-but-unclassified beta/delta still appear — they are
      // honest discoveries, reported as unclassified blocking entries).
      const graphNames = result.graph.resources.map((resource) => resource.name);
      expect(graphNames).toContain('alpha');
      expect(graphNames).not.toContain('gamma');
      expect(result.policy.blocking.filter((entry) => entry.kind === 'unclassified')).toHaveLength(3);
      // The stub detector was honest — the rule had nothing to correct.
      expect(result.auditViolations).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});
