/**
 * Custom-queue fixture: demonstrates the two patterns the detector
 * recognises — `register('name', handler)` and
 * `new CustomQueue({ name, handler })`.
 *
 * The pack's detector should emit:
 *   - task.webhook.dispatch (custom-queue, hasHandler=true)
 *   - task.index.reindex (custom-queue, hasHandler=true)
 */
import { register, CustomQueue } from './custom-queue-runtime.js';

export const dispatchHandle = register('webhook.dispatch', async (job: { url: string }) => {
  return await fetch(job.url);
});

export const reindexQueue = new CustomQueue({
  name: 'index.reindex',
  handler: async (job: { id: string }) => {
    return await reindex(job.id);
  },
  terminalOn: ['AuthError', 'ValidationError'],
  observability: true,
});

async function reindex(_id: string): Promise<void> {
  // implementation
}