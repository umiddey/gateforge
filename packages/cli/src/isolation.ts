/**
 * Isolation controller interface (plan 2026-09-19 Phase 10 item 2): the
 * narrow boundary between supervised execution and the managed runtime.
 *
 * TRUST MODEL (§4.10): the controller launches the APPROVED profile with
 * FIXED arguments — it never accepts a caller-supplied shell string, a
 * candidate-selected image, or ambient container env. It validates the
 * ACTIVE runtime (mounts read-only, dedicated users, no host paths, no
 * container socket) and returns an authoritative boundary record that
 * receipts seal via `executionBoundaryDigestOf`.
 *
 * This module defines the complete controller boundary contract. Launching
 * real containers requires the owner-provisioned managed host (rootless
 * Podman + service accounts); inspection alone reports an honest
 * `local-unisolated` record, while a managed request fails closed if the
 * approved controller cannot be launched and inspected (see `broker.ts`).
 */
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { executionBoundaryDigestOf } from '@gate-forge/core';
import { UsageError } from './errors.js';

/** The runtime profiles this controller understands. */
export type IsolationProfile = 'local-unisolated' | 'podman-rootless';

/** One validated mount of the active runtime. */
export interface IsolationMount {
  /** Host path (as mounted). */
  source: string;
  /** Container path. */
  target: string;
  /** True only for explicitly read-only mounts. */
  readOnly: boolean;
}

/** Authoritative record of the active execution boundary. */
export interface IsolationRecord {
  /** The profile that actually ran. */
  profile: IsolationProfile;
  /** Active mounts (exactly engine, candidate, and app state for managed runs). */
  mounts: IsolationMount[];
  /** Runtime user inside the container (never root for rootless profiles). */
  user: string | null;
  /** Network mode (`none`/`private` for managed profiles). */
  network: string | null;
  /** True when the candidate had no path to the container socket. */
  containerSocketHidden: boolean;
  /** Profile-class digest sealed into receipts for this execution boundary. */
  boundaryDigest: string;
}

/** Request for one supervised launch. */
export interface IsolationLaunchRequest {
  profile: IsolationProfile;
  /** Absolute path of the frozen candidate checkout (mounted read-only). */
  candidateDir: string;
  /** Absolute path of the approved engine/policy bundle (mounted read-only). */
  engineBundleDir: string;
  /** Absolute path of the disposable app-state directory (writable). */
  appStateDir: string;
}

/** Narrow Podman seam used to keep the fixed launch and inspect contract testable. */
export type PodmanRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => { status: number; stdout: string; stderr: string };

type ExpectedManagedBoundary = Pick<IsolationLaunchRequest, 'candidateDir' | 'engineBundleDir' | 'appStateDir'> & {
  image?: string;
};

/**
 * Detects any known container-management socket in a mount source or target.
 * This single predicate is shared by record validation and Podman inspection.
 */
function socketExposure(mount: IsolationMount): boolean {
  return mount.source.includes('docker.sock') ||
    mount.source.includes('podman.sock') ||
    mount.target.includes('docker.sock') ||
    mount.target.includes('podman.sock');
}

/**
 * Validates one active-runtime record against the profile's hard rules and,
 * when supplied, binds each managed mount source to the launch request.
 *
 * Args:
 *   record: the record returned by the runtime launcher.
 *   expected: request paths and optional owner image expected by inspection.
 *
 * Returns:
 *   IsolationRecord: the validated record with a recomputed boundary digest.
 *
 * Throws:
 *   UsageError: on any violated rule (fail closed — an invalid boundary
 *   record never authorizes a receipt).
 */
export function validateIsolationRecord(
  record: IsolationRecord,
  expected?: ExpectedManagedBoundary,
): IsolationRecord {
  const fail = (detail: string): never => {
    throw new UsageError(`isolation boundary invalid: ${detail}`);
  };
  if (record.profile === 'local-unisolated') {
    if (record.mounts.length !== 0 || record.user !== null || record.network !== null) {
      fail('local-unisolated records carry no mounts/user/network');
    }
    return { ...record, boundaryDigest: executionBoundaryDigestOf(record.profile) };
  }
  if (record.profile !== 'podman-rootless') fail(`unknown profile '${String(record.profile)}'`);
  const userIdentity = typeof record.user === 'string' ? record.user.split(':', 1)[0] : '';
  if (
    record.user === null ||
    record.user === '' ||
    userIdentity === '0' ||
    userIdentity === 'root'
  ) {
    fail('podman-rootless must run as a dedicated non-root user');
  }
  if (record.network !== 'none' && record.network !== 'private') {
    fail(`podman-rootless network must be 'none' or 'private' (got '${String(record.network)}')`);
  }
  if (!record.containerSocketHidden) {
    fail('podman-rootless must hide the container socket from the candidate');
  }
  const targets = new Set<string>();
  for (const mount of record.mounts) {
    if (targets.has(mount.target)) fail(`duplicate managed mount target: ${mount.target}`);
    targets.add(mount.target);
    if (mount.source !== resolvePath(mount.source) || !isAbsolute(mount.source) || mount.source.includes('\0')) {
      fail(`managed mount source must be a canonical absolute path: ${mount.source}`);
    }
    if (mount.source.includes(':') || mount.source.includes(',')) {
      fail(`managed mount source contains Podman volume syntax: ${mount.source}`);
    }
    if (mount.source.startsWith('/home/')) fail(`host home mount is forbidden: ${mount.source}`);
    if (mount.source.includes('/.git')) fail(`host Git directory mount is forbidden: ${mount.source}`);
    if (socketExposure(mount)) {
      fail(`container socket mount is forbidden: ${mount.source} -> ${mount.target}`);
    }
  }
  const engine = record.mounts.find((mount) => mount.target === '/engine');
  const candidate = record.mounts.find((mount) => mount.target === '/candidate');
  const appState = record.mounts.find((mount) => mount.target === '/app-state');
  if (engine === undefined || !engine.readOnly) fail('the engine bundle must be mounted read-only at /engine');
  if (candidate === undefined || !candidate.readOnly) fail('the candidate must be mounted read-only at /candidate');
  if (appState === undefined || appState.readOnly) fail('the app state dir must be writable at /app-state');
  if (record.mounts.length !== 3) {
    fail('podman-rootless must have exactly the engine, candidate, and app-state mounts');
  }
  const expectedTargets: Record<string, true> = { '/engine': true, '/candidate': true, '/app-state': true };
  if (targets.size !== Object.keys(expectedTargets).length || Object.keys(expectedTargets).some((target) => !targets.has(target))) {
    fail('managed mounts must target exactly /engine, /candidate, and /app-state');
  }
  if (expected !== undefined) {
    const expectedSources = {
      '/engine': canonicalRequestPath(expected.engineBundleDir, fail),
      '/candidate': canonicalRequestPath(expected.candidateDir, fail),
      '/app-state': canonicalRequestPath(expected.appStateDir, fail),
    };
    for (const mount of record.mounts) {
      if (mount.source !== expectedSources[mount.target as keyof typeof expectedSources]) {
        fail(`managed mount source for ${mount.target} does not match the launch request`);
      }
    }
  }
  return { ...record, boundaryDigest: executionBoundaryDigestOf(record.profile) };
}

function canonicalRequestPath(value: string, fail: (detail: string) => never): string {
  if (!isAbsolute(value) || value.includes('\0') || value.includes(':') || value.includes(',')) {
    fail(`launch path must be a canonical absolute path: ${value}`);
  }
  const canonical = resolvePath(value);
  if (canonical !== value) fail(`launch path must not use a path alias: ${value}`);
  return canonical;
}

/**
 * Runs one fixed-argument Podman command without a shell or caller command.
 * Production uses this only through the managed launch/inspection paths.
 */
export function runPodman(args: readonly string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('podman', [...args], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error !== undefined) {
    return { status: -1, stdout: '', stderr: `podman unavailable: ${(result.error as Error).message}` };
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const MANAGED_IMAGE_ENV = 'GATEFORGE_MANAGED_CONTROLLER_IMAGE';
const MANAGED_CONTAINER_NAME = 'gateforge-managed-controller';
const IMMUTABLE_IMAGE = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?@sha256:[0-9a-f]{64}$/i;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/i;

/**
 * Inspects the active managed controller after a fixed profile launch.
 * Podman inspect is authoritative for mounts, image, user, network, and
 * socket visibility; a role label alone never fabricates those facts.
 *
 * Args:
 *   env: owner-controlled orchestrator environment.
 *   runner: narrow Podman seam used by production and focused tests.
 *   expected: launch paths and immutable image that must match inspection.
 *   launchedControllerId: exact successful launch ID; skips stale name discovery.
 *
 * Returns:
 *   IsolationRecord: the validated managed boundary, or an honest local
 *   boundary when no controller is present.
 *
 * Throws:
 *   UsageError: when Podman reports malformed, unrelated, or invalid managed
 *   runtime evidence.
 */
export function inspectManagedRuntime(
  env: NodeJS.ProcessEnv,
  runner: PodmanRunner = runPodman,
  expected?: ExpectedManagedBoundary,
  launchedControllerId?: string,
): IsolationRecord {
  const controllerId = launchedControllerId ?? (() => {
    const probe = runner(
      ['ps', '--filter', `name=^${MANAGED_CONTAINER_NAME}$`, '--format', '{{.ID}}\t{{.Label "gateforge.role"}}'],
      env,
    );
    return probe.status === 0
      ? probe.stdout
          .split('\n')
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            const label = parts.slice(1).join(' ');
            return parts.length > 1 &&
              (label === 'controller' ||
                label.includes('gateforge.role=controller') ||
                label.includes('gateforge.role:controller'))
              ? parts[0]
              : null;
          })
          .find((id): id is string => id !== null)
      : undefined;
  })();
  if (controllerId === undefined) {
    return validateIsolationRecord({
      profile: 'local-unisolated',
      mounts: [],
      user: null,
      network: null,
      containerSocketHidden: false,
      boundaryDigest: '',
    });
  }

  const inspected = runner(['inspect', '--format', '{{json .}}', controllerId], env);
  if (inspected.status !== 0 || inspected.stdout.trim() === '') {
    throw new UsageError(
      'isolation boundary unavailable: Podman identified a managed controller but could not inspect its runtime record',
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(inspected.stdout);
  } catch {
    throw new UsageError('isolation boundary unavailable: Podman returned malformed controller inspect JSON');
  }
  if (Array.isArray(document)) document = document[0];
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new UsageError('isolation boundary unavailable: controller inspect JSON is not an object');
  }
  const raw = document as Record<string, unknown>;
  const config = raw['Config'];
  const hostConfig = raw['HostConfig'];
  const mountsRaw = raw['Mounts'];
  if (
    typeof config !== 'object' ||
    config === null ||
    Array.isArray(config) ||
    typeof hostConfig !== 'object' ||
    hostConfig === null ||
    Array.isArray(hostConfig) ||
    !Array.isArray(mountsRaw)
  ) {
    throw new UsageError('isolation boundary unavailable: controller inspect record lacks Config, HostConfig, or Mounts');
  }
  const configRecord = config as Record<string, unknown>;
  const user = configRecord['User'];
  const image = configRecord['Image'];
  const network = (hostConfig as Record<string, unknown>)['NetworkMode'];
  if (typeof user !== 'string' || typeof network !== 'string') {
    throw new UsageError('isolation boundary unavailable: controller inspect record lacks user or network mode');
  }
  if (expected?.image !== undefined && image !== expected.image) {
    throw new UsageError('isolation boundary invalid: active controller image is not the owner-approved immutable image');
  }
  const mounts: IsolationMount[] = [];
  for (const mount of mountsRaw) {
    if (typeof mount !== 'object' || mount === null || Array.isArray(mount)) {
      throw new UsageError('isolation boundary unavailable: controller inspect contains a malformed mount');
    }
    const entry = mount as Record<string, unknown>;
    const source = entry['Source'];
    const target = entry['Destination'];
    const readWrite = entry['RW'];
    if (typeof source !== 'string' || typeof target !== 'string' || typeof readWrite !== 'boolean') {
      throw new UsageError('isolation boundary unavailable: controller inspect contains an incomplete mount');
    }
    mounts.push({ source, target, readOnly: !readWrite });
  }
  const socketMount = mounts.some(socketExposure);
  return validateIsolationRecord({
    profile: 'podman-rootless',
    mounts,
    user,
    network,
    containerSocketHidden: !socketMount,
    boundaryDigest: '',
  }, expected);
}

/**
 * Resolves the intended execution profile from the owner-controlled
 * authority boundary. Candidate configuration is deliberately not read.
 */
export function isolationProfileForEnvironment(env: NodeJS.ProcessEnv): IsolationProfile {
  const boundary = env['GATEFORGE_AUTHORITY_BOUNDARY'];
  if (boundary === undefined || boundary === '' || boundary === 'local-unisolated') {
    return 'local-unisolated';
  }
  if (boundary === 'managed-authoritative') return 'podman-rootless';
  throw new UsageError(`unknown authority boundary '${boundary}'`);
}

/**
 * Resolves a supervised launch against the owner-requested profile. Local
 * mode returns its honest empty boundary without invoking Podman. Managed
 * mode validates owner image and request paths, launches only the fixed
 * profile, then accepts only matching authoritative inspect evidence.
 */
export function resolveIsolation(
  request: IsolationLaunchRequest,
  env: NodeJS.ProcessEnv,
  runner: PodmanRunner = runPodman,
): IsolationRecord {
  if (request.profile !== 'podman-rootless' && request.profile !== 'local-unisolated') {
    throw new UsageError(`unknown isolation profile '${String(request.profile)}'`);
  }
  if (request.profile === 'local-unisolated') {
    return validateIsolationRecord({
      profile: 'local-unisolated',
      mounts: [],
      user: null,
      network: null,
      containerSocketHidden: false,
      boundaryDigest: '',
    });
  }
  const image = validatedManagedImage(env);
  const expected: ExpectedManagedBoundary = {
    candidateDir: canonicalRequestPath(request.candidateDir, (detail) => {
      throw new UsageError(`isolation launch invalid: ${detail}`);
    }),
    engineBundleDir: canonicalRequestPath(request.engineBundleDir, (detail) => {
      throw new UsageError(`isolation launch invalid: ${detail}`);
    }),
    appStateDir: canonicalRequestPath(request.appStateDir, (detail) => {
      throw new UsageError(`isolation launch invalid: ${detail}`);
    }),
    image,
  };
  // The controller currently owns only the health heartbeat and needs no
  // network. Podman's rootless `private` token resolves to `pasta`, which is
  // not an isolated network mode; `none` is the authoritative fail-closed
  // choice until a separately provisioned internal app/worker network exists.
  const launch = runner([
    'run',
    '--rm',
    '--detach',
    '--name',
    MANAGED_CONTAINER_NAME,
    '--label',
    'gateforge.role=controller',
    '--read-only',
    '--user',
    'gateforge-runner',
    '--network',
    'none',
    '--volume',
    `${expected.engineBundleDir}:/engine:ro`,
    '--volume',
    `${expected.candidateDir}:/candidate:ro`,
    '--volume',
    `${expected.appStateDir}:/app-state:rw`,
    image,
    'controller',
  ], env);
  if (launch.status !== 0) {
    const detail = launch.stderr.trim() || `Podman exited with status ${String(launch.status)}`;
    throw new UsageError(
      `managed isolation requested but the approved controller launch failed: ${detail} (fail closed; refusing stale-controller inspection)`,
    );
  }
  const launchedControllerId = launch.stdout.trim();
  if (!CONTAINER_ID.test(launchedControllerId)) {
    throw new UsageError(
      'managed isolation requested but Podman returned no single valid controller ID (fail closed)',
    );
  }
  const active = inspectManagedRuntime(env, runner, expected, launchedControllerId);
  if (active.profile === 'podman-rootless') return active;
  const detail = 'the newly launched controller was not inspectable as a valid managed runtime';
  throw new UsageError(
    `managed isolation requested but ${detail} (fail closed; refusing local downgrade)`,
  );

}
function validatedManagedImage(env: NodeJS.ProcessEnv): string {
  const image = env[MANAGED_IMAGE_ENV];
  if (typeof image !== 'string' || !IMMUTABLE_IMAGE.test(image)) {
    throw new UsageError(
      `managed isolation requested but ${MANAGED_IMAGE_ENV} must be an owner-provisioned immutable sha256 image digest`,
    );
  }
  return image;
}
