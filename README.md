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

- [Connect your project](packages/cli/guides/CONNECT-YOUR-PROJECT.md)
- [Quickstart](packages/cli/guides/QUICKSTART.md)
- [Test environment](packages/cli/guides/TEST-ENVIRONMENT.md)
- [Upgrade from 0.6 to 0.7](packages/cli/guides/UPGRADE-0.6-to-0.7.md)
- [Changelog](CHANGELOG.md)

## Pick a goal, not a wall of flags

`gateforge init` asks ONE question — what should Gateforge do for you — and
maps the answer to settings:

| Goal | Meaning | Writes |
| --- | --- | --- |
| `light` | show me code nothing has proven yet, block nothing | `mode: warn` |
| `normal` | block a commit that adds untested endpoints or models (about a second) | `mode: changed`, pre-commit hook, CI job |
| `strict` | every push needs a real test run Gateforge watches (the witness) plus a receipt, the signed record of that run | `mode: strict`, staged gate, pre-push receipt check, CI job |

```sh
gateforge init --explain-presets   # print this table
gateforge init --preset normal     # or: light, or strict
```

In a terminal, `gateforge init` asks the goal question instead. With no
terminal and no `--preset` (an AI agent or CI), it writes `light` only and
prints that a human must choose: Gateforge never guesses `normal` or `strict`
for someone who is not there. Existing flags (`--blocking`, `--strict-e2e`,
`--pre-commit`, `--witnessed`, `--mode`) keep working exactly as before and
win over a preset. Re-running `init` never rewrites an existing
`.gateforge.yml`; to change the goal later, edit the `mode:` key.

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

## Agent loop

Blocked agents run `gateforge next` (or `gateforge next --json`): exactly
one blocking next action (`next`/`cause`/`why`/`do`), never a dump. Do the
single `do:` line and stop. New proof tests go in `tests/e2e/gateforge/`
(overlay, engine-driven fixture — wizard creates via surface v2 steps);
existing suite-driven browser tests prove persistence via the Observe
channel once mapped `--kind observed-e2e`. Never rewrite existing
`tests/e2e/**` journeys, never `tests mark` as proof, never edit policies
or waivers to self-approve. `GATEFORGE.md` (written by `gateforge init`)
carries the full loop contract.

## Fix a failing test without a full run

Fixing one failing test changes the candidate, so the run that found it no
longer describes it. When only test code changed, you can re-run just the
affected tests and carry the rest, with `enforcement.reseal: true` in
`.gateforge.yml` (off by default in every mode, on in any mode including
`strict` when you set it):

```sh
gateforge test-gates --changed --scope changed
# only test files changed: re-ran 1 test(s), kept 562 from the previous receipt
```

Gateforge diffs the two sealed trees itself, classifies every changed path
from the runner's catalog and the import graph (test files and test
helpers only; importers of a changed file re-run too, and a dynamic
import with a literal specifier is an ordinary edge), and otherwise falls
back to the plain changed-scope run with one reason line — app code, a
deleted file, a setup-stage test, a computed or unresolvable import.
A whole-suite run that
failed a test seals no receipt, so it leaves a MAC'd run record instead
and the same command re-seals from it. A re-seal is itself a whole-suite
proof, so **consecutive re-seals chain**: fix one test, commit, run; fix
the next, commit, run. Each re-seal's parent is the previous re-seal, the
chain retains every hop's outcomes and each contributing run's witnessed
evidence, and a test no hop re-ran keeps its original proof. The parent is
the previous run **in `.gateforge/test-gates/`** — no CI variable is
involved (`CI_MERGE_REQUEST_DIFF_BASE_SHA` names a merge base, never the
commit the previous pipeline tested, and is ignored), so a CI run must
**persist the state directory between pipelines**, cached by branch; with
a cold cache there is no parent and the run is the ordinary run. The chain
is bounded at five consecutive re-seals — the sixth prints
`test-gates: the run state already retains 5 consecutive re-seals, the bound this path may chain to → changed-scope run`
— and `check --require-e2e` and `broker commit` recompute the whole chain
with their own key before accepting it. See
[`Fix one test without a full run`](packages/cli/guides/TEST-ENVIRONMENT.md#fix-one-test-without-a-full-run)
for the rules, the exact reason lines, and the residual risk.

If your run writes into the workspace — a witnessed login stage saving
its storage state, a runner cache — those gitignored bytes are part of
every sealed tree, so the re-seal refuses on them every time. Declare
them with `enforcement.resealRuntimeFiles` (repo-relative globs, off by
default):

```yaml
enforcement:
  reseal: true
  resealRuntimeFiles:
    - 'e2e/.auth/*.json'
```

A matching path is disregarded only while **neither sealed commit tracks
it**; a committed one is source, and a declaration can never hide a
source change. The run prints
`test-gates: re-seal disregards 2 declared runtime file(s): …`, the
receipt records the list in `resealDisregarded`, and CI recomputes that
exact list or rejects the receipt.

## What the gate catches that ordinary tests can miss

Mocks and passing clicks can miss bugs in the real path:

- A UI request succeeded, but the server response dropped a persisted source fingerprint. The mocked test checked the request only.
- An update control changed only a synchronization timestamp, not the user-editable setting the test claimed to update.
- Two journeys reused a shared tenant fixture, hiding a missing tenant boundary that appeared when the real application handled separate records.

Gateforge connects existing journeys to obligations, then checks witness evidence from the configured run. It complements the test suite; it does not replace it.


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
`http:effect-verified`, `http:read-result-verified`, `auth:*`, and
`validation:*` grade across the approved required cases with witness-issued
`behavior.case` records (configure `behaviorPolicy` and declare cases; a
missing declaration blocks). Unavailable and BLOCKING before evidence is
examined: `http:frontend-request-observed` (no independent browser/test
attribution channel — attribution stays suite-claimed). Fail-closed
namespaces: UI-semantic `crud:*` (use `persistence:*`), `task:*`,
`webhook:*`, and `workflow:*` — an unsupported contract surfaces as
`VERIFIER_UNSUPPORTED` (a setup task for the observer), never as a request
to generate more tests. `init --strict-e2e` preflight rejects setups whose
policies require unavailable proof channels.

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

## Running in CI

A long witnessed run used to be a blank CI screen. The runner log does
carry the app env, the request bodies and the seed credentials, so the
job redirects it to a private file — and then nothing distinguishes a
healthy 45-minute run from a hung one.

`gateforge test-gates` now prints a progress stream of its own:

```
gateforge: run started — 563 tests expected (runner playwright, scope full)
gateforge: ✓ 214/563 Accounts > creates an account
gateforge: ✘ 215/563 Accounts > archives the account — Expected: 200
gateforge: alive — 214/563 done, 3 running, 12m04s elapsed
gateforge: run finished — 561 passed, 1 failed, 1 skipped in 44m05s; grading…
```

It is on automatically under `CI=true` and off everywhere else, so a
local run's output is unchanged. `--progress stderr|file:<path>|off`, and
the `run.progress` config key, say so explicitly; an unusable target is a
usage error, never a silently dropped stream.

**Why it is safe to show.** The stream is built from witness-side facts
only — how many tests were registered before the run, which test the
supervisor has open, its title as declared in the committed catalog, and
its outcome. It never reads, filters, or tails runner output, so no
secret can reach it by construction: a filter over secret text is not
secret-free. The one runtime value it carries is a failing test's first
error line, and that is matched against credential shapes and REPLACED
whole (a prefix of a secret is a secret) — the line becomes
`(message withheld: looks like a secret)`, and a title that itself looks
like a secret is replaced by its own digest. The stream decides nothing:
it is not evidence, no gate reads it, and a write failure is reported
once and then ignored.

**Failing tests in CI.** A red witnessed test used to ship nothing but a
browser snapshot. Its error message and a short `file:line` stack now
land in `.gateforge/test-gates/failures.json`, behind the same guard, so
a job never has to publish the runner log to explain a failure. Request
and response bodies are never included.

**Two numbers, one meaning.** Reports used to print
`repository debt: 192 blocking` next to a gate line that said zero
blockers: both were true and neither was actionable. `repositoryDebt`
now derives its split from ONE definition, the graded verdicts, so
`baselined` and `newlyBlocking` are the same two numbers in the text and
in the JSON, and `newlyBlocking` is exactly what this run's exit code
blocks on. A changed- or named-scope run grades a slice, so debt outside
it is reported in its own words — `not graded by this changed-scope run:
96 blocking obligation(s) — this run never observed them; a full run
grades them` — and never counted as new. A run is never printed twice:
the in-runner reporter grades claims only, so it names no debt count of
its own (`repository debt: graded by gateforge after the run`) instead of
contradicting the CLI's line seconds later. A named or changed run never
verdicts debt it did not observe — the in-runner reporter prints
`GATEFORGE GATE: SELECTION (N satisfied, 0 blocking; repository verdict
not graded here)` instead of contradicting the CLI's exit code.

**A merge-request pipeline with no base commit** used to resolve the
`auto` changed-file provider to the local staged diff — zero changed
files in a CI job, and a gate that failed an hour later on debt nobody
changed. `test-gates --scope changed` and `check --changed` now refuse in
seconds with exit 2 and the fix.

## Gate strictness and flaky tests

The gate is strict by default, and that stays the default: a config
without `mode` behaves exactly as it always has. The owner can soften
the GATE (never the evidence) with `mode: changed` (block only on debt
this change touches; the full debt is still reported) or `mode: warn`
(evaluate and report everything, exit 0, with an additive `wouldBlock`),
and can quarantine an individual flaky test with `gateforge quarantine`
— owner-approved, expiring, never proof, never blocking, always visible
in the report and in `gateforge enforcement doctor`. Both settings live
inside the pinned trusted policy: an agent cannot soften the gate or
quarantine a test to make its own commit pass.

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
  rollout (internal migration record).

## Development

```sh
npm install        # workspaces: packages/*
npm test           # vitest across all packages
npm run build      # tsc build per package
npm run typecheck  # tsc --noEmit per package
```

Node >= 20. TypeScript strict, ESM (NodeNext). Testing policy: retries 0,
no skips on required flows, red-probe proof for gates, deterministic offline
runs. Known deviation: pack-workflow carries 2
skipped cases (a shared-audit e2e flake and a malformed-FSM detector case),
documented in its test files pending fixes.

