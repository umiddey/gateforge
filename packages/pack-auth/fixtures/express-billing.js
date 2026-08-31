// Synthetic Express router used by the detector unit tests.
const express = require('express');
const router = express.Router();

router.post(
  '/billing/refund',
  requireRole('admin'),
  requireTenant(),
  handler
);

module.exports = router;