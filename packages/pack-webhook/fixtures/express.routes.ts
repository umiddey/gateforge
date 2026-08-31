// Express fixture for pack-webhook detector.
// Two webhook endpoints with different signature hints.

import express from 'express';

const router = express.Router();
router.post('/webhook/stripe/payments', (req, res) => {
  const sig = req.header('x-signature');
  res.json({ ok: true, provider: 'stripe', sigPresent: Boolean(sig) });
});

router.post('/webhook/github/push', (req, res) => {
  const sig = req.header('x-hub-signature-256');
  res.json({ ok: true, provider: 'github', alg: 'sha256' });
});

router.post('/api/billing/invoice', (req, res) => {
  // NOT a webhook — path does not contain webhook/hook/callback
  res.json({ ok: true, kind: 'plain-route' });
});

router.post('/hook/slack/events', (req, res) => {
  res.json({ ok: true, provider: 'slack' });
});

router.post('/callback/partner/order', (req, res) => {
  res.json({ ok: true, provider: 'partner' });
});

export default router;