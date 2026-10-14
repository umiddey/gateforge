# tests/e2e/gateforge/ — overlay proof tests

Thin engine-driven tests that prove persistence obligations. They use the
Gateforge Playwright fixture (`evidence.ui.*` + `persistence.verify`)
with a surface map — they do NOT rewrite existing journeys.

- New proof tests go here: `tests/e2e/gateforge/<resource>.<op>.spec.js`.
- Do not rewrite existing `tests/e2e/**` journeys into `evidence.ui`.
- Do not use `gateforge tests mark` as proof: mappings are intent, not proof.
- Fixture shape: `node_modules/@gate-forge/pack-playwright/examples/overlay-proof.spec.js`
  (a complete, runnable proof test shipped with the pack you installed —
  copy it here and change the surface). Journey-writing rules:
  `node_modules/@gate-forge/pack-playwright/README.md`.
