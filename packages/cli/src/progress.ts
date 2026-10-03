/**
 * The CI progress stream (CI visibility plan, sections 1 and 5).
 *
 * A long witnessed run used to be a blank CI screen: the consumer's job
 * redirects the whole runner log to a private file because the runner
 * log carries secrets, and Gateforge itself printed nothing until the
 * gate line. This module is the replacement — and it is secret-free BY
 * CONSTRUCTION rather than by filtering: every line is built from facts
 * the supervisor already holds (how many tests were registered, which
 * test is running, its catalog title, its outcome), never from runner
 * output, a response body, an env value, or a stack trace.
 *
 * The one runtime value it does carry — the failing test's first error
 * line, added by §5 — passes {@link looksLikeSecret} and is REPLACED
 * wholesale when it matches; nothing is trimmed, masked, or partially
 * quoted (a prefix of a secret is a secret).
 *
 * The stream decides NOTHING: it is not evidence, no gate reads it, and
 * a write failure (a closed pipe, an unwritable file) is reported once
 * and then ignored, because a progress line must never fail a run.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { UsageError } from './errors.js';
import { looksLikeSecret } from './secret-guard.js';

/** Where the stream writes. `null` means the stream is off. */
export type ProgressTarget =
  | { kind: 'stderr' }
  | { kind: 'file'; path: string };

/** The run shapes a start line can name. */
export type ProgressScope = 'full' | 'changed' | 'named';

/** The outcome vocabulary every runner adapter normalizes to. */
export type ProgressOutcome = 'passed' | 'failed' | 'skipped';

/** One finished test, as the drain observed it. */
export interface ProgressTestOutcome {
  /** The run's own test identity (`<file>#<title path>`). */
  logicalKey: string;
  /** The catalog title as declared in the committed test file. */
  title: string;
  /** The observed outcome. */
  outcome: ProgressOutcome;
  /** testEnd only: the runner's own error message (guarded before use). */
  message?: string;
  /** testEnd only: short `file:line` frames (deduplicated, at most five). */
  stackFrames?: readonly string[];
}

/** One failure kept for the Gateforge-owned artifact. */
export interface ProgressFailure {
  /** The run's own test identity. */
  logicalKey: string;
  /** The catalog title as declared in the committed test file. */
  title: string;
  /** The guarded error message (whole text, never a fragment of a secret). */
  message: string;
  /** The short `file:line` frames, at most five. */
  stackFrames: string[];
}

/** How long a run may be quiet before the stream says it is alive. */
export const ALIVE_INTERVAL_MS = 60_000;

/** The longest title or first message line the stream prints in full. */
export const MAX_STREAM_TEXT = 200;

/** The most stack frames a failure record keeps. */
const MAX_STACK_FRAMES = 5;

/** What a title looks like when it is replaced by its own digest. */
function safeTitle(title: string): string {
  if (!looksLikeSecret(title)) return title;
  return `(secretsafe title ${createHash('sha256').update(title).digest('hex').slice(0, 12)})`;
}

/** A bounded title: the allowlist value, truncated at the stream's limit. */
function displayTitle(title: string): string {
  const safe = safeTitle(title);
  return safe.length > MAX_STREAM_TEXT ? `${safe.slice(0, MAX_STREAM_TEXT)}…` : safe;
}

/** The first line of a message, truncated — or the withheld marker. */
function displayMessageLine(message: string): string {
  const first = message.split('\n', 1)[0] ?? '';
  if (looksLikeSecret(first)) return '(message withheld: looks like a secret)';
  return first.length > MAX_STREAM_TEXT ? `${first.slice(0, MAX_STREAM_TEXT)}…` : first;
}

/** A whole message, guarded: a secret-shaped one is never stored. */
function guardedMessage(message: string): string {
  return looksLikeSecret(message) ? '(message withheld: looks like a secret)' : message;
}

/** `7m12s` from a millisecond duration (minutes always printed). */
function elapsedLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`;
}

/** Resolves the `--progress` flag, the `run.progress` config key, and `CI`.
 *
 * Precedence is flag → config → auto, and `auto` means stderr under CI
 * and OFF everywhere else, so a local run's bytes are unchanged. An
 * unusable target is a usage error, never a silently dropped stream: a
 * CI job that asked for progress and got none is a job that looks hung.
 *
 * Args:
 *   flag: the `--progress` value, when the operator passed one.
 *   config: the `run.progress` config value, when the file sets one.
 *   env: process environment (only `CI` is consulted).
 *
 * Returns:
 *   ProgressTarget | null: where to write, or null when the stream is off.
 * @throws UsageError naming `--progress` for an unusable target (exit 2).
 */
export function resolveProgressTarget(
  flag: string | undefined,
  config: string | undefined,
  env: NodeJS.ProcessEnv,
): ProgressTarget | null {
  const raw = flag ?? config ?? 'auto';
  if (raw === 'off') return null;
  if (raw === 'stderr') return { kind: 'stderr' };
  if (raw.startsWith('file:')) {
    const path = raw.slice('file:'.length);
    if (path.length > 0) return { kind: 'file', path };
  }
  if (raw === 'auto') return env['CI'] === 'true' ? { kind: 'stderr' } : null;
  throw new UsageError(
    `test-gates: --progress must be 'off', 'stderr', 'file:<path>', or 'auto' (got '${raw}')`,
  );
}

/** Construction options for one {@link ProgressStream}. */
export interface ProgressStreamOptions {
  /** Where lines go; `null` keeps the stream completely silent. */
  writer: ProgressTarget | null;
  /** The runner name (from the trusted config, never from the suite). */
  runner: string;
  /** The scope the run actually grades. */
  scope: ProgressScope;
  /** The registered expected-set size — the `M` in `N/M`. */
  expected: number;
  /** Millisecond clock (tests inject a fake one; no real waiting). */
  now?: () => number;
  /** Timer arming (tests inject a fake one; no real waiting). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Timer disarming. */
  clearTimer?: (handle: unknown) => void;
  /** The stderr sink (never used by a file target). */
  writeLine: (line: string) => void;
  /** Where the one "the stream is gone" warning goes. */
  warn?: (line: string) => void;
}

/**
 * The progress stream of one supervised run.
 *
 * Every line is a pure function of witness-side facts, so the stream
 * cannot carry a secret that a filter would have had to recognize: a
 * title is committed code (and a title that itself looks like a secret
 * is replaced by its digest), a message is matched against the credential
 * shapes and replaced wholesale.
 */
export class ProgressStream {
  private readonly options: ProgressStreamOptions;
  private readonly failureRecords: ProgressFailure[] = [];
  private readonly running = new Set<string>();
  private done = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private startedAt = 0;
  private lastEventAt = 0;
  private timer: unknown = null;
  private broken = false;
  private finished = false;

  /** Every failure this run observed, for the Gateforge-owned artifact. */
  get failures(): readonly ProgressFailure[] {
    return this.failureRecords;
  }

  /** How many tests have reported an outcome so far. */
  get completed(): number {
    return this.done;
  }

  /**
   * @param options: target, run facts, clock and sinks (see {@link ProgressStreamOptions}).
   */
  constructor(options: ProgressStreamOptions) {
    this.options = options;
  }

  /** Prints the start line and arms the alive ticker. */
  start(): void {
    if (this.finished) return;
    this.startedAt = this.clock();
    this.lastEventAt = this.startedAt;
    this.line(
      `gateforge: run started — ${String(this.options.expected)} tests expected ` +
        `(runner ${this.options.runner}, scope ${this.options.scope})`,
    );
    this.arm();
  }

  /** Records that a test started (it counts as running for the alive line). */
  beginTest(title: string): void {
    if (this.finished) return;
    this.running.add(title);
    this.quiet();
  }

  /**
   * An event happened: it restarts the QUIET clock, so an alive line
   * only ever reports a run that has genuinely been silent for a whole
   * minute (a busy run is already reporting itself).
   */
  private quiet(): void {
    this.lastEventAt = this.clock();
  }

  /**
   * Records one finished test: prints its line, counts the outcome, and
   * keeps the guarded diagnosis of a failure for the artifact.
   *
   * @param outcome: the drain's observation of one finished test.
   */
  endTest(outcome: ProgressTestOutcome): void {
    if (this.finished) return;
    this.running.delete(outcome.title);
    this.quiet();
    this.done += 1;
    const counter = `${String(this.done)}/${String(this.options.expected)}`;
    if (outcome.outcome === 'passed') {
      this.passed += 1;
      this.line(`gateforge: ✓ ${counter} ${displayTitle(outcome.title)}`);
    } else if (outcome.outcome === 'skipped') {
      this.skipped += 1;
      this.line(`gateforge: – ${counter} ${displayTitle(outcome.title)} (skipped)`);
    } else {
      this.failed += 1;
      const detail =
        outcome.message === undefined || outcome.message.length === 0
          ? ''
          : ` — ${displayMessageLine(outcome.message)}`;
      this.line(`gateforge: ✘ ${counter} ${displayTitle(outcome.title)}${detail}`);
      this.failureRecords.push({
        logicalKey: outcome.logicalKey,
        title: safeTitle(outcome.title),
        message: outcome.message === undefined ? '' : guardedMessage(outcome.message),
        stackFrames: dedupeFrames(outcome.stackFrames ?? []),
      });
    }
  }

  /** Prints the finish line and stops the ticker. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.disarm();
    this.line(
      `gateforge: run finished — ${String(this.passed)} passed, ${String(this.failed)} failed, ` +
        `${String(this.skipped)} skipped in ${elapsedLabel(this.clock() - this.startedAt)}; grading…`,
    );
  }

  /** The current millisecond reading. */
  private clock(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * The periodic quiet-interval tick: an alive line is printed only when
   * a WHOLE interval passed with no event at all, then the tick re-arms
   * itself until the run finishes. The elapsed time is read from the
   * injected clock, never from the timer, so a test proves the rule
   * without waiting a real minute.
   */
  private alive(): void {
    this.timer = null;
    if (this.finished) return;
    if (this.clock() - this.lastEventAt >= ALIVE_INTERVAL_MS) {
      this.line(
        `gateforge: alive — ${String(this.done)}/${String(this.options.expected)} done, ` +
          `${String(this.running.size)} running, ${elapsedLabel(this.clock() - this.startedAt)} elapsed`,
      );
      this.lastEventAt = this.clock();
    }
    this.arm();
  }

  /** Arms the next quiet-interval tick (fake clock and timer in tests). */
  private arm(): void {
    const arm = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = arm(() => {
      this.alive();
    }, ALIVE_INTERVAL_MS);
  }

  /** Disarms the alive timer when one is armed. */
  private disarm(): void {
    if (this.timer === null) return;
    const clear = this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
    clear(this.timer);
    this.timer = null;
  }

  /**
   * Writes one line, or gives up after warning exactly once: a closed
   * pipe or an unwritable file must never fail a run, and a stream that
   * warns repeatedly is noise.
   */
  private line(text: string): void {
    const target = this.options.writer;
    if (target === null || this.broken) return;
    try {
      if (target.kind === 'stderr') {
        this.options.writeLine(text);
        return;
      }
      mkdirSync(dirname(target.path), { recursive: true });
      appendFileSync(target.path, `${text}\n`, 'utf8');
    } catch {
      this.broken = true;
      this.options.warn?.(
        `warning: progress stream unavailable (${target.kind === 'file' ? target.path : 'stderr'}) — ` +
          'the run continues without it; the stream is never evidence',
      );
    }
  }
}

/** Frames in first-seen order, at most five (a repeated frame says nothing). */
function dedupeFrames(frames: readonly string[]): string[] {
  return [...new Set(frames)].slice(0, MAX_STACK_FRAMES);
}
