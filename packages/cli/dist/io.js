/**
 * Process I/O context for CLI commands. Every command receives an
 * `Io` object instead of touching `process` directly, so tests can run
 * commands in-process against temp repositories with captured output.
 */
import { Writable } from 'node:stream';
/** Captured-output stream used by tests: collects everything written. */
export class CaptureStream extends Writable {
    chunks = [];
    _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }
    /** Everything written so far, as UTF-8 text ("" when nothing). */
    text() {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}
/** Builds the live-process Io. */
export function processIo() {
    return { cwd: process.cwd(), env: process.env, stdout: process.stdout, stderr: process.stderr };
}
/** Writes a line to a stream (trailing newline, no partial frames). */
export function writeLine(stream, text) {
    stream.write(`${text}\n`);
}
//# sourceMappingURL=io.js.map