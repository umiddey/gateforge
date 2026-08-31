// Fastify fixture for pack-webhook detector.

import Fastify from 'fastify';

const fastify = Fastify({ logger: false });

fastify.post('/webhook/fastify/payments', async (request, reply) => {
  return { ok: true, provider: 'fastify' };
});

fastify.post('/hook/fastify/push', async (request, reply) => {
  return { ok: true, provider: 'fastify-push' };
});

fastify.get('/webhook/fastify/status', async (request, reply) => {
  return { ok: true, status: 'live' };
});

export default fastify;