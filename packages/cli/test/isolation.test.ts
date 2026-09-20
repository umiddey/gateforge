/**
 * Managed runtime profile tests (plan 2026-09-19 Phase 10 item 8):
 * the isolation boundary contract is validated locally — an invalid
 * boundary record never authorizes a receipt, and the authority's
 * profile expectation decides acceptance (B53/B54 source-level).
 * Real container/host acceptance stays with the owner-hosted Phase 10
 * external run.
 */
import { describe, expect, it } from 'vitest';
import { executionBoundaryDigestOf } from '@gate-forge/core';
import {
  inspectManagedRuntime,
  isolationProfileForEnvironment,
  resolveIsolation,
  validateIsolationRecord,
  type IsolationRecord,
  type PodmanRunner,
} from '../src/isolation.js';

const APPROVED_IMAGE = `quay.io/gateforge/controller@sha256:${'a'.repeat(64)}`;
const CONTROLLER_ID = 'c'.repeat(64);

function inspectedController(
  image = APPROVED_IMAGE,
  mounts = [
    { Source: '/engine-bundle', Destination: '/engine', RW: false },
    { Source: '/candidate-tree', Destination: '/candidate', RW: false },
    { Source: '/run-state', Destination: '/app-state', RW: true },
  ],
): string {
  return JSON.stringify({
    Config: { Image: image, User: 'gateforge-runner' },
    HostConfig: { NetworkMode: 'private' },
    Mounts: mounts,
  });
}

function recordingRunner(
  inspect = inspectedController(),
): { calls: string[][]; runner: PodmanRunner } {
  const calls: string[][] = [];
  const runner: PodmanRunner = (args) => {
    calls.push([...args]);
    if (args[0] === 'run') return { status: 0, stdout: `${CONTROLLER_ID}\n`, stderr: '' };
    if (args[0] === 'inspect') return { status: 0, stdout: inspect, stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected stale discovery' };
  };
  return { calls, runner };
}

function managedRecord(overrides: Partial<IsolationRecord> = {}): IsolationRecord {
  return {
    profile: 'podman-rootless',
    mounts: [
      { source: '/var/gateforge/engine', target: '/engine', readOnly: true },
      { source: '/var/gateforge/candidate', target: '/candidate', readOnly: true },
      { source: '/var/gateforge/app-state', target: '/app-state', readOnly: false },
    ],
    user: 'gateforge-runner',
    network: 'private',
    containerSocketHidden: true,
    boundaryDigest: '',
    ...overrides,
  };
}

describe('isolation boundary validation (fail closed)', () => {
  it('accepts a fully-conforming managed record and binds its digest', () => {
    const validated = validateIsolationRecord(managedRecord());
    expect(validated.profile).toBe('podman-rootless');
    expect(validated.boundaryDigest).toBe(executionBoundaryDigestOf('podman-rootless'));
  });

  it('rejects root/absent and numeric-root users', () => {
    for (const user of ['root', null, '0', '0:0', 'root:root']) {
      expect(() => validateIsolationRecord(managedRecord({ user }))).toThrow(/non-root user/);
    }
  });

  it('rejects host networking', () => {
    expect(() => validateIsolationRecord(managedRecord({ network: 'host' }))).toThrow(/network/);
  });

  it('rejects a visible or mounted container socket', () => {
    expect(() => validateIsolationRecord(managedRecord({ containerSocketHidden: false }))).toThrow(/container socket/);
    expect(() =>
      validateIsolationRecord(
        managedRecord({
          mounts: [{ source: '/run/user/1000/podman/podman.sock', target: '/candidate', readOnly: true }],
        }),
      ),
    ).toThrow(/container socket/);
    expect(() =>
      validateIsolationRecord(
        managedRecord({
          mounts: [{ source: '/candidate', target: '/run/user/1000/podman/podman.sock', readOnly: true }],
        }),
      ),
    ).toThrow(/container socket/);
  });

  it('rejects host-home and host-Git mounts', () => {
    expect(() =>
      validateIsolationRecord(managedRecord({ mounts: [{ source: '/home/agent', target: '/candidate', readOnly: true }] })),
    ).toThrow(/host home mount/);
    expect(() =>
      validateIsolationRecord(
        managedRecord({ mounts: [{ source: '/srv/repo/.git', target: '/git', readOnly: true }] }),
      ),
    ).toThrow(/host Git directory mount/);
  });

  it('rejects writable engine/candidate mounts and read-only app state', () => {
    expect(() =>
      validateIsolationRecord(managedRecord({ mounts: [{ source: '/e', target: '/engine', readOnly: false }] })),
    ).toThrow(/read-only at \/engine/);
    const record = managedRecord();
    record.mounts = record.mounts.map((mount) =>
      mount.target === '/candidate' ? { ...mount, readOnly: false } : mount,
    );
    expect(() => validateIsolationRecord(record)).toThrow(/read-only at \/candidate/);
    const noWritable = managedRecord({ mounts: managedRecord().mounts.map((mount) => ({ ...mount, readOnly: true })) });
    expect(() => validateIsolationRecord(noWritable)).toThrow(/writable at \/app-state/);
  });

  it('a local-unisolated record carries no isolation and digests honestly', () => {
    const validated = validateIsolationRecord({
      profile: 'local-unisolated',
      mounts: [],
      user: null,
      network: null,
      containerSocketHidden: false,
      boundaryDigest: '',
    });
    expect(validated.boundaryDigest).toBe(executionBoundaryDigestOf('local-unisolated'));
  });

  it('inspectManagedRuntime reports local-unisolated without a managed host (honest default)', () => {
    const record = inspectManagedRuntime({}, () => ({ status: 1, stdout: '', stderr: 'podman unavailable' }));
    expect(record.profile).toBe('local-unisolated');
    expect(record.mounts).toEqual([]);
  });

  it('resolveIsolation refuses an unknown profile', () => {
    expect(() =>
      resolveIsolation(
        { profile: 'host-docker' as never, candidateDir: '/c', engineBundleDir: '/e', appStateDir: '/a' },
        {},
      ),
    ).toThrow(/unknown isolation profile/);
  });

  it('refuses a requested managed profile when Podman evidence is absent', () => {
    expect(() =>
      resolveIsolation(
        { profile: 'podman-rootless', candidateDir: '/candidate', engineBundleDir: '/engine', appStateDir: '/state' },
        { PATH: '/nonexistent' },
      ),
    ).toThrow(/managed isolation requested|no valid active Podman controller runtime/);
  });

  it('launches the owner-approved fixed profile and returns matching authoritative mounts', () => {
    const { calls, runner } = recordingRunner();
    const record = resolveIsolation(
      {
        profile: 'podman-rootless',
        candidateDir: '/candidate-tree',
        engineBundleDir: '/engine-bundle',
        appStateDir: '/run-state',
      },
      { GATEFORGE_MANAGED_CONTROLLER_IMAGE: APPROVED_IMAGE },
      runner,
    );
    expect(record.profile).toBe('podman-rootless');
    const launch = calls[0]!;
    expect(launch[0]).toBe('run');
    expect(launch).toContain('--read-only');
    expect(launch).toContain('--user');
    expect(launch).toContain('gateforge-runner');
    expect(launch).toContain('--network');
    expect(launch).toContain('none');
    expect(launch).toContain('--rm');
    expect(launch.filter((arg) => arg === '--volume')).toHaveLength(3);
    expect(launch).toContain('/engine-bundle:/engine:ro');
    expect(launch).toContain('/candidate-tree:/candidate:ro');
    expect(launch).toContain('/run-state:/app-state:rw');
    expect(launch).not.toContain('sh');
    expect(launch.at(-2)).toBe(APPROVED_IMAGE);
    expect(launch.at(-1)).toBe('controller');
    expect(calls[1]?.[0]).toBe('inspect');
    expect(calls[1]?.at(-1)).toBe(CONTROLLER_ID);
  });

  it('rejects a failed launch before inspecting a stale same-name controller', () => {
    const calls: string[][] = [];
    const staleRunner: PodmanRunner = (args) => {
      calls.push([...args]);
      if (args[0] === 'run') return { status: 125, stdout: '', stderr: 'name already in use' };
      throw new Error('stale controller must not be inspected');
    };
    expect(() =>
      resolveIsolation(
        { profile: 'podman-rootless', candidateDir: '/candidate-tree', engineBundleDir: '/engine-bundle', appStateDir: '/run-state' },
        { GATEFORGE_MANAGED_CONTROLLER_IMAGE: APPROVED_IMAGE },
        staleRunner,
      ),
    ).toThrow(/stale-controller inspection/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('run');
  });

  it('rejects empty, multiline, and non-hex launch IDs before inspection', () => {
    for (const stdout of ['', `${CONTROLLER_ID}\n${CONTROLLER_ID}\n`, 'not-a-container-id\n']) {
      const calls: string[][] = [];
      const malformedRunner: PodmanRunner = (args) => {
        calls.push([...args]);
        if (args[0] === 'run') return { status: 0, stdout, stderr: '' };
        throw new Error('malformed launch ID must not be inspected');
      };
      expect(() =>
        resolveIsolation(
          { profile: 'podman-rootless', candidateDir: '/candidate-tree', engineBundleDir: '/engine-bundle', appStateDir: '/run-state' },
          { GATEFORGE_MANAGED_CONTROLLER_IMAGE: APPROVED_IMAGE },
          malformedRunner,
        ),
      ).toThrow(/valid controller ID/);
      expect(calls).toHaveLength(1);
    }
  });

  it('rejects missing or floating owner controller images before invoking Podman', () => {
    const { calls, runner } = recordingRunner();
    expect(() =>
      resolveIsolation(
        { profile: 'podman-rootless', candidateDir: '/candidate-tree', engineBundleDir: '/engine-bundle', appStateDir: '/run-state' },
        {},
        runner,
      ),
    ).toThrow(/immutable sha256 image digest/);
    expect(() =>
      resolveIsolation(
        { profile: 'podman-rootless', candidateDir: '/candidate-tree', engineBundleDir: '/engine-bundle', appStateDir: '/run-state' },
        { GATEFORGE_MANAGED_CONTROLLER_IMAGE: 'quay.io/gateforge/controller:latest' },
        runner,
      ),
    ).toThrow(/immutable sha256 image digest/);
    expect(calls).toEqual([]);
  });

  it('rejects wrong inspected sources and extra managed targets', () => {
    const wrong = inspectedController(APPROVED_IMAGE, [
      { Source: '/engine-bundle', Destination: '/engine', RW: false },
      { Source: '/wrong-candidate', Destination: '/candidate', RW: false },
      { Source: '/run-state', Destination: '/app-state', RW: true },
    ]);
    const { runner } = recordingRunner(wrong);
    expect(() =>
      resolveIsolation(
        { profile: 'podman-rootless', candidateDir: '/candidate-tree', engineBundleDir: '/engine-bundle', appStateDir: '/run-state' },
        { GATEFORGE_MANAGED_CONTROLLER_IMAGE: APPROVED_IMAGE },
        runner,
      ),
    ).toThrow(/launch request/);
    const unrelated = recordingRunner(inspectedController(`quay.io/gateforge/other@sha256:${'b'.repeat(64)}`));
    expect(() =>
      resolveIsolation(
        { profile: 'podman-rootless', candidateDir: '/candidate-tree', engineBundleDir: '/engine-bundle', appStateDir: '/run-state' },
        { GATEFORGE_MANAGED_CONTROLLER_IMAGE: APPROVED_IMAGE },
        unrelated.runner,
      ),
    ).toThrow(/owner-approved immutable image/);
    expect(() =>
      validateIsolationRecord(
        managedRecord({
          mounts: [...managedRecord().mounts, { source: '/extra', target: '/extra', readOnly: true }],
        }),
      ),
    ).toThrow(/exactly|targets/);
  });

  it('keeps local-unisolated local and fails closed when Podman is absent', () => {
    const calls: string[][] = [];
    const absent: PodmanRunner = (args) => {
      calls.push([...args]);
      return { status: -1, stdout: '', stderr: 'podman unavailable' };
    };
    expect(
      resolveIsolation(
        { profile: 'local-unisolated', candidateDir: '/candidate-tree', engineBundleDir: '/engine-bundle', appStateDir: '/run-state' },
        { GATEFORGE_MANAGED_CONTROLLER_IMAGE: 'not-used' },
        absent,
      ).profile,
    ).toBe('local-unisolated');
    expect(calls).toEqual([]);
    expect(() =>
      resolveIsolation(
        { profile: 'podman-rootless', candidateDir: '/candidate-tree', engineBundleDir: '/engine-bundle', appStateDir: '/run-state' },
        { GATEFORGE_MANAGED_CONTROLLER_IMAGE: APPROVED_IMAGE },
        absent,
      ),
    ).toThrow(/managed isolation requested/);
  });

  it('derives managed intent only from the owner authority boundary', () => {
    expect(isolationProfileForEnvironment({})).toBe('local-unisolated');
    expect(isolationProfileForEnvironment({ GATEFORGE_AUTHORITY_BOUNDARY: 'managed-authoritative' })).toBe(
      'podman-rootless',
    );
    expect(() => isolationProfileForEnvironment({ GATEFORGE_AUTHORITY_BOUNDARY: 'podman-rootless' })).toThrow(
      /unknown authority boundary/,
    );
  });
});
