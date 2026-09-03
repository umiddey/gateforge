import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FIXED_GIT_DATE,
  TempRepo,
  fakeProvider,
  fingerprint,
  localStagedProvider,
  makeClock,
  normalizeChangedFiles,
  runGates,
  sha256Canonical,
  stubDetector,
  toIso,
  withEnv,
  withTempRepo,
  type ClassificationSignal,
  type EvidenceRecord,
  type ObligationEvaluator,
  type RunGatesInput,
} from '../src/index.js';

/** The fixed instant every gate-run test is decided at. */
const NOW = '2026-06-01T00:00:00.000Z';
/** A fixed future expiry for valid waivers (relative to NOW). */
const FUTURE = '2027-01-01T00:00:00.000Z';
/** A fixed past expiry for expired waivers. */
const PAST = '2025-01-01T00:00:00.000Z';

/** The accounts classification lifecycle (matches classifications()). */
const ACCOUNTS_LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'archive' as const,
  archiveFields: { status: 'archived' } as const,
};

/**
 * Writes and commits the standard classified fixture repo: one
 * user-facing resource (`accounts`) and one internal resource
 * (`audit_log`).
 *
 * Args:
 *   repo: repository to write into.
 *
 * Returns:
 *   string: the HEAD sha after the initial commit.
 */
function commitClassifiedRepo(repo: TempRepo): string {
  return repo.commitFiles({
    'models/accounts.py': 'accounts = table(name="accounts")\n',
    'models/audit_log.py': 'audit_log = table(name="audit_log")\n',
  }, 'fixture: classified resources');
}

/** Classifications for {@link commitClassifiedRepo}'s resources. */
function classifications() {
  return {
    schemaVersion: 1 as const,
    resources: {
      accounts: {
        exposure: 'user-facing' as const,
        plane: 'tenant' as const,
        lifecycle: ACCOUNTS_LIFECYCLE,
        primaryKey: ['id'],
        evidenceAdapter: 'accounts',
      },
      audit_log: {
        exposure: 'internal' as const,
        plane: 'master' as const,
        lifecycle: { create: false, read: false, update: false, delete: false },
        primaryKey: ['id'],
      },
    },
  };
}

/** Policies for the standard fixture: full CRUD + one extra contract. */
function policies() {
  return {
    schemaVersion: 1 as const,
    policies: [
      {
        id: 'crud-required',
        when: { kind: 'stub.declaration' },
        require: ['crud:create', 'crud:update', 'crud:delete'],
      },
      {
        id: 'backup-required',
        when: { exposure: 'user-facing' as const },
        require: ['backup:verify'],
      },
    ],
  };
}

/**
 * Pin-#9 evaluator double: classification gating, exact-fingerprint
 * waivers with expiry, witnessed → satisfied, claimed → invalid,
 * otherwise missing. Mirrors the verdict engine's decision order
 * closely enough for fixture assertions.
 *
 * Args:
 *   records: evidence records the double consults (per run).
 *
 * Returns:
 *   ObligationEvaluator: the double.
 */
function evaluatorDouble(): ObligationEvaluator {
  return (obligation, { records, waivers, classification, now }) => {
    if (classification === null) {
      return { verdict: 'unclassified', reason: 'no classification bound', recordIds: [] };
    }
    const fp = fingerprint({
      resourceId: obligation.resourceId,
      contract: obligation.contract,
      policyId: obligation.policyId,
      lifecycle: obligation.lifecycle,
    });
    const waiver = waivers.find(
      (candidate) =>
        candidate.scope.resourceId === obligation.resourceId &&
        candidate.scope.fingerprint === fp,
    );
    const nowMs = new Date(now).getTime();
    if (waiver !== undefined) {
      return nowMs >= new Date(waiver.expiresAt).getTime()
        ? { verdict: 'invalid', reason: 'waiver expired', recordIds: [] }
        : { verdict: 'waived', reason: null, recordIds: [] };
    }
    const obligationRecords = records.filter((record) => record.obligationId === obligation.id);
    const witnessed = obligationRecords.filter((record) => record.trust === 'witnessed');
    if (witnessed.length > 0) {
      return {
        verdict: 'satisfied',
        reason: null,
        recordIds: witnessed.map((record) => record.recordId),
      };
    }
    if (obligationRecords.length > 0) {
      return { verdict: 'invalid', reason: 'claimed records cannot satisfy', recordIds: [] };
    }
    return { verdict: 'missing', reason: 'no evidence records', recordIds: [] };
  };
}

/** Builds a witnessed evidence record for one obligation. */
function witnessedRecord(obligationId: string): EvidenceRecord {
  return {
    schemaVersion: 1,
    recordId: sha256Canonical({ obligationId, kind: 'witness' }),
    runId: randomUUID(),
    trust: 'witnessed',
    obligationId,
    kind: 'persistence.entity',
  };
}

/** Builds the automatic classification policy and signal set for fixtures. */
function automaticClassification(repo: TempRepo, detection: ReturnType<typeof stubDetector>) {
  const signals = detection.output.resources.flatMap((resource) => {
    const internal = resource.attributes.resourceName === 'audit_log';
    const location = resource.location;
    const detector = { id: detection.output.detectorId, version: detection.output.detectorVersion };
    const signal = (
      dimension: ClassificationSignal['dimension'],
      assertion: ClassificationSignal['assertion'],
      basis: ClassificationSignal['basis'] = 'declaration',
    ): ClassificationSignal => ({
      schemaVersion: 1,
      target: { resourceName: resource.attributes.resourceName as string },
      dimension,
      assertion,
      basis,
      source: basis === 'declaration' || basis === 'code-negative-closed-world'
        ? 'gateforge:internal'
        : detection.output.detectorId,
      location: resource.location,
      detector: basis === 'declaration' || basis === 'code-negative-closed-world'
        ? { id: 'gateforge.core', version: '1' }
        : detector,
    });
    return [
      signal('plane', internal ? 'master' : 'tenant'),
      signal('identity', ['id']),
      signal('lifecycle.create', !internal),
      signal('lifecycle.read', !internal),
      signal('lifecycle.update', !internal),
      signal('lifecycle.delete', !internal, 'code-negative-closed-world'),
      ...(internal
        ? [
            signal('internality', true, 'organization-policy'),
            signal('internality', { category: 'worker' }, 'code-positive'),
          ]
        : [
            signal('delete-semantics', 'archive'),
            signal('archive-state', { status: 'archived' }),
            signal('adapter-binding', 'accounts'),
          ]),
    ];
  });
  return {
    ...detection.output,
    classificationSignals: signals,
    // Coverage report (red-team round 3): the stub detector examines every
    // fixture model file, satisfying the policy's coverage rule.
    scannedPaths: detection.output.resources.map((resource) => resource.source),
  };
}

function classificationPolicy() {
  return {
    schemaVersion: 1 as const,
    scanRoots: ['models/**/*.py'],
    trustedInternalEntryPoints: [{ category: 'worker', detector: 'gateforge.stub-detector' }],
    internalRules: [{ match: { resourceName: 'audit_log' }, reason: 'system audit ledger' }],
    coverage: [{ capability: 'exposure.http', exhaustive: true, detector: 'gateforge.stub-detector', appliesTo: ['models/**'] }],
    declarations: { internality: 'gateforge:internal' },
    volatileFields: [],
  };
}

/** Base gate-run input over a committed automatically classified repo. */
function gateInput(repo: TempRepo, overrides: Partial<RunGatesInput> = {}): RunGatesInput {
  const detection = stubDetector(repo, { suffixes: ['.py'] });
  return {
    repo,
    detectors: [{ ...automaticClassification(repo, detection), audit: detection.audit }],
    classificationPolicy: classificationPolicy(),
    adapters: ['accounts'],
    policies: policies(),
    evaluate: evaluatorDouble(),
    clock: makeClock({ fixedAt: NOW }),
    ...overrides,
  };
}

describe('temp-repo builder', () => {
  it('commits with fixed dates; identical specs yield identical SHAs', () => {
    const spec = { 'src/one.py': 'one = 1\n', 'src/two.py': 'two = 2\n' };
    const first = new TempRepo({ files: spec });
    const second = new TempRepo({ files: spec });
    const third = new TempRepo({ files: { 'src/one.py': 'one = 2\n', 'src/two.py': 'two = 2\n' } });
    try {
      first.stage();
      const firstSha = first.commit('c1');
      second.stage();
      const secondSha = second.commit('c1');
      third.stage();
      const thirdSha = third.commit('c1');
      expect(firstSha).toMatch(/^[0-9a-f]{40}$/);
      expect(firstSha).toBe(secondSha);
      expect(thirdSha).not.toBe(firstSha);
      expect(first.git(['log', '-1', '--format=%ct']).stdout.trim()).toBe(
        String(Date.parse(FIXED_GIT_DATE) / 1000),
      );
    } finally {
      first.cleanup();
      second.cleanup();
      third.cleanup();
    }
  });

  it('writeFiles writes nested trees and rejects escaping keys', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({ 'a/b/c.txt': 'hi', 'top.py': 'top = 1\n' });
      expect(readFileSync(repo.path('a/b/c.txt'), 'utf8')).toBe('hi');
      expect(() => repo.writeFiles({ '../evil.txt': 'x' })).toThrow(/escapes the repo root/);
      expect(() => repo.writeFiles({ '/abs.txt': 'x' })).toThrow(/escapes the repo root/);
    });
  });

  it('stage/commit/stagedFiles reflect the real index', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({ 'src/x.py': 'x = 1\n' });
      expect(repo.stagedFiles()).toEqual([]);
      repo.stage();
      expect(repo.stagedFiles()).toEqual(['src/x.py']);
      repo.commit('stage x');
      expect(repo.stagedFiles()).toEqual([]);
    });
  });

  it('withTempRepo cleans up on success, sync throw, and async rejection', async () => {
    let seenPath = '';
    const value = withTempRepo({}, (repo) => {
      seenPath = repo.root;
      return 42;
    });
    expect(value).toBe(42);
    expect(existsSync(seenPath)).toBe(false);

    expect(() =>
      withTempRepo({}, (repo) => {
        seenPath = repo.root;
        throw new Error('sync boom');
      }),
    ).toThrow('sync boom');
    expect(existsSync(seenPath)).toBe(false);

    await expect(
      withTempRepo({}, async (repo) => {
        seenPath = repo.root;
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');
    expect(existsSync(seenPath)).toBe(false);
  });

  it('cleanup is idempotent', () => {
    const repo = new TempRepo({});
    repo.cleanup();
    repo.cleanup();
    expect(existsSync(repo.root)).toBe(false);
  });
});

describe('injected clock', () => {
  it('fixedAt returns the same canonical instant forever', () => {
    const clock = makeClock({ fixedAt: NOW });
    expect(clock.now()).toBe(NOW);
    expect(clock.now()).toBe(NOW);
    expect(makeClock({ fixedAt: new Date('2026-06-01T00:00:00Z') }).now()).toBe(NOW);
  });

  it('sequence yields instants in order, then fails loud', () => {
    const clock = makeClock({ sequence: [PAST, NOW, FUTURE] });
    expect(clock.now()).toBe(PAST);
    expect(clock.now()).toBe(NOW);
    expect(clock.now()).toBe(FUTURE);
    expect(() => clock.now()).toThrow(RangeError);
  });

  it('rejects an empty sequence and unparseable instants', () => {
    expect(() => makeClock({ sequence: [] })).toThrow(TypeError);
    expect(() => makeClock({ fixedAt: 'not-a-date' })).toThrow(TypeError);
    expect(() => toIso('still-not-a-date')).toThrow(TypeError);
  });

  it('stepping clock advances by stepMs', () => {
    const clock = makeClock({ startAt: NOW, stepMs: 500 });
    expect(clock.now()).toBe(NOW);
    expect(clock.now()).toBe('2026-06-01T00:00:00.500Z');
    expect(clock.now()).toBe('2026-06-01T00:00:01.000Z');
  });
});

describe('injected env', () => {
  const NEW_VAR = 'GATEFORGE_HARNESS_NEW';
  const EXISTING_VAR = 'GATEFORGE_HARNESS_EXISTING';

  it('sets new vars and restores pre-existing vars', () => {
    process.env[EXISTING_VAR] = 'orig';
    try {
      const inside = withEnv({ [NEW_VAR]: 'v', [EXISTING_VAR]: 'patched' }, () => ({
        newVar: process.env[NEW_VAR],
        existing: process.env[EXISTING_VAR],
      }));
      expect(inside).toEqual({ newVar: 'v', existing: 'patched' });
      expect(process.env[NEW_VAR]).toBeUndefined();
      expect(process.env[EXISTING_VAR]).toBe('orig');
    } finally {
      delete process.env[EXISTING_VAR];
    }
  });

  it('undefined value deletes the variable for the body, then restores', () => {
    process.env[EXISTING_VAR] = 'orig';
    try {
      const inside = withEnv({ [EXISTING_VAR]: undefined }, () => process.env[EXISTING_VAR]);
      expect(inside).toBeUndefined();
      expect(process.env[EXISTING_VAR]).toBe('orig');
    } finally {
      delete process.env[EXISTING_VAR];
    }
  });

  it('restores the environment when the body throws', () => {
    expect(() => withEnv({ [NEW_VAR]: 'v' }, () => {
      throw new Error('env boom');
    })).toThrow('env boom');
    expect(process.env[NEW_VAR]).toBeUndefined();
  });

  it('supports async bodies and restores after settlement', async () => {
    await withEnv({ [NEW_VAR]: 'async' }, async () => {
      expect(process.env[NEW_VAR]).toBe('async');
      await Promise.resolve();
      expect(process.env[NEW_VAR]).toBe('async');
    });
    expect(process.env[NEW_VAR]).toBeUndefined();

    await expect(
      withEnv({ [NEW_VAR]: 'async' }, async () => {
        throw new Error('async env boom');
      }),
    ).rejects.toThrow('async env boom');
    expect(process.env[NEW_VAR]).toBeUndefined();
  });
});

describe('changed-file provider stubs', () => {
  it('normalizeChangedFiles dedupes, posix-normalizes, and codepoint-sorts', () => {
    expect(normalizeChangedFiles(['b.ts', 'a\\c.ts', 'a.ts', 'b.ts'])).toEqual([
      'a.ts',
      'a/c.ts',
      'b.ts',
    ]);
  });

  it('fakeProvider snapshots its list at construction', () => {
    const input = ['z.ts', 'a.ts'];
    const provider = fakeProvider('github-pr', input);
    input.push('late.ts');
    expect(provider.changedFiles()).toEqual(['a.ts', 'z.ts']);
    expect(provider.provider).toBe('github-pr');
  });

  it('localStagedProvider reads the real index as it evolves', () => {
    withTempRepo({}, (repo) => {
      const provider = localStagedProvider(repo);
      expect(provider.provider).toBe('local-staged');
      repo.writeFiles({ 'src/changed.py': 'changed = 1\n' });
      expect(provider.changedFiles()).toEqual([]);
      repo.stage();
      expect(provider.changedFiles()).toEqual(['src/changed.py']);
      repo.commit('change');
      expect(provider.changedFiles()).toEqual([]);
    });
  });

  it('GF-09-style parity: identical changes give identical sets across provider identities', () => {
    withTempRepo({}, (localRepo) => {
      withTempRepo({}, (ciRepo) => {
        const change = { 'models/accounts.py': 'accounts = table(name="accounts_v2")\n' };
        commitClassifiedRepo(localRepo);
        commitClassifiedRepo(ciRepo);
        localRepo.writeFiles(change);
        ciRepo.writeFiles(change);
        localRepo.stage();
        ciRepo.stage();

        const local = localStagedProvider(localRepo);
        const github = fakeProvider('github-pr', ['models/accounts.py']);
        const gitlab = fakeProvider('gitlab-mr', ['models/accounts.py']);
        expect(local.changedFiles()).toEqual(github.changedFiles());
        expect(gitlab.changedFiles()).toEqual(github.changedFiles());

        const localRun = runGates(gateInput(localRepo, { changedProvider: local }));
        const ciRun = runGates(gateInput(ciRepo, { changedProvider: github }));
        expect(localRun.verdicts).toEqual(ciRun.verdicts);
        expect(localRun.changedFiles).toEqual(ciRun.changedFiles);
      });
    });
  });
});

describe('gate runner', () => {
  it('runs discover → obligations → evaluate end to end', () => {
    withTempRepo({}, (repo) => {
      commitClassifiedRepo(repo);
      const record = witnessedRecord('tenant.accounts:crud:create');
      const result = runGates(gateInput(repo, {
        records: [record],
        claims: [
          { schemaVersion: 1, obligationId: 'tenant.accounts:crud:create', testId: 'happy-path' },
          { schemaVersion: 1, obligationId: 'tenant.accounts:nope:nope', testId: 'ghost' },
        ],
      }));

      expect(result.policy.obligations.map((obligation) => obligation.id)).toEqual([
        'tenant.accounts:backup:verify',
        'tenant.accounts:crud:create',
        'tenant.accounts:crud:delete',
        'tenant.accounts:crud:update',
      ]);
      // Internal audit_log generates no CRUD obligations (ADR 0001).
      expect(result.policy.obligations.filter((o) => o.resourceId === 'master.audit_log')).toEqual([]);

      const verdictByid = new Map(result.verdicts.map((verdict) => [verdict.obligationId, verdict]));
      expect(verdictByid.get('tenant.accounts:crud:create')).toMatchObject({
        verdict: 'satisfied',
        reason: null,
        recordIds: [record.recordId],
      });
      expect(verdictByid.get('tenant.accounts:crud:update')).toMatchObject({
        verdict: 'missing',
        reason: 'no evidence records',
        recordIds: [],
      });
      // Every verdict carries its pin-#2 fingerprint identity.
      const update = verdictByid.get('tenant.accounts:crud:update');
      expect(update?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

      expect(result.policy.claims).toEqual([
        expect.objectContaining({ status: 'valid', reason: null }),
        expect.objectContaining({ status: 'invalid' }),
      ]);

      expect(result.manifest).toMatchObject({
        schemaVersion: 1,
        startedAt: NOW,
        gitSha: repo.headSha(),
        provider: 'all-files',
        plugins: [{ id: 'gateforge.stub-detector', version: '0.0.0', transport: 'in-process' }],
      });
      expect(result.manifest.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.findings).toEqual([]);
      expect(result.auditViolations).toEqual([]);
      expect(result.policy.blocking).toEqual([]);
      // missing verdicts ⇒ not clean
      expect(result.clean).toBe(false);
    });
  });

  it('waivers: exact fingerprint + future expiry → waived; past expiry → invalid', () => {
    withTempRepo({}, (repo) => {
      commitClassifiedRepo(repo);
      const first = runGates(gateInput(repo));
      const update = first.policy.obligations.find(
        (obligation) => obligation.id === 'tenant.accounts:crud:update',
      );
      if (update === undefined) throw new Error('crud:update obligation was not generated');
      const updateFingerprint = fingerprint({
        resourceId: update.resourceId,
        contract: update.contract,
        policyId: update.policyId,
        lifecycle: update.lifecycle,
      });
      const waiver = {
        schemaVersion: 1 as const,
        owner: 'team-accounts',
        justificationUrl: 'https://example.invalid/waiver/1',
        approver: 'approver-1',
        scope: { kind: 'exact' as const, resourceId: 'tenant.accounts', fingerprint: updateFingerprint },
        expiresAt: FUTURE,
      };

      const waived = runGates(gateInput(repo, { waivers: [waiver] }));
      expect(waived.verdicts.find((v) => v.obligationId === 'tenant.accounts:crud:update'))
        .toMatchObject({ verdict: 'waived', reason: null });

      const expired = runGates(gateInput(repo, { waivers: [{ ...waiver, expiresAt: PAST }] }));
      expect(expired.verdicts.find((v) => v.obligationId === 'tenant.accounts:crud:update'))
        .toMatchObject({ verdict: 'invalid', reason: 'waiver expired' });
    });
  });

  it('unclassified resources surface as blocking entries and dirty the run', () => {
    withTempRepo({}, (repo) => {
      repo.commitFiles({
        'models/accounts.py': 'accounts = table(name="accounts")\n',
        'models/orphan.py': 'orphan = table(name="orphan")\n',
      }, 'fixture: orphan');
      const result = runGates(gateInput(repo));
      expect(result.graph.resources.some((resource) => resource.name === 'orphan')).toBe(true);
      expect(result.policy.obligations.some((obligation) => obligation.resourceId === 'tenant.orphan')).toBe(true);
      expect(result.clean).toBe(false);
    });
  });

  it('is deterministic: identical inputs give identical verdicts and graph', () => {
    withTempRepo({}, (repo) => {
      commitClassifiedRepo(repo);
      const first = runGates(gateInput(repo, { records: [witnessedRecord('tenant.accounts:crud:create')] }));
      const second = runGates(gateInput(repo, { records: [witnessedRecord('tenant.accounts:crud:create')] }));
      expect(first.verdicts).toEqual(second.verdicts);
      expect(first.graph).toEqual(second.graph);
      expect(first.manifest.gitSha).toBe(second.manifest.gitSha);
    });
  });

  it('requires at least one detector contribution', () => {
    withTempRepo({}, (repo) => {
      commitClassifiedRepo(repo);
      expect(() => runGates({ ...gateInput(repo), detectors: [] })).toThrow(TypeError);
    });
  });
});
