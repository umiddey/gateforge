/**
 * GPP/3 host (engine side): spawns a plugin subprocess, performs the
 * pinned handshake, drives lock-step discover requests over a persistent
 * session, and tears the plugin down via the shutdown handshake.
 *
 * Hardening (ADR 0002 D3): newline-delimited JSON framing with an 8 MiB
 * line cap, one outstanding request at a time, per-read watchdog timeouts
 * followed by SIGKILL, schema-generated payload validation, per-message
 * digest verification, and fail-closed teardown on every violation with a
 * single-cause actionable diagnostic — never a stack dump.
 *
 * Spec lineage: spikes/plugin-protocol/spec.md (GPP/1), hardened per
 * docs/decisions/0002-plugin-boundary.md.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { JsonValue } from '@gate-forge/core';
import {
  EofError,
  ExitStatusError,
  FrameJsonError,
  PluginError,
  ProtocolFailure,
  SchemaError,
  TimeoutError,
  type FailureContext,
} from './codes.js';
import { encodeFrame, extractLines, parseLine, verifyEnvelope, verifyPayload } from './framing.js';
import {
  REQUIRED_CAPABILITY,
  type DiscoveryOutcome,
  type MessageType,
} from './schema.js';

/** Default per-phase watchdog budgets. */
export const DEFAULT_TIMEOUTS: Required<Pick<PluginTimeouts, 'handshakeMs' | 'requestMs' | 'shutdownMs'>> = {
  handshakeMs: 10_000,
  requestMs: 10_000,
  shutdownMs: 5_000,
};

/** Watchdog budgets, all individually overridable for tests. */
export interface PluginTimeouts {
  /** Time budget for the plugin's first `hello` frame. */
  handshakeMs: number;
  /** Time budget for each `result`/`error` response. */
  requestMs: number;
  /** Time budget for `bye` and for the exit after it. */
  shutdownMs: number;
}

/** Options for {@link PluginSession}. */
export interface PluginSpawnOptions {
  /** Full argv of the plugin subprocess, e.g. `['node', 'plugin.js', root]`. */
  command: readonly string[];
  /** Expected pluginId — pinned at the handshake, enforced on every frame. */
  pluginId: string;
  /** Expected pluginVersion — pinned at the handshake, enforced on every frame. */
  pluginVersion: string;
  /** Working directory for the subprocess (default: process cwd). */
  cwd?: string;
  /** Full environment for the subprocess (default: inherit). */
  env?: NodeJS.ProcessEnv;
  /** Watchdog budgets (default: {@link DEFAULT_TIMEOUTS}). */
  timeouts?: Partial<PluginTimeouts>;
  /** Line cap in bytes (default: 8 MiB). */
  maxLineBytes?: number;
}

interface PendingRead {
  resolve: (line: Buffer) => void;
  reject: (error: ProtocolFailure) => void;
  timer: NodeJS.Timeout;
}

interface Received {
  type: MessageType;
  payload: unknown;
  frameNo: number;
}

type ExpectedFrame =
  | { kind: 'hello' }
  | { kind: 'request'; requestId: string }
  | { kind: 'bye' };

const STDERR_TAIL_LINES = 10;

/**
 * One persistent plugin subprocess: one spawn, many discovers (lock-step),
 * one shutdown handshake. Any protocol violation fails the session closed:
 * the plugin is killed and a typed {@link ProtocolFailure} is thrown whose
 * `message` is a single-cause diagnostic.
 */
export class PluginSession {
  readonly #pinnedId: string;
  readonly #pinnedVersion: string;
  readonly #timeouts: PluginTimeouts;
  readonly #maxLineBytes: number;
  readonly #proc: ChildProcess;

  #state: 'handshaking' | 'open' | 'shutting-down' | 'closed' = 'handshaking';
  #sendSeq = 0;
  #expectedPeerSeq = 1;
  #framesReceived = 0;
  #requestCounter = 0;
  #outstanding: string | null = null;
  #killed = false;

  #buffer: Buffer = Buffer.alloc(0);
  #lineQueue: Buffer[] = [];
  #pending: PendingRead | null = null;
  #exitInfo: { code: number | null; signal: string | null } | null = null;
  #stderrLines: string[] = [];
  #stderrFragment = '';

  constructor(options: PluginSpawnOptions) {
    if (options.command.length === 0 || typeof options.command[0] !== 'string') {
      throw new Error('PluginSession: options.command must be a non-empty argv array');
    }
    this.#pinnedId = options.pluginId;
    this.#pinnedVersion = options.pluginVersion;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;

    this.#proc = spawn(options.command[0], options.command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // EPIPE when the plugin died mid-write: the next read surfaces E_EOF.
    this.#proc.stdin?.on('error', () => {});
    this.#proc.stdout?.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    this.#proc.stderr?.on('data', (chunk: Buffer) => this.#onStderr(chunk));
    this.#proc.once('close', (code, signal) => this.#onClose(code, signal));
  }

  // -- Handshake -----------------------------------------------------------

  /**
   * Performs the handshake: reads and validates `hello` (pinning
   * protocolVersion, pluginId, pluginVersion) and answers `ready`.
   */
  async start(): Promise<void> {
    try {
      const received = await this.#receive('hello', this.#timeouts.handshakeMs, { kind: 'hello' });
      const { capabilities } = received.payload as { capabilities: string[] };
      if (!capabilities.includes(REQUIRED_CAPABILITY)) {
        throw new SchemaError(
          `hello (frame ${received.frameNo}): capabilities ${JSON.stringify(capabilities)} ` +
            `lack "${REQUIRED_CAPABILITY}", which the host requires`,
          { frameNo: received.frameNo },
        );
      }
      this.#state = 'open';
      this.#send('ready', {});
    } catch (error) {
      this.#ensureDead();
      throw error;
    }
  }

  // -- Discovery -----------------------------------------------------------

  /**
   * Sends one `discover` and awaits the matching `result`/`error`.
   * Lock-step: at most one discover may be outstanding per session.
   */
  async discover(paths: readonly string[]): Promise<DiscoveryOutcome> {
    if (this.#state !== 'open') {
      throw new Error(`PluginSession.discover(): session is not open (state: ${this.#state})`);
    }
    if (this.#outstanding !== null) {
      throw new Error(
        `PluginSession.discover(): lock-step violation — request ${this.#outstanding} is still outstanding`,
      );
    }
    const requestId = `req-${++this.#requestCounter}`;
    this.#outstanding = requestId;
    try {
      this.#send('discover', { requestId, paths: [...paths] });
      const received = await this.#receive(
        `result or error for request ${JSON.stringify(requestId)}`,
        this.#timeouts.requestMs,
        { kind: 'request', requestId },
      );
      const payload = received.payload as {
        requestId?: string;
        code?: string;
        message?: string;
        resources?: DiscoveryOutcome['resources'];
        unresolved?: DiscoveryOutcome['unresolved'];
        findings?: DiscoveryOutcome['findings'];
        classificationSignals?: DiscoveryOutcome['classificationSignals'];
        scannedPaths?: string[];
      };
      if (received.type === 'error') {
        const scope = payload.requestId !== undefined ? 'an error for request' : 'a fatal session error';
        throw new PluginError(
          `frame ${received.frameNo}: plugin reported ${scope} ${JSON.stringify(requestId)}: ` +
            `code=${JSON.stringify(payload.code)} message=${JSON.stringify(payload.message)}`,
          { frameNo: received.frameNo },
        );
      }
      if (payload.requestId !== requestId) {
        throw new SchemaError(
          `frame ${received.frameNo} (type result): requestId ${JSON.stringify(payload.requestId)} ` +
            `does not match outstanding request ${JSON.stringify(requestId)}`,
          { frameNo: received.frameNo },
        );
      }
      for (const signal of payload.classificationSignals ?? []) {
        if (
          signal.detector.id !== this.#pinnedId ||
          signal.detector.version !== this.#pinnedVersion
        ) {
          throw new SchemaError(
            `frame ${received.frameNo} (type result): classification signal detector ` +
              `${JSON.stringify(signal.detector.id)}@${JSON.stringify(signal.detector.version)} ` +
              `is not authorized for plugin ${JSON.stringify(this.#pinnedId)}@${JSON.stringify(this.#pinnedVersion)}`,
            { frameNo: received.frameNo },
          );
        }
      }
      return {
        resources: payload.resources ?? [],
        unresolved: payload.unresolved ?? [],
        findings: payload.findings ?? [],
        classificationSignals: payload.classificationSignals ?? [],
        ...(payload.scannedPaths !== undefined ? { scannedPaths: payload.scannedPaths } : {}),
      };
    } catch (error) {
      this.#ensureDead();
      throw error;
    } finally {
      this.#outstanding = null;
    }
  }

  // -- Shutdown ------------------------------------------------------------

  /**
   * Shutdown handshake: `shutdown` → `bye` → exit 0. Nonzero exit or a
   * hang after a clean bye is `E_EXIT_STATUS`.
   */
  async shutdown(): Promise<void> {
    if (this.#state !== 'open') {
      throw new Error(`PluginSession.shutdown(): session is not open (state: ${this.#state})`);
    }
    this.#state = 'shutting-down';
    try {
      this.#send('shutdown', {});
      await this.#receive('bye', this.#timeouts.shutdownMs, { kind: 'bye' });
      const exit = await this.#waitExit(this.#timeouts.shutdownMs);
      if (exit === null) {
        this.#kill();
        await this.#waitClose();
        throw new ExitStatusError(
          `plugin did not exit within ${this.#timeouts.shutdownMs}ms after a clean bye; killed (SIGKILL)`,
        );
      }
      if (exit.signal !== null) {
        throw new ExitStatusError(
          `plugin terminated by signal ${exit.signal} after a clean bye (expected exit 0)`,
        );
      }
      if (exit.code !== 0) {
        throw new ExitStatusError(
          `plugin exited with code ${exit.code} after a clean bye (expected 0)`,
        );
      }
      this.#state = 'closed';
    } catch (error) {
      this.#ensureDead();
      throw error;
    }
  }

  /**
   * Best-effort teardown: kills the plugin if it is still running and
   * waits for it to exit. Never throws; safe to call multiple times and
   * after any failure.
   */
  async dispose(): Promise<void> {
    this.#ensureDead();
    await this.#waitClose();
  }

  // -- Frame I/O -----------------------------------------------------------

  #onStdout(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > this.#maxLineBytes) {
      const frameNo = this.#framesReceived + 1;
      this.#failPending(
        new FrameJsonError(
          `frame ${frameNo}: line exceeds the ${Math.floor(this.#maxLineBytes / (1024 * 1024))} MiB cap ` +
            `(${this.#buffer.length} bytes without a newline)`,
          { frameNo },
        ),
      );
      return;
    }
    const { lines, rest } = extractLines(this.#buffer);
    this.#buffer = rest;
    for (const line of lines) this.#deliverLine(line);
  }

  #onStderr(chunk: Buffer): void {
    this.#stderrFragment += chunk.toString('utf8');
    const parts = this.#stderrFragment.split('\n');
    this.#stderrFragment = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim().length > 0) this.#stderrLines.push(part.trim());
    }
    if (this.#stderrLines.length > STDERR_TAIL_LINES) {
      this.#stderrLines = this.#stderrLines.slice(-STDERR_TAIL_LINES);
    }
  }

  #onClose(code: number | null, signal: string | null): void {
    this.#exitInfo = { code, signal };
    this.#state = 'closed';
    const pending = this.#pending;
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending = null;
      pending.reject(this.#eofFailure('the expected frame'));
    }
  }

  #deliverLine(line: Buffer): void {
    const pending = this.#pending;
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending = null;
      pending.resolve(line);
      return;
    }
    this.#lineQueue.push(line);
  }

  #failPending(error: ProtocolFailure): void {
    this.#kill();
    const pending = this.#pending;
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending = null;
      pending.reject(error);
      return;
    }
    // No read outstanding: drop buffered state so a later read cannot
    // observe the poisoned line; the session is dead regardless.
    this.#buffer = Buffer.alloc(0);
    this.#lineQueue = [];
  }

  #readLine(expect: string, timeoutMs: number): Promise<Buffer> {
    const queued = this.#lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#exitInfo !== null) return Promise.reject(this.#eofFailure(expect));
    return new Promise<Buffer>((resolve, reject) => {
      let pending!: PendingRead;
      const timer = setTimeout(() => {
        if (this.#pending !== pending) return;
        this.#pending = null;
        this.#kill();
        reject(
          new TimeoutError(
            `no ${expect} within ${timeoutMs}ms; plugin killed (SIGKILL) after the watchdog expired`,
          ),
        );
      }, timeoutMs);
      pending = { resolve, reject, timer };
      this.#pending = pending;
    });
  }

  /**
   * Reads, parses, envelope-verifies, state-checks, and payload-validates
   * the next plugin frame. Every failure path tears the session down.
   */
  async #receive(expect: string, timeoutMs: number, expected: ExpectedFrame): Promise<Received> {
    try {
      const raw = await this.#readLine(expect, timeoutMs);
      const frameNo = ++this.#framesReceived;
      const frame = parseLine(raw, frameNo, expect);
      const envelope = verifyEnvelope(frame, frameNo, {
        pinnedId: this.#pinnedId,
        pinnedVersion: this.#pinnedVersion,
        expectedSeq: this.#expectedPeerSeq,
      });
      this.#expectedPeerSeq = envelope.seq + 1;
      this.#checkExpectation(envelope.type, frameNo, expected);
      const payload = verifyPayload(envelope, frameNo);
      return { type: envelope.type, payload, frameNo };
    } catch (error) {
      if (error instanceof ProtocolFailure) {
        // EofError/TimeoutError already imply death; frame-level failures
        // must tear the plugin down too (fail closed, never continue).
        this.#ensureDead();
      }
      throw error;
    }
  }

  #checkExpectation(type: MessageType, frameNo: number, expected: ExpectedFrame): void {
    const context: FailureContext = { frameNo };
    switch (expected.kind) {
      case 'hello':
        if (type !== 'hello') {
          throw new SchemaError(
            `frame ${frameNo}: first frame must have type "hello", got ${JSON.stringify(type)}`,
            context,
          );
        }
        return;
      case 'request':
        if (type !== 'result' && type !== 'error') {
          throw new SchemaError(
            `frame ${frameNo}: expected "result" or "error" for request ` +
              `${JSON.stringify(expected.requestId)}, got type ${JSON.stringify(type)}`,
            context,
          );
        }
        return;
      case 'bye':
        if (type !== 'bye') {
          throw new SchemaError(
            `frame ${frameNo}: expected "bye" after shutdown, got type ${JSON.stringify(type)}`,
            context,
          );
        }
        return;
    }
  }

  #eofFailure(expect: string): EofError {
    const exit = this.#exitInfo;
    const exitText =
      exit === null
        ? 'exit unknown'
        : exit.code !== null
          ? `plugin exit code ${exit.code}`
          : `terminated by signal ${exit.signal}`;
    let detail =
      `plugin stream ended early (EOF) while waiting for ${expect}; ${exitText}; ` +
      `${this.#framesReceived} complete frame(s) received`;
    if (this.#stderrLines.length > 0) {
      detail += `\n[plugin-protocol] plugin stderr tail:\n${this.#stderrLines.map((l) => `  ${l}`).join('\n')}`;
    }
    return new EofError(detail);
  }

  #send(type: MessageType, payload: JsonValue): void {
    const seq = ++this.#sendSeq;
    this.#proc.stdin?.write(
      encodeFrame({ pluginId: this.#pinnedId, pluginVersion: this.#pinnedVersion }, type, seq, payload),
    );
  }

  #kill(): void {
    if (this.#exitInfo === null && !this.#killed) {
      this.#killed = true;
      this.#proc.kill('SIGKILL');
    }
    this.#state = 'closed';
  }

  #ensureDead(): void {
    this.#kill();
  }

  #waitExit(timeoutMs: number): Promise<{ code: number | null; signal: string | null } | null> {
    if (this.#exitInfo !== null) return Promise.resolve(this.#exitInfo);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#proc.off('close', onClose);
        resolve(null);
      }, timeoutMs);
      const onClose = (code: number | null, signal: string | null): void => {
        clearTimeout(timer);
        resolve({ code, signal });
      };
      this.#proc.once('close', onClose);
    });
  }

  #waitClose(): Promise<void> {
    if (this.#exitInfo !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.#proc.once('close', () => resolve());
    });
  }
}
