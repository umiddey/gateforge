# tests/e2e/gateforge/ — overlay proof tests

Thin engine-driven tests that prove persistence obligations. They use the
Gateforge Playwright fixture (`evidence.ui.*` + `persistence.verify`)
with a surface map — they do NOT rewrite existing journeys.

- New proof tests go here: `tests/e2e/gateforge/<resource>.<op>.spec.js`.
- Do not rewrite existing `tests/e2e/**` journeys into `evidence.ui`.
- Do not use `gateforge tests mark` as proof: mappings are intent, not proof.
- Fixture shape: `example/e2e/accounts-crud-journey.spec.js` in the
  gateforge monorepo and the `@gate-forge/pack-playwright` README.
