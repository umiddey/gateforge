import Fastify from 'fastify';

const fastify = Fastify();

async function adminPreHandler(request: any, reply: any) {
  if (request.user.role !== 'admin') {
    reply.code(403).send({ error: 'forbidden' });
    return;
  }
  if (request.user.tenantId !== request.body.tenantId) {
    reply.code(403).send({ error: 'cross-tenant' });
    return;
  }
}

fastify.post(
  '/billing/refund',
  { preHandler: adminPreHandler },
  async (request, reply) => {
    return { ok: true };
  },
);

fastify.get(
  '/billing/refund/:id',
  { preHandler: adminPreHandler },
  async (request, reply) => {
    return { id: (request.params as any).id };
  },
);