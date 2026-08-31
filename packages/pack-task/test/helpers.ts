/**
 * Test helpers: fixture root, in-process detector with overridable
 * root, and tiny spy server for the e2e suite.
 *
 * Mirrors `packages/pack-sqlalchemy/test/helpers.ts` but trimmed —
 * pack-task is TS-only, so no subprocess plumbing is needed.
 */
import { fileURLToPath } from 'node:url';
import { createTaskDetector, type TaskDetector } from '../src/detector.js';

/** Absolute dir of the pack's test fixtures (sibling of `src/` and `test/`). */
export const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures', import.meta.url));

/** Builds a detector scoped to the fixtures directory. */
export function detectorOverFixtures(): TaskDetector {
  return createTaskDetector({ rootDir: FIXTURE_ROOT });
}

/** Every fixture scanned as one discovery request. */
export const ALL_FIXTURE_PATHS = [
  'bullmq.ts',
  'bee-queue.ts',
  'custom-queue.ts',
  'message-handler.ts',
  'recurring.ts',
  'decorator.ts',
  'ambiguous.ts',
] as const;