# Gateforge

Gateforge converts recognized source artifacts into explicit, machine-verifiable
test obligations, and makes relevant, passing E2E checks a condition for AI
commits. A source change is detected, classified, and compiled into obligations
that a repository's EXISTING tests must satisfy with trusted, witness-stamped
evidence — not with newly generated plausible tests, labels, unrelated clicks,
or a reused old green report. Unresolved obligations block the gate; every
failure explains which detector found the resource, which policy created the
obligation, and which evidence is missing or invalid.

The core flow:

```text
Source change
  -> Detector recognizes a resource
  -> Classifier establishes resource properties
  -> Policy produces test obligations
  -> Existing tests are inventoried, suggested, and declared against
     obligations (`gateforge tests discover|suggest|mark`); a new test is
     the last step for a confirmed behavior gap, never the default
  -> `gateforge test-gates --changed` supervises a complete run of the
     selected existing suite and seals an authenticated gate receipt
  -> `gateforge check --require-e2e` accepts only a valid, non-stale
     receipt for the exact candidate bytes
  -> The pre-commit hook, the commit broker, and the CI gate block
     everything else
```

CRUD coverage is the first proof case, not the final architecture. The broader
product is a user-extensible test-policy compiler: creating or modifying code
artifacts automatically creates auditable testing responsibilities.

## Package map

| Package | Purpose |
|---|---|
| [`packages/core`](packages/core) | `@gateforge/core` — artifact schemas (zod), GF-canonical-JSON + fingerprints, witness provenance verification, resource graph, policy engine, verdict engine + capability registry, test-catalog/mapping/coverage/receipt schemas, baselines, waivers, reports |
| [`packages/plugin-protocol`](packages/plugin-protocol) | `@gateforge/plugin-protocol` — GPP/3 host (TS) + reference client (py): newline JSON, 8 MiB line cap, digest-checked envelopes |
| [`packages/cli`](packages/cli) | `@gateforge/cli` — bin `gateforge`: `init`, `discover`, `classify`, `explain`, `tests discover|suggest|mark|explain|diagnose`, `obligations`, `check [--changed] [--staged] [--require-e2e]`, `test-gates [--changed]`, `broker commit`, `enforcement doctor`, `baseline update` |
| [`packages/http-contract`](packages/http-contract) | `@gateforge/http-contract` — canonical HTTP contract facts, typed block codes, deterministic frontend-call ↔ server-route join engine |
| [`packages/pack-sqlalchemy`](packages/pack-sqlalchemy) | `@gateforge/pack-sqlalchemy` — Python SQLAlchemy detector plugin + TS registration + classification workflow |
| [`packages/pack-fastapi`](packages/pack-fastapi) | `@gateforge/pack-fastapi` — FastAPI server-route detector (Python AST over GPP/3) |
| [`packages/pack-http`](packages/pack-http) | `@gateforge/pack-http` — TS route-registration detector (Express/Fastify/Hono/NestJS) + bounded frontend API-client dataflow |
| [`packages/pack-playwright`](packages/pack-playwright) | `@gateforge/pack-playwright` — witness service, attestation proxy, trusted evidence fixture, reporter, test discovery (static + native reconciliation + pytest adapter), supervised runner |
| [`packages/pack-auth`](packages/pack-auth) | `@gateforge/pack-auth` — auth contract pack (role/tenant/forged-token obligations) + NestJS/Express/Fastify/Hono detector |
| [`packages/pack-workflow`](packages/pack-workflow) | `@gateforge/pack-workflow` — workflow contract pack (transitions, terminal immutability, audit) + XState/FSM/enum-switch detector |
| [`packages/pack-webhook`](packages/pack-webhook) | `@gateforge/pack-webhook` — webhook contract pack (HMAC signatures, replay, retry bounds) + detector |
| [`packages/pack-task`](packages/pack-task) | `@gateforge/pack-task` — task/queue contract pack (idempotency, retries, terminal handling) + BullMQ/Bee-Queue detector |
| [`packages/pack-validation`](packages/pack-validation) | `@gateforge/pack-validation` — validation contract pack (boundary reject, no side effect on reject) + zod/joi/yup/class-validator detector |
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
| 2026-09-13 | Existing-test reuse + E2E enforcement (`tests` workflow, supervised runs + gate receipts, staged-candidate gate, active hook install, broker mechanism, GitLab strict-gate template) | in-repo work complete — see below; consumer-worktree authoring and server-side GitLab rollout remain owner actions ([migration record](docs/plans/immediate/20260913_consumer_migration_record.md)) |

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
  forged/tampered → `ENFORCEMENT_UNTRUSTED`.
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
exact-value echo) and the transport-only `http:request-observed` /
`http:response-status-ok` (witness-observed exchange + provenance-verified
claimed UI anchor). Unavailable and BLOCKING before evidence is examined:
`http:frontend-request-observed` (no independent browser/test attribution
channel — attribution stays suite-claimed). Fail-closed namespaces:
UI-semantic `crud:*` (use `persistence:*`) and all of
`auth:*`/`task:*`/`validation:*`/`webhook:*`/`workflow:*` — an unsupported
contract surfaces as `VERIFIER_UNSUPPORTED` (a setup task for the observer),
never as a request to generate more tests. `init --strict-e2e` preflight
rejects setups whose policies require unavailable proof channels.

HTTP endpoint obligations (plan §8 / D1) are honest about transport:
reports say "witness observed an HTTP exchange" and "suite-claimed", never
"browser verified".

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
[`packages/cli/README.md`](packages/cli/README.md) (test-gates
protocol + Layer 2).

## Known limitations

- Staged candidates containing symlinks or submodules (and unmerged index
  entries) are explicit typed blocks in `check --staged` and the broker —
  not fallbacks; support is not implemented.
- A Playwright config without any NAMED project yields native rows with an
  empty project name that the strict catalog schema rejects as an internal
  error (exit 2) instead of a typed row; the documented consumer shape uses
  named projects, and a typed empty-project row is open work.
- Writing `.gateforge` configuration or `test-map.yml` into the inventoried
  consumer worktree, and the server-side GitLab enforcement settings
  ("Pipelines must succeed", protected branches, pipeline execution policy),
  are pending owner actions — the complete configuration ships from
  `init --blocking`, but a local simulation does not complete a server
  rollout ([migration record](docs/plans/immediate/20260913_consumer_migration_record.md)).

## Development

```sh
npm install        # workspaces: packages/*
npm test           # vitest across all packages
npm run build      # tsc build per package
npm run typecheck  # tsc --noEmit per package
```

Node >= 20. TypeScript strict, ESM (NodeNext). Testing follows
[`docs/testing/TESTING_POLICY.md`](docs/testing/TESTING_POLICY.md) — the
canonical policy: retries 0, no skips on required flows, red-probe proof for
gates, deterministic offline runs. Known deviation: pack-workflow carries 2
skipped cases (a shared-audit e2e flake and a malformed-FSM detector case),
documented in its test files pending fixes.

