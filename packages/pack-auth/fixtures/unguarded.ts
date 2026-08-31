// Synthetic unguarded controller: an express route with no requireRole
// or requireTenant — the detector MUST emit nothing for this file.
const router = require('express').Router();

router.get('/health', (_req, res) => res.json({ ok: true }));

module.exports = router;