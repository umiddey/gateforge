/**
 * Bee-Queue fixture: declares a `new Bee('image.resize', ...)` queue
 * with `.process(handler)` registration.
 *
 * The pack's detector should emit:
 *   - task.image.resize (framework: 'bee-queue')
 */
import Bee from 'bee-queue';

export const imageQueue = new Bee('image.resize', {
  redis: { host: 'localhost', port: 6379 },
});
imageQueue.process(async (job) => {
  return await resizeImage(job.data.url);
});

async function resizeImage(_url: string): Promise<void> {
  // implementation
}