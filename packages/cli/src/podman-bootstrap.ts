/**
 * Gateforge-managed Podman bootstrap for the existing `init --managed` path.
 *
 * This module deliberately owns only host-runtime setup: it detects Podman,
 * invokes a native package manager with fixed arguments when needed, and
 * verifies that the current user can run Podman rootlessly. It never invokes a
 * shell, reads candidate configuration, or installs from npm lifecycle hooks.
 */
import { spawnSync } from 'node:child_process';
import { UsageError } from './errors.js';

/** Result returned by one host command invocation. */
export interface HostCommandResult {
  /** Process exit status, or null when the process could not report one. */
  status: number | null;
  /** Captured stdout when the command was run without inherited stdio. */
  stdout: string;
  /** Captured stderr when the command was run without inherited stdio. */
  stderr: string;
}

/** Options for the injected host command runner. */
export interface HostCommandOptions {
  /** Pass the terminal directly to an installer so the owner can approve sudo. */
  inheritStdio?: boolean;
  /** Environment used for the host command. */
  env?: NodeJS.ProcessEnv;
}

/** Narrow command seam used by bootstrap tests and the real host runner. */
export type HostCommandRunner = (
  command: string,
  args: readonly string[],
  options?: HostCommandOptions,
) => HostCommandResult;

/** Inputs that control bootstrap without reading candidate-owned settings. */
export interface PodmanBootstrapOptions {
  /** Injected command runner; production defaults to spawnSync. */
  runner?: HostCommandRunner;
  /** Owner process environment. */
  env?: NodeJS.ProcessEnv;
  /** Platform override used by deterministic tests. */
  platform?: NodeJS.Platform;
  /** UID override used by deterministic tests. */
  uid?: number | null;
  /** Owner confirmation for a package-manager full-system upgrade fallback. */
  confirmSystemUpgrade?: (message: string) => boolean | Promise<boolean>;
}

/** Verified Podman readiness returned by the bootstrap. */
export interface PodmanReadiness {
  /** Reported Podman version line. */
  version: string;
  /** Rootless mode was verified through `podman info`. */
  rootless: true;
  /** Whether this invocation installed Podman. */
  installedNow: boolean;
  /** Package manager used for installation, when installation occurred. */
  packageManager: string | null;
}

type PackageManager = {
  name: string;
  command: string;
  versionArgs: readonly string[];
  installArgs: readonly string[];
  fullUpgradeArgs?: readonly string[];
};


/** Runs one fixed executable without a shell and optionally inherits the terminal. */
export function runHostCommand(
  command: string,
  args: readonly string[],
  options: HostCommandOptions = {},
): HostCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: options.env,
    ...(options.inheritStdio ? { stdio: 'inherit' as const } : {}),
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/** Lists the supported native package-manager installers for a platform. */
function packageManagers(platform: NodeJS.Platform): readonly PackageManager[] {
  if (platform !== 'linux') return [];
  return [
    {
      name: 'pacman',
      command: 'pacman',
      versionArgs: ['--version'],
      installArgs: ['-S', '--needed', 'podman'],
      fullUpgradeArgs: ['-Syu', '--needed', 'podman'],
    },
    { name: 'apt-get', command: 'apt-get', versionArgs: ['--version'], installArgs: ['install', '-y', 'podman'] },
    { name: 'dnf', command: 'dnf', versionArgs: ['--version'], installArgs: ['install', '-y', 'podman'] },
  ];
}

/** Finds the first available supported package manager without invoking a shell. */
function findPackageManager(runner: HostCommandRunner, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): PackageManager | null {
  for (const manager of packageManagers(platform)) {
    if (runner(manager.command, manager.versionArgs, { env }).status === 0) return manager;
  }
  return null;
}

/** Reads a working Podman version, returning null when Podman is absent or broken. */
function probeVersion(runner: HostCommandRunner, env: NodeJS.ProcessEnv): string | null {
  const result = runner('podman', ['--version'], { env });
  if (result.status !== 0) return null;
  const version = result.stdout.trim();
  return version.length > 0 ? version : null;
}

/** Verifies that the current user can use Podman without a rootful fallback. */
function verifyRootless(runner: HostCommandRunner, env: NodeJS.ProcessEnv): void {
  const result = runner('podman', ['info', '--format', '{{.Host.Security.Rootless}}'], { env });
  if (result.status !== 0 || result.stdout.trim().toLowerCase() !== 'true') {
    const detail = result.stderr.trim() || result.stdout.trim() || 'Podman did not report rootless=true';
    throw new UsageError(`managed initialization requires rootless Podman: ${detail}`);
  }
}

/**
 * Detects or installs Podman, then verifies rootless readiness for managed init.
 *
 * Args:
 *   options (PodmanBootstrapOptions): owner environment, confirmation, and test seams.
 *
 * Returns:
 *   Promise<PodmanReadiness>: verified version and installation details.
 *
 * Throws:
 *   UsageError: when the platform, package manager, installation, or rootless
 *   runtime is unavailable. No project files should be written before this.
 */
export async function ensurePodman(options: PodmanBootstrapOptions = {}): Promise<PodmanReadiness> {
  const runner = options.runner ?? runHostCommand;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') {
    throw new UsageError(
      `managed initialization currently supports Linux rootless Podman only; '${platform}' requires a dedicated runtime backend`,
    );
  }
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  let version = probeVersion(runner, env);
  let installedNow = false;
  let packageManager: string | null = null;

  if (version === null) {
    const manager = findPackageManager(runner, env, platform);
    if (manager === null) {
      throw new UsageError(
        `managed initialization cannot install Podman automatically on '${platform}': ` +
          'supported Linux package managers are pacman, apt-get, and dnf',
      );
    }
    const command = uid === 0 ? manager.command : 'sudo';
    let installed = runner(
      command,
      uid === 0 ? manager.installArgs : [manager.command, ...manager.installArgs],
      { env, inheritStdio: true },
    );
    if (installed.status !== 0 && manager.fullUpgradeArgs !== undefined) {
      const detail = installed.stderr.trim() || `installer exited with status ${String(installed.status)}`;
      const question =
        `${manager.name} could not install Podman directly (${detail}). ` +
        'A full system upgrade is the fallback and may update many packages. Continue? [y/N] ';
      const approved = options.confirmSystemUpgrade === undefined
        ? false
        : await options.confirmSystemUpgrade(question);
      if (!approved) {
        throw new UsageError(
          `managed initialization did not install Podman: ${manager.name} targeted install failed; ` +
            'the full system upgrade fallback was not approved',
        );
      }
      installed = runner(
        command,
        uid === 0 ? manager.fullUpgradeArgs : [manager.command, ...manager.fullUpgradeArgs],
        { env, inheritStdio: true },
      );
    }
    if (installed.status !== 0) {
      const detail = installed.stderr.trim() || `installer exited with status ${String(installed.status)}`;
      throw new UsageError(`managed initialization could not install Podman with ${manager.name}: ${detail}`);
    }
    version = probeVersion(runner, env);
    if (version === null) {
      throw new UsageError('managed initialization installed Podman but could not execute `podman --version` afterward');
    }
    installedNow = true;
    packageManager = manager.name;
  }

  verifyRootless(runner, env);
  return { version, rootless: true, installedNow, packageManager };
}
