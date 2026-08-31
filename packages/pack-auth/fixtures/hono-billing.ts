// Synthetic Hono routes used by the detector unit tests.
import { Hono } from 'hono';

const app = new Hono();

app.post(
  '/billing/refund',
  requireRole('admin'),
  requireTenant(),
  (c) => c.json({ ok: true })
);

export default app;