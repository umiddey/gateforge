import { Hono } from 'hono';

const app = new Hono();

const adminOnly = async (c: any, next: any) => {
  const user = c.get('user');
  if (user.role !== 'admin') {
    return c.text('forbidden', 403);
  }
  await next();
};

app.post('/billing/refund', adminOnly, (c) => c.json({ ok: true }));
app.get('/billing/refund/:id', adminOnly, (c) => c.json({ id: c.req.param('id') }));