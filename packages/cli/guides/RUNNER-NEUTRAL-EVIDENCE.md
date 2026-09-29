# Runners other than Playwright

The witness is an HTTP proxy plus a DB/queue reader. It does not care who
sends the traffic, so the only runner-specific work is three jobs:

1. **List** the tests before the run (the expected set is fixed first).
2. **Tag** every request with the test identity (a per-test session proxy
   origin, or a signed session header).
3. **Read results** from a structured report (native JSON or JUnit XML) —
   never from terminal colors.

Each runner below is a `RunnerAdapter` behind the same contract
(`@gate-forge/witness/adapter`) and is graded by the same conformance
suite: every planned test passes on the first attempt, a failure blocks, a
skip blocks, a runner-assisted retry blocks, an unplanned test blocks, a
zero-test run blocks, and a report row with no runner identity is
attributed to nothing. A runner's own "passed" is never authority.

Additions only: JSON keys, cause codes, exit codes, config keys and receipts
are frozen, and an existing Playwright project sees no change at all.

## In-process test clients are refused

The rule behind all of it: a request that never crosses the session proxy
can never be witnessed. supertest handed the app instance, FastAPI
`TestClient`, or an in-process fetch therefore fails the run with a typed
message instead of passing quietly. Point the client at the app's base URL
under the supervised run and the same test becomes real evidence.

## pytest + httpx

- **Where**: `@gate-forge/pack-playwright` — `discovery/pytest-runner-adapter.ts`
  plus the pack's pytest plugin (`python/gateforge_pytest_plugin.py`).
- **Enumerate**: the configured suite argv with `--collect-only -q`. The
  expected set is the collection result, before anything runs.
- **Tag**: the plugin opens a witness session per test and routes the
  test's `httpx` client through that test's session proxy origin.
- **Read**: strict JUnit XML. A case without its file attribute is never
  attributed to a test, and a duplicated case (a rerun) is reported as a
  runner-assisted retry.
- **Use it**: configure the suite with `witnessed: true` and load the
  plugin through `PYTHONPATH` (the adapter does this for you). Drive the
  app over HTTP (`await client.post(f"{base_url}/...")`) — a
  `TestClient(app)` call is refused.

## Jest/Vitest + supertest

- **Where**: `@gate-forge/pack-playwright` — `discovery/vitest-runner-adapter.ts`,
  the reporter at `src/vitest/reporter.ts`, the in-test helper exported as
  `@gate-forge/pack-playwright/vitest`.
- **Enumerate**: the project's own `vitest list --run --json`, so the
  expected set comes from the runner that will execute it.
- **Tag**: the pack's reporter spools the same lifecycle events the
  Playwright reporter writes, and the in-test helper resolves the
  supervisor session for the RUNNING test and rewrites supertest traffic
  onto that session's proxy origin.
- **Read**: the jest-compatible JSON report, strictly. A row with no
  file/title identity is never attributed, and the reporter's flags
  document surfaces `test.retry` attempts (required retries are zero).
- **Use it**:
  ```js
  import request from 'supertest';
  import { gateforgeSupertest } from '@gate-forge/pack-playwright/vitest';
  const gate = gateforgeSupertest(request);

  test('creates an account', async () => {
    const api = await gate(process.env.GATEFORGE_APP_BASE_URL);
    const response = await api.post('/api/accounts').send({ first_name: 'Grace' });
    expect(response.status).toBe(201);
  });
  ```
  `gate(app)` with the app itself (in-process supertest) is REFUSED with
  `IN_PROCESS_CLIENT_REFUSED` — it would be a counterfeit green.

## Cypress

- **Where**: `@gate-forge/pack-playwright` — `discovery/cypress-runner-adapter.ts`,
  the plugin at `src/cypress/plugin.ts`, plus the support file the adapter
  generates per run.
- **Enumerate**: Cypress cannot list tests without running them, so the
  expected set is read from the spec SOURCES. A spec whose titles are not
  static string literals enumerates as unavailable — the adapter refuses to
  guess a half-set rather than run against an incomplete expectation.
- **Tag**: the adapter runs the project's own Cypress CLI with a generated
  config that chains your config (`setupNodeEvents` included). The pack's
  plugin registers lifecycle tasks; the generated support file resolves the
  session for the running test and rewrites `cy.request` traffic at the app
  origin onto that session's proxy. Traffic that does not go through it — a
  raw browser `fetch`, a third-party origin — stays unattributed and is
  credited to nothing.
- **Read**: mocha's own `after:run` results, sealed into a per-run report.
  More than one attempt for a test is a runner-assisted retry and blocks.
- **Use it**: nothing to import. Run your specs as usual with
  `cy.request` for app traffic; `cy.request` at the app origin is tagged
  automatically under the supervised run. A CommonJS project config
  (`cypress.config.js`/`.cjs`) is chained; an ESM/TypeScript config is
  refused rather than silently replaced.

## Running a non-Playwright runner

Set the runner in `.gateforge.yml` and the ordinary commands drive it:

```yaml
runner: vitest   # playwright (the default) | pytest | vitest | cypress
```

- `gateforge init` — scans the repository and writes `runner:` into a NEW
  config when it sees exactly one non-Playwright runner. An ambiguous
  repository (Playwright plus something else, or several others) keeps the
  default and tells you to set the key yourself. An existing config is never
  rewritten.
- `gateforge doctor` — reports runner readiness without launching anything:
  for `vitest`/`cypress`, the runner's config file at the repository root and
  an installed package; for `pytest`, a configured `diagnostics.suites` entry
  and a `pytest` executable on `PATH`.
- `gateforge test-gates --changed` — runs the mapped selection under the
  configured runner and seals the receipt.
- `gateforge check --changed --require-e2e` — the gate; `receipt-verified`
  means the obligation was witnessed, not that the runner went green.

### Per-runner setup

**pytest** — one suite under `diagnostics.suites`, and HTTP over the plugin's
client:

```yaml
diagnostics:
  suites:
    - name: accounts
      runner: pytest
      cwd: .
      argv: ['python', '-m', 'pytest']
      testPaths: ['tests']
      witnessed: true
```

`witnessed: true` keeps the suite out of the advisory diagnostic window: the
adapter's supervised execution IS that suite, so a second pass would run it
twice. The plugin (loaded automatically through `PYTHONPATH`) provides the
`gateforge_http` fixture — an `httpx.Client` routed through the running
test's session proxy:

```python
def test_creates_account(gateforge_http):
    response = gateforge_http.post('/api/accounts', json={'first_name': 'Grace'})
    assert response.status_code == 201
```

`TestClient(app)` never reaches the witness and is refused.

**vitest** — route supertest through the helper:

```js
import request from 'supertest';
import { gateforgeSupertest } from '@gate-forge/pack-playwright/vitest';
const gate = gateforgeSupertest(request);

test('creates an account', async () => {
  const api = await gate(process.env.GATEFORGE_APP_BASE_URL);
  expect((await api.post('/api/accounts').send({ first_name: 'Grace' })).status).toBe(201);
});
```

`request(app)` — in-process supertest — is refused with
`IN_PROCESS_CLIENT_REFUSED`.

**cypress** — nothing to import. Keep a CommonJS project config
(`cypress.config.js`/`.cjs`); an ESM/TypeScript config is refused rather than
silently replaced. Send app traffic with `cy.request` at the app origin and it
is tagged for the running test. A raw browser `fetch` is not credited, because
it never crosses the session proxy. The adapter pins the run's screenshot,
video and download folders into the run state directory, so a failing test
cannot drop artifacts into your tree.

### Mapping keys

In `.gateforge/test-map.yml` a non-Playwright test's `key` is
`<file>#<titlePath joined by '>'>` — the same identity the adapter reports:

```yaml
tests:
  - key: tests/accounts.test.ts#accounts>creates an account
    selector:
      runner: vitest
      file: tests/accounts.test.ts
      titlePath: [accounts, creates an account]
    kind: observed-e2e
    claims: [tenant.accounts:persistence:create]
    reason: The test creates an account over HTTP and the witness confirms persistence.
```

Selection granularity follows the runner: the FILE for vitest and Cypress
(one spec file executes, so a partial selection is a whole file), the pytest
NODE id for pytest. The verdict always comes from supervision over the
enumerated plan, never from the runner's exit code.
