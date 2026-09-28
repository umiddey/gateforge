import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PreflightCommand {
  name: string;
  command: string;
  timeoutSeconds?: number;
}

export interface HealthProbe {
  name: string;
  tcp?: string;
  http?: string;
  command?: string;
  logAbsent?: { command: string; pattern: string };
  tls?: boolean;
  timeoutSeconds?: number;
}

export interface PreflightFailure {
  name: string;
  exitCode: number;
  output: string;
}

export interface HealthFailure {
  name: string;
  healthy: false;
  reason: string;
}

/** Runs one shell command with a deadline and returns bounded combined output.
 *
 * Args:
 *   command: command string declared by the repository owner.
 *   cwd: directory in which to execute the command.
 *   env: environment inherited by the process.
 *   timeoutSeconds: command time budget.
 *
 * Returns:
 *   Promise<{exitCode: number; output: string}>: process outcome and last thirty lines.
 */
async function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  maxLines = 30,
): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let finished = false;
    const settle = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const lines = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
      resolve({ exitCode, output: lines.slice(-maxLines).join('\n') });
    };
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', () => settle(127));
    child.once('close', (code) => settle(code ?? 1));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(124);
    }, timeoutSeconds * 1_000);
  });
}

/** Runs configured preflight checks in declaration order and returns the first failure.
 *
 * Args:
 *   commands: cheap owner-declared checks to run before the suite.
 *   cwd: repository root used as command working directory.
 *   env: environment inherited by commands.
 *
 * Returns:
 *   Promise<PreflightFailure | null>: first failed command, or null when all pass.
 */
export async function runPreflightCommands(
  commands: readonly PreflightCommand[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<PreflightFailure | null> {
  for (const item of commands) {
    const result = await runCommand(item.command, cwd, env, item.timeoutSeconds ?? 60);
    if (result.exitCode !== 0) return { name: item.name, ...result };
  }
  return null;
}

export interface HarnessCommands {
  up?: string;
  reset?: string;
  seed?: string;
  health?: string;
  down?: string;
  serviceLogs?: { command: string; services: string[]; lines: number };
}

export interface HarnessFailure {
  step: 'up' | 'reset' | 'seed' | 'health' | 'down';
  exitCode: number;
  output: string;
}

/** Runs up, reset, seed, and health commands in declared lifecycle order.
 *
 * Args:
 *   commands: explicitly configured environment lifecycle commands.
 *   cwd: repository root used as command working directory.
 *   env: environment inherited by commands.
 *
 * Returns:
 *   Promise<HarnessFailure | null>: first failed setup step.
 */
export async function runHarnessSetup(
  commands: HarnessCommands | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<HarnessFailure | null> {
  if (commands === undefined) return null;
  for (const step of ['up', 'reset', 'seed', 'health'] as const) {
    const command = commands[step];
    if (command === undefined) continue;
    const result = await runCommand(command, cwd, env, 60);
    if (result.exitCode !== 0) return { step, ...result };
  }
  return null;
}

/** Runs the configured teardown command after a harness setup attempt.
 *
 * Args:
 *   commands: configured environment lifecycle commands.
 *   cwd: repository root used as command working directory.
 *   env: environment inherited by the command.
 *
 * Returns:
 *   Promise<HarnessFailure | null>: teardown failure, or null when absent or successful.
 */
export async function runHarnessTeardown(
  commands: HarnessCommands | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<HarnessFailure | null> {
  if (commands?.down === undefined) return null;
  const result = await runCommand(commands.down, cwd, env, 60);
  return result.exitCode === 0 ? null : { step: 'down', ...result };
}

/** Executes exactly one configured health probe and reports its first failure.
 *
 * Args:
 *   probes: owner-declared fixture probes.
 *   cwd: repository root used by command probes.
 *   env: environment inherited by command probes.
 *
 * Returns:
 *   Promise<HealthFailure | null>: first unhealthy fixture, or null when all are healthy.
 */
export async function probeHealth(
  probes: readonly HealthProbe[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<HealthFailure | null> {
  for (const probe of probes) {
    const timeoutMs = (probe.timeoutSeconds ?? 5) * 1_000;
    try {
      if (probe.tcp !== undefined) {
        const endpoint = /^([^:]+):(\d+)$/.exec(probe.tcp);
        if (endpoint === null) return { name: probe.name, healthy: false, reason: `invalid TCP endpoint '${probe.tcp}'` };
        const healthy = await new Promise<boolean>((resolve) => {
          const socket = net.createConnection({ host: endpoint[1], port: Number(endpoint[2]) });
          const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
          socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
          socket.once('error', () => { clearTimeout(timer); resolve(false); });
        });
        if (!healthy) return { name: probe.name, healthy: false, reason: `TCP connection failed for ${probe.tcp}` };
      } else if (probe.http !== undefined) {
        const url = new URL(probe.http);
        if (probe.tls === true && url.protocol !== 'https:') {
          return { name: probe.name, healthy: false, reason: 'TLS verification requires an https URL' };
        }
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return { name: probe.name, healthy: false, reason: `HTTP ${response.status} from ${probe.http}` };
      } else if (probe.command !== undefined) {
        const result = await runCommand(probe.command, cwd, env, probe.timeoutSeconds ?? 5);
        if (result.exitCode !== 0) return { name: probe.name, healthy: false, reason: `command exited ${result.exitCode}: ${result.output}` };
      } else if (probe.logAbsent !== undefined) {
        const result = await runCommand(
          probe.logAbsent.command,
          cwd,
          env,
          probe.timeoutSeconds ?? 5,
          1_000,
        );
        if (result.exitCode !== 0) {
          return { name: probe.name, healthy: false, reason: `log command exited ${result.exitCode}: ${result.output}` };
        }
        if (new RegExp(probe.logAbsent.pattern).test(result.output)) {
          return { name: probe.name, healthy: false, reason: `log pattern '${probe.logAbsent.pattern}' was present after startup` };
        }
      } else {
        return { name: probe.name, healthy: false, reason: 'health probe has no supported probe kind' };
      }
    } catch (error) {
      return { name: probe.name, healthy: false, reason: (error as Error).message };
    }
  }
  return null;
}

/** Writes a service-log tail artifact using the declared log snippets.
 *
 * Args:
 *   stateDir: root directory for run artifacts.
 *   serviceLogs: map from a safe service name to captured log text.
 *   lines: maximum number of trailing lines per service.
 *
 * Returns:
 *   string | null: written artifact path, or null when no logs are supplied.
 */
export function writeServiceLogTails(
  stateDir: string,
  serviceLogs: Readonly<Record<string, string>>,
  lines = 100,
): string | null {
  const entries = Object.entries(serviceLogs);
  if (entries.length === 0) return null;
  const directory = join(stateDir, 'diagnostics');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'service-logs.txt');
  const output = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `## ${name}\n${value.split(/\r?\n/).slice(-lines).join('\n')}`)
    .join('\n\n');
  writeFileSync(path, `${output}\n`, 'utf8');
  return path;
}

/** Captures declared service logs after a failed supervised run.
 *
 * Args:
 *   serviceLogs: configured command template, service names, and per-service line limit.
 *   stateDir: run-state directory for the artifact.
 *   cwd: repository root used by the capture commands.
 *   env: environment inherited by the commands.
 *
 * Returns:
 *   Promise<string | null>: artifact path, or null when no log capture is configured.
 */
export async function captureServiceLogs(
  serviceLogs: HarnessCommands['serviceLogs'],
  stateDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (serviceLogs === undefined) return null;
  const outputByService: Record<string, string> = {};
  for (const service of serviceLogs.services) {
    const command = serviceLogs.command
      .replaceAll('${service}', service)
      .replaceAll('${lines}', String(serviceLogs.lines));
    const result = await runCommand(command, cwd, env, 30, serviceLogs.lines);
    outputByService[service] =
      result.exitCode === 0 ? result.output : `${result.output}\nlog command exited ${String(result.exitCode)}`;
  }
  return writeServiceLogTails(stateDir, outputByService, serviceLogs.lines);
}
