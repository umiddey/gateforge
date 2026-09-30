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

The runner-neutral parts live here: the `RunnerAdapter` contract, the
session tagging types, and the conformance suite. Each adapter
implementation lives beside the runner machinery it drives (the shared
collection/report/spool code the supervised run already uses), which is
why the Playwright adapter has always lived in `@gate-forge/pack-playwright`:

| Runner | Where | Tag channel |
| --- | --- | --- |
| Playwright | `@gate-forge/pack-playwright` (`discovery/playwright-runner-adapter.ts`) | session proxy |
| Cypress | `@gate-forge/pack-playwright` (`discovery/cypress-runner-adapter.ts`) | session proxy |
| pytest + httpx | `@gate-forge/pack-playwright` (`discovery/pytest-runner-adapter.ts` + `python/gateforge_pytest_plugin.py`) | session proxy |
| Jest/Vitest + supertest | `@gate-forge/pack-playwright` (`discovery/vitest-runner-adapter.ts`) | session proxy |

An in-process test client (supertest, FastAPI `TestClient`) calls the app
without going through the proxy. The adapters REFUSE that mode with a typed
message instead of passing it silently — the request never reaches the witness,
so it can never be evidence.

## Per-session adapter identity

A per-tenant singleton row (a table whose UNIQUE constraint includes the
tenant scope column) cannot be read from the fixed witness-environment
seat: that seat's tenant already has the row. A test that creates the
tenant first registers that tenant's login for ITS OWN session through
the session-authenticated `POST /sessions/identity` (`seat` plus the
credential `values`, keyed by the same witness env var names the adapter
seat declares). Kit adapters resolve the seat by `ctx.sessionId` first and
the process-global environment seat otherwise.

The whole of its authority is *who the engine reads as, for one session*.
The engine still performs every read; a wrong tenant makes the row unfound
(the app answers 403/404 and the entity grades absent); the identity is
keyed by that session id, cannot be registered for a foreign or ended
session, and is dropped when the session closes or is released; and the
credential never reaches a record, the run state, a log or a report. The
full argument is in `packages/cli/guides/TEST-ENVIRONMENT.md`. Without a
registration the read is byte-identical to today's behavior.

## The operator's fixture/actor provider

A declared behavior case names a `fixture` recipe and an `actor`. The witness
materializes both before it drives the case, through the module named by
`GATEFORGE_FIXTURE_PROVIDER` (loaded by `witness/bin.ts` at startup; a
witness started without one simply has no cases to prepare).

The module's default export is `{ prepare(input), release(leaseId),
resolveCredential(credentialRef) }`. `prepare` returns `{ leaseId, namespace,
subjects, actors }` with SERVER-ISSUED subject identities; `release` drops what
that lease provisioned; `resolveCredential` turns a lease `credentialRef` into
request material and runs in this process, so a secret never leaves it.

The provider is engine-side code and the only caller of its own provisioning
HTTP calls. The suite never imports it, and nothing it returns can mint
evidence — it only supplies the subjects a case drives, so a case's proof still
comes from the request the witness issued and the state it read itself. A
repository should therefore exclude the provider from its product scan scope
(`.gateforge.yml` `project.paths.exclude`, matching
`classification-policy.yml` `scanRoots`), or the engine's own provisioning
traffic is reported as unresolved application call sites. See
`example/behavior/fixtures/fixture-provider.mjs` for a working provider.
