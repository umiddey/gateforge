/**
 * Process I/O context for CLI commands. Every command receives an
 * `Io` object instead of touching `process` directly, so tests can run
 * commands in-process against temp repositories with captured output.
 */
import { Writable } from 'node:stream';
/** Captured-output stream used by tests: collects everything written. */
export declare class CaptureStream extends Writable {
    chunks: Buffer[];
    _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void;
    /** Everything written so far, as UTF-8 text ("" when nothing). */
    text(): string;
}
/** Environment + streams a command runs under (defaults = live process). */
export interface Io {
    /** Working directory; all repo-relative paths resolve against it. */
    cwd: string;
    /** Process environment (CI provider variables, injected clock etc.). */
    env: NodeJS.ProcessEnv;
    /** Standard output sink (default: process.stdout). */
    stdout: Writable;
    /** Standard error sink (default: process.stderr). */
    stderr: Writable;
}
/** Builds the live-process Io. */
export declare function processIo(): Io;
/** Writes a line to a stream (trailing newline, no partial frames). */
export declare function writeLine(stream: Writable, text: string): void;
//# sourceMappingURL=io.d.ts.map