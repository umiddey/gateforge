// Synthetic Fastify routes used by the detector unit tests.
import { FastifyInstance } from 'fastify';

export function registerRoutes(fastify: FastifyInstance): void {
  fastify.post(
    '/billing/refund',
    { preHandler: [requireRole(['admin', 'manager']), requireTenant()] },
    handler
  );
}