/**
 * `gateforge controller`: the managed controller lifecycle.
 *
 * The current controller owns only a bounded health/heartbeat lifecycle. It
 * deliberately does not execute candidate commands, read candidate settings,
 * or claim to provide commit brokering; those responsibilities remain in the
 * owner-side managed runtime and broker surfaces.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from '../args.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { rejectUnknownFlags } from './common.js';

export const CONTROLLER_USAGE = 'usage: gateforge controller';
export const CONTROLLER_STATE_PATH = '/app-state/controller-health.json';
const HEARTBEAT_INTERVAL_MS = 5_000;

export type ControllerSignal = 'SIGTERM' | 'SIGINT';
/** Observable controller state written into the owner-provided app-state mount. */
export interface ControllerHealth {
  schemaVersion: 1;
  component: 'gateforge-controller';
  status: 'healthy' | 'stopped';
  startedAt: string;
  heartbeatAt: string;
  stoppedAt?: string;
  stopSignal?: ControllerSignal;
}

/** Timer and clock operations kept injectable so lifecycle tests need no sleeps. */
export interface ControllerClock {
  now(): number;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(timer: unknown): void;
}

/** Signal registration operations kept injectable so tests never signal the test runner. */
export interface ControllerSignals {
  add(signal: ControllerSignal, handler: () => void): void;
  remove(signal: ControllerSignal, handler: () => void): void;
}

/** Owner-controlled runtime seams for the controller lifecycle. */
export interface ControllerRuntime {
  statePath?: string;
  clock?: ControllerClock;
  signals?: ControllerSignals;
  pid?: number;
}

const systemClock: ControllerClock = {
  now: () => Date.now(),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

const processSignals: ControllerSignals = {
  add: (signal, handler) => process.on(signal, handler),
  remove: (signal, handler) => process.removeListener(signal, handler),
};

function timestamp(clock: ControllerClock): string {
  return new Date(clock.now()).toISOString();
}

/**
 * Writes one complete health document atomically at the fixed app-state path.
 * The path is never taken from argv or candidate-controlled configuration.
 */
function writeHealth(path: string, health: ControllerHealth): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(health)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, path);
}

/**
 * Runs until SIGTERM or SIGINT, refreshing a fixed health document every five
 * seconds and recording a final stopped state before resolving cleanly.
 */
export function runController(runtime: ControllerRuntime = {}): Promise<number> {
  const clock = runtime.clock ?? systemClock;
  const signals = runtime.signals ?? processSignals;
  const statePath = runtime.statePath ?? CONTROLLER_STATE_PATH;
  const startedAt = timestamp(clock);
  let timer: unknown;
  let settled = false;

  return new Promise<number>((resolve, reject) => {
    const healthy = (): void => {
      writeHealth(statePath, {
        schemaVersion: 1,
        component: 'gateforge-controller',
        status: 'healthy',
        startedAt,
        heartbeatAt: timestamp(clock),
      });
    };

    try {
      healthy();
      const stop = (signal: ControllerSignal): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clock.clearInterval(timer);
        const stoppedAt = timestamp(clock);
        writeHealth(statePath, {
          schemaVersion: 1,
          component: 'gateforge-controller',
          status: 'stopped',
          startedAt,
          heartbeatAt: stoppedAt,
          stoppedAt,
          stopSignal: signal,
        });
        signals.remove('SIGTERM', onSigterm);
        signals.remove('SIGINT', onSigint);
        resolve(0);
      };
      const onSigterm = (): void => stop('SIGTERM');
      const onSigint = (): void => stop('SIGINT');
      signals.add('SIGTERM', onSigterm);
      signals.add('SIGINT', onSigint);
      timer = clock.setInterval(healthy, HEARTBEAT_INTERVAL_MS);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Parses and runs the controller command. With no arguments it enters the
 * lifecycle above and emits no usage text; `--help` is the only usage path.
 */
export async function controllerCommand(
  io: Io,
  argv: readonly string[],
  runtime: ControllerRuntime = {},
): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true && positionals.length === 0) {
    writeLine(io.stdout, CONTROLLER_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['help'], CONTROLLER_USAGE);
  if (positionals.length > 0) {
    throw new UsageError(`controller does not accept positional arguments (${CONTROLLER_USAGE})`);
  }
  return runController(runtime);
}
