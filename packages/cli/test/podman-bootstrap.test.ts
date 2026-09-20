import { describe, expect, it } from 'vitest';
import { ensurePodman, type HostCommandRunner } from '../src/podman-bootstrap.js';

const VERSION = 'podman version 5.0.0';

function scriptedRunner(script: (command: string, args: readonly string[]) => { status: number; stdout?: string; stderr?: string }): {
  calls: Array<{ command: string; args: readonly string[]; inheritStdio: boolean }>;
  runner: HostCommandRunner;
} {
  const calls: Array<{ command: string; args: readonly string[]; inheritStdio: boolean }> = [];
  const runner: HostCommandRunner = (command, args, options = {}) => {
    calls.push({ command, args, inheritStdio: options.inheritStdio === true });
    const result = script(command, args);
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { calls, runner };
}

describe('managed Podman bootstrap', () => {
  it('accepts an already-installed rootless Podman without installing anything', async () => {
    const { calls, runner } = scriptedRunner((command, args) => {
      if (command === 'podman' && args[0] === '--version') return { status: 0, stdout: `${VERSION}\n` };
      if (command === 'podman' && args[0] === 'info') return { status: 0, stdout: 'true\n' };
      return { status: 1, stderr: 'unexpected command' };
    });

    await expect(ensurePodman({ runner, platform: 'linux', uid: 1000, env: {} })).resolves.toEqual({
      version: VERSION,
      rootless: true,
      installedNow: false,
      packageManager: null,
    });
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['podman', '--version'],
      ['podman', 'info', '--format', '{{.Host.Security.Rootless}}'],
    ]);
  });

  it('tries targeted Arch installation first and asks before the full-upgrade fallback', async () => {
    let versionProbes = 0;
    const { calls, runner } = scriptedRunner((command, args) => {
      if (command === 'podman' && args[0] === '--version') {
        versionProbes += 1;
        return versionProbes === 1 ? { status: 1, stderr: 'not found' } : { status: 0, stdout: `${VERSION}\n` };
      }
      if (command === 'pacman' && args[0] === '--version') return { status: 0, stdout: 'pacman 7\n' };
      if (command === 'sudo' && args[0] === 'pacman' && args[1] === '-S') return { status: 1, stderr: '404' };
      if (command === 'sudo' && args[0] === 'pacman' && args[1] === '-Syu') return { status: 0 };
      if (command === 'podman' && args[0] === 'info') return { status: 0, stdout: 'true\n' };
      return { status: 1, stderr: 'unexpected command' };
    });
    const confirmations: string[] = [];

    await expect(
      ensurePodman({
        runner,
        platform: 'linux',
        uid: 1000,
        env: {},
        confirmSystemUpgrade: async (question) => {
          confirmations.push(question);
          return true;
        },
      }),
    ).resolves.toMatchObject({
      version: VERSION,
      rootless: true,
      installedNow: true,
      packageManager: 'pacman',
    });
    expect(confirmations[0]).toMatch(/full system upgrade/);
    expect(calls).toContainEqual({
      command: 'sudo',
      args: ['pacman', '-S', '--needed', 'podman'],
      inheritStdio: true,
    });
    expect(calls).toContainEqual({
      command: 'sudo',
      args: ['pacman', '-Syu', '--needed', 'podman'],
      inheritStdio: true,
    });
  });

  it('declines the Arch full-upgrade fallback without writing project files', async () => {
    const { calls, runner } = scriptedRunner((command, args) => {
      if (command === 'podman' && args[0] === '--version') return { status: 1, stderr: 'not found' };
      if (command === 'pacman' && args[0] === '--version') return { status: 0, stdout: 'pacman 7\n' };
      if (command === 'sudo' && args[0] === 'pacman') return { status: 1, stderr: '404' };
      return { status: 1, stderr: 'unexpected command' };
    });

    await expect(
      ensurePodman({
        runner,
        platform: 'linux',
        uid: 1000,
        env: {},
        confirmSystemUpgrade: () => false,
      }),
    ).rejects.toThrow(/full system upgrade fallback was not approved/);
    expect(calls.some((call) => call.args.includes('-Syu'))).toBe(false);
  });

  it('uses no sudo when the process is already root', async () => {
    let versionProbes = 0;
    const { calls, runner } = scriptedRunner((command, args) => {
      if (command === 'podman' && args[0] === '--version') {
        versionProbes += 1;
        return versionProbes === 1 ? { status: 1 } : { status: 0, stdout: `${VERSION}\n` };
      }
      if (command === 'dnf' && args[0] === '--version') return { status: 0, stdout: 'dnf\n' };
      if (command === 'dnf' && args[0] === 'install') return { status: 0 };
      if (command === 'podman' && args[0] === 'info') return { status: 0, stdout: 'true\n' };
      return { status: 1, stderr: 'unexpected command' };
    });

    await ensurePodman({ runner, platform: 'linux', uid: 0, env: {} });
    expect(calls).toContainEqual({
      command: 'dnf',
      args: ['install', '-y', 'podman'],
      inheritStdio: true,
    });
  });

  it('fails closed when rootless Podman is unavailable after installation', async () => {
    const { runner } = scriptedRunner((command, args) => {
      if (command === 'podman' && args[0] === '--version') return { status: 0, stdout: `${VERSION}\n` };
      if (command === 'podman' && args[0] === 'info') return { status: 1, stderr: 'cannot configure rootless namespaces' };
      return { status: 1, stderr: 'unexpected command' };
    });

    await expect(ensurePodman({ runner, platform: 'linux', uid: 1000, env: {} })).rejects.toThrow(
      /requires rootless Podman.*cannot configure rootless namespaces/,
    );
  });

  it('fails closed on unsupported platforms instead of guessing an equivalent runtime', async () => {
    const { calls, runner } = scriptedRunner((command) =>
      command === 'podman' ? { status: 0, stdout: `${VERSION}\n` } : { status: 1, stderr: 'unexpected command' },
    );

    await expect(ensurePodman({ runner, platform: 'win32', uid: 1000, env: {} })).rejects.toThrow(
      /supports Linux rootless Podman only/,
    );
    expect(calls).toEqual([]);
  });

});
