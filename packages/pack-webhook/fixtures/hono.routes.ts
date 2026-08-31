// Hono fixture for pack-webhook detector.

import { Hono } from 'hono';

const app = new Hono();

app.post('/webhook/hono/payments', (c) => {
  return c.json({ ok: true, provider: 'hono' });
});

app.post('/callback/hono/order', (c) => {
  return c.json({ ok: true, provider: 'hono-order' });
});

export default app;