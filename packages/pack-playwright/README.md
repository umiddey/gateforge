# Writing witnessed journeys

A witnessed journey must exercise the real application behavior and verify the result that users depend on. A passing test declaration is not proof: only a valid receipt proves a run, and an adopted baseline forgives previously accepted debt.

## Start from a complete example

`examples/overlay-proof.spec.js` (in this package, so `node_modules/@gate-forge/pack-playwright/examples/overlay-proof.spec.js` in your repo) is a complete overlay proof test: a surface descriptor for a small list/create/edit/archive app, the `gateforge` annotation, and the witnessed `evidence.ui.*` / `visible.confirm` / `http.observe` / `persistence.verify` / `finalize` sequence. Copy it, change the selectors, and the fixture calls stay the same.

## Keep each journey isolated

- Create distinct records and tenant context for every test. Do not reuse a per-tenant singleton across tests; shared state can hide cross-tenant leaks and make outcomes depend on test order.
- Give test data unique identifiers, and clean it up through the same supported application path the test is checking.
- Keep setup independent of Gateforge environment variables so discovery can register the same tests in local and CI runs.

## Observe mutation results without hanging

- Read a mutation response body only when the application returns one. Calling `.json()` on an intentionally empty response waits forever; assert the status and then query the resulting state through the application’s normal read path.
- Check both the submitted value and the persisted value on the same record. A successful HTTP status or click alone does not prove the update happened.
- Prefer a specific response or visible application condition over fixed sleeps and transient loading text.

## Prefer real behavior over mocks

- Use the real server and persistence path when the journey claims a user-facing behavior. A `page.route()` stub can prove client handling, but it cannot show that the server stored the right value or enforced tenant boundaries.
- Keep mock-only tests, but do not treat them as evidence for the real application surface.
- When multiple journeys cover the same obligation, state why each one is needed; avoid copy-pasted tests that compete for shared data.

Run the configured suite with `gateforge test-gates --changed`. For a selected non-authoritative slice, use `gateforge test-gates --changed --scope changed --result-only`; this reports selected results without creating or changing a receipt.
