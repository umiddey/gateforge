/**
 * Process I/O context for CLI commands. Every command receives an
 * `Io` object instead of touching `process` directly, so tests can run
 * commands in-process against temp repositories with captured output.
 */
import { Writable } from 'node:stream';
import type { HostCommandRunner } from './podman-bootstrap.js';
/** Captured-output stream used by tests: collects everything written. */
export class CaptureStream extends Writable {
  chunks: Buffer[] = [];

  override _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  /** Everything written so far, as UTF-8 text ("" when nothing). */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Environment + streams a command runs under (defaults = live process). */
export interface Io {
  /** Working directory; all repo-relative paths resolve against it. */
  cwd: string;
  /** Process environment (CI provider variables, injected clock etc.). */
  env: NodeJS.ProcessEnv;
  /** Optional host-command seam for owner-runtime bootstrap tests. */
  hostCommandRunner?: HostCommandRunner;
  /** Standard output sink (default: process.stdout). */
  stdout: Writable;
  /** Standard error sink (default: process.stderr). */
  stderr: Writable;
}

/** Builds the live-process Io. */
export function processIo(): Io {
  return { cwd: process.cwd(), env: process.env, stdout: process.stdout, stderr: process.stderr };
}

/** Writes a line to a stream (trailing newline, no partial frames). */
export function writeLine(stream: Writable, text: string): void {
  stream.write(`${text}\n`);
}