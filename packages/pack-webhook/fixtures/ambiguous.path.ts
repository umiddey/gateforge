// Plain file with no webhook-shaped paths — exercises the
// "scanner found nothing" branch (no findings expected, no resources).

import express from 'express';

const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));
app.post('/users', (req, res) => res.json({ ok: true }));

export default app;