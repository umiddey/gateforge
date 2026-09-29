/**
 * The ADDITIVE failure diagnosis a runner adapter may attach to its
 * `testEnd` spool event, for the CI progress stream and the
 * Gateforge-owned failures artifact.
 *
 * This is the one place runner output is ever consulted, and it is
 * consulted structurally, never as text: a failing test's first error
 * message and up to five `file:line` frames. The runner's raw log is
 * never copied, filtered, or tailed — a filter over secret text is not
 * secret-free, and the trusted CLI screens the message against the
 * credential shapes before it reaches a console or an artifact.
 */
import { relative, sep } from 'node:path';

/** The structural shape every runner's serialized error reduces to. */
export interface SerializedFailure {
  /** The runner's own error message. */
  message?: string;
  /** The runner's own serialized stack, when it exposes one. */
  stack?: string;
}

/** The diagnosis one failed test contributes to its `testEnd` event. */
export interface FailureDiagnosis {
  /** The runner's first error message. */
  errorMessage: string;
  /** Up to five repo-relative `file:line` frames, in runner order. */
  stackFrames: string[];
}

/** The most stack frames a diagnosis keeps. */
const MAX_FRAMES = 5;

/**
 * The `file:line` frames of a serialized stack, repo-relative, first
 * five. Anything that is not a source frame (a message line, a runtime
 * banner, a frame outside the tested tree) is dropped — a diagnosis
 * points a human at a line of the repository, nothing else.
 *
 * Args:
 *   stack: the runner's serialized stack text.
 *
 * Returns:
 *   string[]: deduplicated `file:line` frames in the order reported.
 */
export function stackFramesOf(stack: string): string[] {
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const match = /(?:at\s+.*\()?(\S+):(\d+)(?::\d+)?\)?\s*$/.exec(line.trim());
    if (match === null) continue;
    const file = relative(process.cwd(), match[1] ?? '').split(sep).join('/');
    if (file.length === 0 || file.startsWith('..')) continue;
    frames.push(`${file}:${match[2] ?? '0'}`);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

/**
 * The diagnosis of one failed test, or null when the runner reported
 * nothing usable (a passing test, or a runner that exposes no error).
 *
 * Args:
 *   errors: the runner's serialized errors for the test, in its order.
 *
 * Returns:
 *   FailureDiagnosis | null: the first error's message and short stack.
 */
export function failureDiagnosisOf(
  errors: readonly SerializedFailure[] | undefined,
): FailureDiagnosis | null {
  const first = errors?.[0];
  if (first === undefined) return null;
  const message = typeof first.message === 'string' ? first.message : '';
  const frames = typeof first.stack === 'string' ? [...new Set(stackFramesOf(first.stack))] : [];
  if (message.length === 0 && frames.length === 0) return null;
  return { errorMessage: message, stackFrames: frames };
}
