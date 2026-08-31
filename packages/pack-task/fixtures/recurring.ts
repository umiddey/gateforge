/**
 * Recurring-job fixture: declares `setInterval(fn, ms, ...)` and
 * `setImmediate(fn, ...)` patterns.
 *
 * The pack's detector should emit:
 *   - task.recurring.tick (framework: 'recurring')
 *   - task.recurring.flush (framework: 'recurring')
 */
import { tick } from './lib/tick.js';
import { flush } from './lib/flush.js';

export const timer = setInterval(tick, 60_000);

export const immediate = setImmediate(flush);