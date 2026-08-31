/**
 * Ambiguous fixture: a `register('name', ...)` call WITHOUT a handler
 * reference. The detector must emit an `AMBIGUOUS_HANDLER` finding
 * alongside the resource.
 *
 * The pack's detector should emit:
 *   - task.audit.flush (with AMBIGUOUS_HANDLER finding attached)
 */
import { register } from './custom-queue-runtime.js';

// Note: no handler fn in the second positional arg — the detector
// cannot statically resolve the handler reference.
export const flushHandle = register('audit.flush');