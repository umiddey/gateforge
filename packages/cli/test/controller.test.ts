import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { CaptureStream, type Io } from '../src/io.js';
import type { ControllerClock, ControllerSignal, ControllerSignals } from '../src/commands/controller.js';

class FakeClock implements ControllerClock {
  nowValue = Date.parse('2026-01-01T00:00:00.000Z');
  heartbeat: (() => void) | undefined;

  now(): number {
    return this.nowValue;
  }

  setInterval(callback: () => void): unknown {
    this.heartbeat = callback;
    return callback;
  }

  clearInterval(_timer: unknown): void {
    this.heartbeat = undefined;
  }
}

class FakeSignals implements ControllerSignals {
  handlers = new Map<ControllerSignal, () => void>();

  add(signal: ControllerSignal, handler: () => void): void {
    this.handlers.set(signal, handler);
  }

  remove(signal: ControllerSignal, handler: () => void): void {
    if (this.handlers.get(signal) === handler) this.handlers.delete(signal);
  }

  emit(signal: ControllerSignal): void {
    this.handlers.get(signal)?.();
  }
}

describe('gateforge controller', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('starts without usage output and stops cleanly on %s', async (signal) => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-controller-'));
    try {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const io: Io = { cwd: root, env: {}, stdout, stderr };
      const clock = new FakeClock();
      const signals = new FakeSignals();
      const lifecycle = main(['controller'], io, {
        controller: { statePath: join(root, 'controller-health.json'), clock, signals },
      });

      expect(stdout.text()).toBe('');
      expect(stderr.text()).toBe('');
      expect(JSON.parse(readFileSync(join(root, 'controller-health.json'), 'utf8'))).toMatchObject({
        component: 'gateforge-controller',
        status: 'healthy',
      });

      clock.nowValue += 5_000;
      clock.heartbeat?.();
      signals.emit(signal);
      await expect(lifecycle).resolves.toBe(0);
      expect(JSON.parse(readFileSync(join(root, 'controller-health.json'), 'utf8'))).toMatchObject({
        component: 'gateforge-controller',
        status: 'stopped',
        stopSignal: signal,
      });
      expect(stdout.text()).toBe('');
      expect(stderr.text()).toBe('');

    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps the managed image default command on the controller lifecycle', () => {
    const candidates = [
      join(process.cwd(), 'deploy/managed/controller.containerfile'),
      join(process.cwd(), '../../deploy/managed/controller.containerfile'),
    ];
    const containerfilePath = candidates.find((candidate) => existsSync(candidate));
    if (containerfilePath === undefined) throw new Error('managed controller Containerfile not found');
    const containerfile = readFileSync(containerfilePath, 'utf8');
    expect(containerfile).toContain('CMD ["controller"]');
  });
});
