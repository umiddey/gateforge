/**
 * Decorator fixture: declares exports annotated with `@Task` /
 * `@Queue`. The decorator attaches observability + idempotency hints.
 *
 * The pack's detector should emit:
 *   - task.decorator.decorated (framework: 'decorator')
 */
import { Task, Queue } from './runtime-decorators.js';

@Task({ retryPolicy: { maxAttempts: 4, backoff: 'exponential' }, idempotent: true })
export function archiveRecord(payload: { id: string }): Promise<void> {
  return Promise.resolve();
}

@Queue({ observability: true })
export function ping(payload: { id: string }): Promise<void> {
  return Promise.resolve();
}