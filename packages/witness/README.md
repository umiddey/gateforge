# @gate-forge/witness

The runner-neutral Gateforge witness: the loopback HTTP witness that turns a
test run's traffic into machine-verifiable evidence, plus the contract every
test runner implements to feed it.

## Why this package exists

Gateforge used to only work for Playwright users. The reason was never the
evidence model — it was where the code sat: the witness service and the
per-test session client lived inside a package named after one runner.

The witness is an HTTP proxy plus a DB/queue reader, and a proxy does not care
who sends the traffic. Everything runner-specific collapses into four jobs,
declared by the `RunnerAdapter` contract:

| Job | Method | What a runner must provide |
| --- | --- | --- |
| List | `enumerate()` | The tests, BEFORE the run. The expected set is fixed first. |
| Tag | `childEnv()` | The per-test identity: a session proxy origin or a signed session header. |
| Run | `execute()` | The suite, under trusted supervision with a finite timeout. |
| Read | `parseResults()` | The outcome in a STRUCTURED format (native JSON or JUnit XML) — never terminal colors. |

## The conformance suite

`runRunnerAdapterContract(adapter, host)` is the one suite every adapter must
pass. The suite owns the assertions; a `RunnerContractHost` owns only the
runner mechanics (which files to materialize, how to spawn the runner, where
its report lands). Grading always runs through `superviseExecution` from
`@gate-forge/core` — the same neutral completeness rules a Playwright run is
graded by.

It checks that the adapter:

- enumerates the expected set, and reports a project with **no** tests as
  `unavailable` rather than as an empty successful run;
- tags every session with its own value, and never leaks parent-side wiring
  (the verifier key, the obligations, spool or CI paths) to the runner child;
- reads an unreadable report as incomplete instead of inventing outcomes;
- attributes **nothing** to a test whose runner identity never arrived;
- runs a suite itself (`execute`), not just reports;
- and blocks, with a typed cause, on a failing, skipping, retried, unplanned or
  zero-test run.

## Trust rules (unchanged)

- A runner's own "passed" is never authority. `parseResults` produces reporter
  INPUT; the verdict comes from supervision plus the witness-issued session
  trace.
- A request without a valid session tag is never attributed to a test.
- Additions only: existing JSON keys, cause codes, exit codes, config keys and
  receipts are frozen, and every new setting defaults to today's behavior.

## Adapters

| Runner | Where | Tag channel |
| --- | --- | --- |
| Playwright | `@gate-forge/pack-playwright` (`discovery/playwright-runner-adapter.ts`) | session proxy |
| Cypress | this package (`adapter/cypress.ts`) | session proxy |
| pytest + httpx | this package (`adapter/pytest-httpx.ts`) | session proxy |
| Jest/Vitest + supertest | this package (`adapter/vitest-supertest.ts`) | session proxy |

An in-process test client (supertest, FastAPI `TestClient`) calls the app
without going through the proxy. The adapters REFUSE that mode with a typed
message instead of passing it silently — the request never reaches the witness,
so it can never be evidence.
