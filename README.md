# Gateforge

Gateforge converts recognized source artifacts into explicit, machine-verifiable
test obligations, and makes relevant, passing E2E checks a condition for AI
commits. A source change is detected, classified, and compiled into obligations
that a repository's EXISTING tests must satisfy with trusted, witness-stamped
evidence — not with newly generated plausible tests, labels, unrelated clicks,
or a reused old green report. Unresolved obligations block the gate; every
failure explains which detector found the resource, which policy created the
obligation, and which evidence is missing or invalid.

## Start here

- [CLI README — install and the first commands](packages/cli/README.md)
- [Connect your project](packages/cli/guides/CONNECT-YOUR-PROJECT.md)
- [Quickstart](packages/cli/guides/QUICKSTART.md)
- [Enable behavior cases (QUICKSTART §8a)](packages/cli/guides/QUICKSTART.md#8a-enable-behavior-cases) — what `init` finds, and the printed steps from a detected pack to a green gate
- [Test environment](packages/cli/guides/TEST-ENVIRONMENT.md)
- [Upgrade from 0.8 to 0.9](packages/cli/guides/UPGRADE-0.8-to-0.9.md)
- [Upgrade from 0.7 to 0.8](packages/cli/guides/UPGRADE-0.7-to-0.8.md)
- [Upgrade from 0.6 to 0.7](packages/cli/guides/UPGRADE-0.6-to-0.7.md)
- [Reference — commands, enforcement, protocols, configuration](packages/cli/guides/REFERENCE.md)
- [Changelog](CHANGELOG.md)

Usage documentation — the goal presets, the agent loop, the
supervised run, CI wiring, strictness, and the gate's
limitations — lives with the CLI:
[`packages/cli/README.md`](packages/cli/README.md) and
[`packages/cli/guides/REFERENCE.md`](packages/cli/guides/REFERENCE.md).

## Package map

| Package | Purpose |
|---|---|
| [`packages/core`](packages/core) | `@gate-forge/core` — artifact schemas (zod), GF-canonical-JSON + fingerprints, witness provenance verification, resource graph, policy engine, verdict engine + capability registry, test-catalog/mapping/coverage/receipt schemas, baselines, waivers, quarantines, strictness modes, reports |
| [`packages/plugin-protocol`](packages/plugin-protocol) | `@gate-forge/plugin-protocol` — GPP/3 host (TS) + reference client (py): newline JSON, 8 MiB line cap, digest-checked envelopes |
| [`packages/cli`](packages/cli) | `@gate-forge/cli` — bin `gateforge`: `init`, `next`, `discover`, `classify`, `explain`, `tests discover|catalog|suggest|mark|explain|diagnose`, `obligations`, `check [--changed] [--staged] [--require-e2e]`, `test-gates [--changed]`, `broker commit`, `enforcement doctor`, `baseline update` |
| [`packages/http-contract`](packages/http-contract) | `@gate-forge/http-contract` — canonical HTTP contract facts, typed block codes, deterministic frontend-call ↔ server-route join engine |
| [`packages/pack-sqlalchemy`](packages/pack-sqlalchemy) | `@gate-forge/pack-sqlalchemy` — Python SQLAlchemy detector plugin + TS registration + classification workflow |
| [`packages/pack-fastapi`](packages/pack-fastapi) | `@gate-forge/pack-fastapi` — FastAPI server-route detector (Python AST over GPP/3) |
| [`packages/pack-alembic`](packages/pack-alembic) | `@gate-forge/pack-alembic` — opt-in Alembic migration obligations (lineage, disposable-database roundtrip, data preservation) |
| [`packages/pack-http`](packages/pack-http) | `@gate-forge/pack-http` — TS route-registration detector (Express/Fastify/Hono/NestJS) + bounded frontend API-client dataflow |
| [`packages/pack-playwright`](packages/pack-playwright) | `@gate-forge/pack-playwright` — witness service, attestation proxy, trusted evidence fixture, reporter, test discovery (static + native reconciliation + pytest adapter), supervised runner |
| [`packages/pack-auth`](packages/pack-auth) | `@gate-forge/pack-auth` — auth contract pack (role/tenant/forged-token obligations) + NestJS/Express/Fastify/Hono detector |
| [`packages/pack-workflow`](packages/pack-workflow) | `@gate-forge/pack-workflow` — workflow contract pack (transitions, terminal immutability, audit) + XState/FSM/enum-switch detector |
| [`packages/pack-webhook`](packages/pack-webhook) | `@gate-forge/pack-webhook` — webhook contract pack (HMAC signatures, replay, retry bounds) + detector |
| [`packages/pack-task`](packages/pack-task) | `@gate-forge/pack-task` — task/queue contract pack (idempotency, retries, terminal handling) + BullMQ/Bee-Queue detector |
| [`packages/pack-validation`](packages/pack-validation) | `@gate-forge/pack-validation` — validation contract pack (boundary reject, no side effect on reject) + zod/joi/yup/class-validator detector |
| `example/` | Isolated demo app (plain node http server, accounts CRUD + archive) used by the e2e gate |

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Core engine (schemas, graph, policy, verdict, baselines, waivers, reports) | shipped (commit 3fb49e7) |
| 2 | CLI (`gateforge` bin: check, discover, baseline update, test-gates) | shipped (commit 3fb49e7) |
| 3 | SQLAlchemy CRUD pack | shipped (commit 3fb49e7) |
| 4 | Playwright evidence pack + witness service | shipped (commit 3fb49e7); provenance hardening 2026-08-31 (see below) |
| 5 | ClientZero dogfood migration | blocked on human decisions (out of scope) |
| 6–8 | Five additional contract packs (auth, workflow, webhook, task, validation) | shipped (commit 44b25da) — detectors + example-server integration tests; engine-level grading pending per-pack semantic verifiers |
| 2026-09-25 | Owner-chosen strictness (`mode: strict|changed|warn`, absent = strict) + owner-only, expiring flaky-test quarantine that never proves and never blocks | shipped on branch `plan/strictness-modes` |
| 2026-09-13 | Existing-test reuse + E2E enforcement (`tests` workflow, supervised runs + gate receipts, staged-candidate gate, active hook install, broker mechanism, GitLab strict-gate template) | in-repo work complete — see below; consumer-worktree authoring and server-side GitLab rollout remain owner actions |

**2026-08-31 audit remediation (five rounds).** Evidence trust now rests
on two layers. First, contracts are scoped by what the engine can actually
observe. UI-semantic `crud:*` contracts FAIL CLOSED — the suite owns the
browser, so a claimed UI action can never be independently verified.
Persistence-level `persistence:*` contracts are the gradable surface
(lifecycle-gated like crud): `satisfied` requires a claimed (suite-asserted)
action anchor plus a `persistence.entity` record the witness observed itself
(`origin: 'engine-observed'`) meeting the operation's postcondition, with
expectations that NEVER come from the suite. Second, issuance is AUTHENTICATED:
the witness's manifest append carries a verifier-key HMAC over exactly its own
ledger (pre-seeded forged ids are discarded, never signed) and the live
`GET /ledger-attestation` serves the same authenticated set; the verifier
key travels by environment (never argv — `/proc cmdline` is world-readable)
and `test-gates` strips it from the suite child's env. Without the key, or
when neither authenticated set verifies, witnessed records demote — forged
bundles cannot reach `satisfied` (GF-23). Detector findings (e.g.
`PARSE_ERROR`) and stale references block `gateforge check` and are counted
in report summaries (SARIF surfaces them as tool-execution notifications).
Non-CRUD contracts (auth/workflow/webhook/task/validation) are fail-closed
in the engine — they stay blocking `missing` until each pack ships a
semantic verifier; the packs' current suites exercise their example servers
directly, not the CLI/witness/verdict engine.

**2026-09-13: existing-test reuse + E2E enforcement.** The agent workflow the
engine now serves, end to end:

- **Reuse before creation.** `gateforge tests discover` inventories existing
  tests (static analysis reconciled with native Playwright enumeration;
  configured pytest suites on `--pytest`) into a derived run-state catalog.
  `tests suggest` orders existing candidates per uncovered obligation with
  typed causes (`TEST_MAPPING_MISSING`, `TEST_KIND_UNKNOWN`,
  `TEST_MAPPING_AMBIGUOUS`, `TEST_MAPPING_STALE`). `tests mark` writes an
  agent declaration into the tracked `.gateforge/test-map.yml` sidecar —
  validated against the current catalog and obligation registry, atomic,
  idempotent, contradiction-refusing. Declarations are INTENT, never proof:
  native `{type: 'gateforge', description: '<obligation id>'}` annotations
  and sidecar entries normalize through one resolver, and every claim still
  needs witnessed evidence for the current change. `tests explain` reports
  per-test requirements, mapping origin, execution status, and whether a new
  test is actually needed.
- **Supervised execution and receipts.** `test-gates --changed` is the trusted
  runner supervisor: it fixes the expected test set before the run, executes
  the configured suite through the adapter, enforces planned-vs-executed
  completeness (zero selected tests, skips, `.only`, retries, teardown
  failures, and incomplete shards all fail), and seals an authenticated gate
  receipt only after complete success. `check --require-e2e` (and the
  staged gate) accept only a valid, non-stale receipt for the current input
  digest: missing → `RUN_INCOMPLETE`, different bytes → `EVIDENCE_STALE`,
  forged/tampered → `ENFORCEMENT_UNTRUSTED`. `test-gates --test <selector>
  --result-only` re-checks a handful of hand-picked tests in seconds: it
  executes exactly the named tests where the runner can filter below a
  file, grades only the obligations those tests declare (the rest is
  reported as `not graded in a named run`, never blocked), exits 0 only
  when the whole selection is green and proven, 1 otherwise and 2 for an
  unresolvable selector — and never touches a receipt.
  `test-gates --chaos <seed> --result-only` then makes rare response-order
  races reproducible on purpose: the witness observation proxy releases
  proxied app responses on a schedule derived from the seed — a bounded
  delay, and for requests sharing a route key the option of releasing a
  later response first. Only timing moves, and because the schedule is a
  pure function of the seed, the run that found the race is the run you
  can re-run; the report and the sealed execution result carry the seed
  and the schedule. A chaos run never seals a receipt.
- **Evidence model.** Witness-issued per-test sessions bound every record:
  the trusted reporter opens one session per started test, and each UI action
  runs inside a witness-recorded observation interval, so proxy exchanges
  outside the interval (direct setup calls, stray navigation) never count as
  browser evidence. For a UI-collected mutation the independent persistence
  read must echo the user-entered values exactly on the same entity identity —
  a mismatch fails with `EVIDENCE_VALUE_MISMATCH` even when the status was 2xx.
  The opt-in `coveragePolicy` closes the world over user-facing tables: an
  uncovered, undispositioned table blocks with `CRUD_COVERAGE_MISSING`;
  dispositions are owner acts recorded in trusted configuration (an agent edit
  never self-approves). `tests diagnose` runs the configured pytest suites as
  an ADVISORY alarm (exit 0 completed / 1 failures / 2 incomplete) — pytest
  results are never E2E proof.
- **Enforcement and its honest boundary (ADR 0005).** `init --blocking`
  installs AND verifies an active pre-commit hook that runs
  `check --staged --require-e2e` on the exact staged bytes, plus the GitLab
  strict-gate CI template. Standard mode is honest: `git commit --no-verify`,
  an alternate `core.hooksPath`, direct plumbing, or an unrelated clone bypass
  any local hook — protected history is the server's job (the template carries
  the required settings list). Managed mode puts the authoritative Git
  directory, gate executable, and signing material outside the agent's
  write/process boundary; `gateforge broker commit` ships the MECHANISM
  (verified receipt + compare-and-swap ref update), not the deployment, and
  `enforcement doctor` reports which boundary is actually active.

**Contract capabilities (fail-closed honesty).** Gradable today:
`persistence:create|read|update|delete` (engine-observed same-entity reads +
exact-value echo), the transport-only `http:request-observed` /
`http:response-status-ok` (witness-observed exchange + provenance-verified
claimed UI anchor), and the complete-behavior channel —
`http:effect-verified`, `http:read-result-verified`, `auth:*`,
`validation:*`, `task:*`, `webhook:*` and `workflow:*` grade across
the approved required cases with witness-issued `behavior.case`
records (configure `behaviorPolicy` and declare cases; a missing
declaration blocks). Unavailable and BLOCKING before evidence is
examined: `http:frontend-request-observed` (no independent browser/test
attribution channel — attribution stays suite-claimed). Fail-closed
namespaces: UI-semantic `crud:*` (use `persistence:*`) — a contract
with no semantic verifier surfaces as `VERIFIER_UNSUPPORTED` (a setup
task for the observer), never as a request to generate more tests.
`init --strict-e2e` preflight rejects setups whose policies require
unavailable proof channels.

HTTP endpoint obligations (plan §8 / D1) are honest about transport:
reports say "witness observed an HTTP exchange" and "suite-claimed", never
"browser verified".

An `http.endpoint` owes those observation contracts only when a
`consumed: true` policy matches it, so a new route no UI calls owes
nothing today. The pinned policies document takes one additive option,
`'http.endpoint.requireObservation': all`, that makes every discovered
route owe them; existing routes are forgiven by the adopted baseline
(`gateforge adopt`) and only new ones block with `TEST_MAPPING_MISSING`.
See [`packages/cli/guides/REFERENCE.md`](packages/cli/guides/REFERENCE.md#observation-scope-for-http-endpoints-opt-in-policy-option).

Evidence binds to tested inputs (plan §11, F2): the witness attests a
v2 envelope (`attestationVersion: 2`, domain `gateforge.ledger.v2`)
over its run id, a fresh per-invocation id, a deterministic snapshot
digest of all pipeline inputs (tracked + untracked + ignored-but-
configured files, policies, adapters, plugin modules, lockfiles,
obligations/classifications/routes), and the issued record set. Old
evidence blocks after any source/configuration change; restored old
bundles cannot satisfy new invocations; legacy v1 MACs never
authorize. Existing bundles need a fresh run — nothing signs old
records into the new format. Details and migration notes live in
[`packages/cli/guides/REFERENCE.md`](packages/cli/guides/REFERENCE.md#test-gates-protocol-g6-surface) (test-gates
protocol + Layer 2).

## Development

```sh
npm install        # workspaces: packages/*
npm test           # vitest across all packages
npm run build      # tsc build per package
npm run typecheck  # tsc --noEmit per package
```

Node >= 20. TypeScript strict, ESM (NodeNext). Testing policy: retries 0,
no skips on required flows, red-probe proof for gates, deterministic offline
runs.

Workflow test fixtures boot the real example app in an isolated child on an
OS-assigned loopback port (`listen(0)`) and give every boot its own audit
file, so parallel specs never collide on a port or on an audit log. No
consumer-facing default, port, or audit path changes.

Runner budget: the root config caps outer test-file workers at `maxWorkers: 2`
(`minWorkers: 1`). Each file worker may boot several real browser and runner
children, so a CPU-count-sized outer pool can oversubscribe the CPUs and
starve them. Files still run in parallel, two at a time. This bounds the test
runner only — no consumer-facing default, timeout, or retry changes.
