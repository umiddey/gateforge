/**
 * BullMQ-style fixture: declares queues with explicit
 * `defaultJobOptions` (attempts + backoff), `.process(handler)`
 * registration, and `jobId`-based idempotency.
 *
 * The pack's detector should emit:
 *   - task.email.send   (idempotencyKey=true, retryPolicy.maxAttempts=5)
 *   - task.billing.refund (no idempotency hint, retryPolicy.maxAttempts=3)
 */
import { Queue } from 'bullmq';

export const emailQueue = new Queue('email.send', {
  connection: { host: 'localhost', port: 6379 },
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
  },
});
emailQueue.process(async (job) => {
  return await sendEmail(job.data.to);
});

export const billingQueue = new Queue('billing.refund', {
  connection: { host: 'localhost', port: 6379 },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 500 },
  },
});
billingQueue.process('refund', async (job) => {
  // Note: NO jobId here — idempotencyKey should be false for this one.
  return await processRefund(job.data.id);
});

async function sendEmail(_to: string): Promise<void> {
  // implementation
}

async function processRefund(_id: string): Promise<void> {
  // implementation
}