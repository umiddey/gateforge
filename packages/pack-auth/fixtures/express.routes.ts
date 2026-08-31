import express from 'express';

const app = express();

function adminOnly(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.user.role !== 'admin') {
    res.status(403).send('forbidden');
    return;
  }
  if (req.user.tenantId !== req.params.tenantId) {
    res.status(403).send('cross-tenant');
    return;
  }
  next();
}

app.post('/billing/refund', adminOnly, (req, res) => {
  res.json({ ok: true });
});

app.get('/billing/refund/:id', adminOnly, (req, res) => {
  res.json({ id: req.params.id });
});