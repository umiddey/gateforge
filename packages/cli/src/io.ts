/**
 * Process I/O context for CLI commands. Every command receives an
 * `Io` object instead of touching `process` directly, so tests can run
 * commands in-process against temp repositories with captured output.
 */
import { Writable } from 'node:stream';
import { relative, sep } from 'node:path';
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

/**
 * The repo-relative path ledger `init` fills while it writes.
 *
 * It exists so the summary can tell the truth on a repo that already
 * had gateforge files: a fixed `undo: rm -rf ...` line would offer to
 * delete the OWNER's pre-existing config, baselines, waivers, hooks and
 * CI file, and a fixed "wrote no hooks" line would claim an absence the
 * repo does not have. The ledger records what this run actually did.
 *
 * `modified` is its own bucket because an append to an existing file
 * needs a different undo than a deletion: `rm -rf` would throw away the
 * owner's own lines, while `git restore` puts the file back exactly as
 * it was. Folding "modified" into "created" would offer to delete a
 * file the run only added a line to.
 */
export interface InitPathLedger {
  /** Repo-relative posix paths this run CREATED. */
  created: string[];
  /**
   * Repo-relative posix paths this run CHANGED IN PLACE (an appended
   * CI include, an appended pre-commit entry, an added ignore rule) —
   * the file existed before and still holds the owner's content.
   */
  modified: string[];
  /** Repo-relative posix paths that already existed and were left alone. */
  preserved: string[];
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
  /**
   * Optional init ledger (present only for `init`). Commands that write
   * repo files record what they created and what they left untouched, so
   * the closing summary can name only this run's own work.
   */
  initPaths?: InitPathLedger;
}

/** Builds the live-process Io. */
export function processIo(): Io {
  return { cwd: process.cwd(), env: process.env, stdout: process.stdout, stderr: process.stderr };
}

/**
 * Records a repo file in the init ledger: `created` when this run
 * brought it into existence, `modified` when it changed a file that
 * already existed, `preserved` when it was already there and left
 * alone. A no-op for commands with no ledger.
 *
 * Args:
 *   io: the command context.
 *   cwd: absolute repo root the path resolves against.
 *   path: absolute path of the file the run just wrote, changed or kept.
 *   state: which of the three happened.
 *
 * Returns:
 *   void.
 */
export function recordInitPath(
  io: Io,
  cwd: string,
  path: string,
  state: 'created' | 'modified' | 'preserved',
): void {
  const ledger = io.initPaths;
  if (ledger === undefined) return;
  ledger[state].push(relative(cwd, path).split(sep).join('/'));
}

/** Writes a line to a stream (trailing newline, no partial frames). */
export function writeLine(stream: Writable, text: string): void {
  stream.write(`${text}\n`);
}