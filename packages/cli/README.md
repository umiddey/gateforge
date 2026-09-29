# @gate-forge/cli

The gateforge command-line interface: initialize a project, discover
resources and classification signals, inspect automatic decisions, reuse a
repository's existing tests, evaluate obligations, run the supervised E2E
gate, enforce the exact staged candidate, and maintain baselines.
**0.7.0 vs. published 0.6.3:** external key ring, owner-approved docs exclusions, result-only runs, surface-doctor, protocol-based package-compatibility guard, diagnostic context, trusted `baseURL`/`storageState`, and the shared-dist spool race fix.

## Start here

- [Quickstart](guides/QUICKSTART.md)
- [Test environment](guides/TEST-ENVIRONMENT.md)
- [Upgrade from 0.6 to 0.7](guides/UPGRADE-0.6-to-0.7.md)
- [Runners other than Playwright](guides/RUNNER-NEUTRAL-EVIDENCE.md)

Also at https://github.com/umiddey/gateforge/tree/main/packages/cli/guides.

Just added a new table or endpoint and the gate is blocking? Run
`gateforge next` (or `gateforge next --json`) — it prints the ONE blocking
next action. New proof tests go in `tests/e2e/gateforge/` (overlay);
never rewrite existing journeys, never `tests mark` as proof.

## Proof paths

- **Overlay (default).** New thin tests in `tests/e2e/gateforge/` using
  the engine-driven fixture (`evidence.ui.*` + `persistence.verify`).
  Strongest: the engine types the form itself. `gateforge init`
  scaffolds the directory README. Multi-screen creates use surface v2
  wizard steps (`create.steps[]`; see `example/e2e/vendor-wizard-surface.js`).
  Surface v3 adds card support through row-relative `idLocator` and
  `fieldLocators`; existing cell-index descriptors remain valid. Non-UI
  evidence tests do not need a surface descriptor.
- **Observe (`--proof observe`).** Existing suite-driven Playwright
  tests keep driving `page`; the witness watches their session-proxy
  traffic and reads state itself through the adapter. Map them
  `--kind observed-e2e`. Weaker than overlay by design: proves
  persistence ("the server stored what the proxied request sent"), not
  "the engine typed the form". Requires the Playwright `baseURL` on
  the session proxy plus per-adapter `observe` bindings and `list()`.
  `crud:*` contracts stay engine-browser-only.
- **`tests mark` is intent, never proof.** A mapped test with no
  witnessed evidence grades `EVIDENCE_NOT_COLLECTED` — blocking.

## What the gate catches that green mocks do not

- A test can intercept a request and return a complete response while the
  real server drops a field. A mocked-only test is not evidence that the
  server sends it.
- A UI action can look successful while the witness sees only a timestamp
  change; an update obligation still needs a change to a classified
  updateable field.
- A mocked route can hide a handler that never receives real traffic. The
  gate needs a witnessed request and the resulting state, not a mock's
  answer.

## Commands

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `gateforge init [--preset light\|normal\|strict] [--explain-presets] [--languages <comma,list>] [--plugins <comma,list>] [--accept-recommended] [--no-scan] [--proof overlay\|observe] [--blocking] [--no-blocking] [--pre-commit] [--no-pre-commit] [--ci] [--no-ci] [--planes] [--no-planes] [--strict-e2e] [--docs-exclude <folder,...>] [--confirm-doc-exclusions]` | Scan the repo (heuristics, no network), print the recommended install (plugins, persistence policy, transport-only HTTP policy for consumed endpoints, overlay proof), and write the standard Gateforge scaffold. Idempotent — never overwrites existing files unless `--confirm-doc-exclusions` approves an exclusion update. `pack-task` is opt-in only (`--plugins`); `--proof observe` skips the overlay scaffold and prints the observe wiring checklist instead. Default language: `python`. `--preset` applies one goal in one step (`light` -> `mode: warn`, no hooks; `normal` -> `mode: changed` + pre-commit hook + CI job; `strict` -> `mode: strict` + staged gate + pre-push receipt check + CI job) and prints what it wrote plus an `undo:` line; `--explain-presets` prints that mapping and writes nothing. In a terminal init asks the same question instead; with no terminal and no `--preset` it writes `light` only and says so on one line with the `--preset` flag that changes it. The negative forms (`--no-blocking`, `--no-pre-commit`, `--no-ci`, `--no-planes`) answer the matching question without a prompt. A preset never writes a waiver, an adopted baseline or a plane rule, and an existing `.gateforge.yml` is never rewritten. `--strict-e2e` writes the `enforcement` block and refuses unavailable required proof channels. | 0/1/2 |



| `gateforge next [--changed] [--json]` | Print the ONE blocking next action (`next`/`cause`/`why`/`do`; `--json` adds `remainingBlocking` and route-specific `guidance` when relevant). For an endpoint with no plane, ask which boundary owns its data and show the owner-reviewed choices; internality remains owner-only. Navigation, not the gate: never requires an E2E receipt. Exit 0 clean, 1 next action, 2 config/usage. | 0/1/2 |
| `gateforge discover [--json]` | Run every configured detector over the expanded `project.paths` and dump the resource graph (default: human listing; `--json`: GF-canonical JSON). | 0 |
| `gateforge classify [--json] [--write-snapshot <path>]` | Recompute effective classifications from detector signals and print decisions, traces, and typed blocks. `classify plane` previews or explicitly appends an owner-reviewed endpoint plane rule to the existing `.gateforge/planes.json`; snapshots are derived review artifacts and never pipeline input. | 0/1/2 |
| `gateforge explain <resourceId> [--json]` | Show one resource's detector signals, classification rules, decision fingerprint, typed blocks, and generated obligations. | 0/1/2 |
| `gateforge tests discover [--json] [--pytest]` | Inventory existing tests into the derived run-state catalog: static analysis reconciled with native Playwright enumeration (`--list`). Unresolved wrappers, parse errors, and inventory gaps are DATA (never an empty catalog — failed native enumeration is exit 2). `--pytest` additionally collects the configured diagnostic suites' node ids (`--collect-only`). Playwright enumeration runs ONE config (a repo-root config wins; otherwise the alphabetically first config one directory deep), and when the repo holds more than one the runner line names every config, the one used, why, and the ones NOT inventoried. `inventoryComplete=false` means a reconciliation gap (an enumerated-vs-static mismatch, an unresolved case, or a not-inventoried extra config), not a partial success. | 0/2 |
| `gateforge tests suggest [--changed] [--json]` | Resolve mappings for the run's obligations and produce reuse-ordered existing-test candidates with typed causes (`TEST_MAPPING_MISSING` / `TEST_KIND_UNKNOWN` / `TEST_MAPPING_AMBIGUOUS` / `TEST_MAPPING_STALE`). When Playwright reports load errors and enumerates no tests, report one `TEST_INVENTORY_INCOMPLETE` with the error count and first error instead of stale-mapping fan-out; the action is to install the missing dependency and rerun Gateforge. An inspection surface, NOT a gate: exit 0 even with blocking problems. | 0/2 |
| `gateforge tests mark --test <key> --kind <kind> [--category <c>]... --obligation <id>... --reason "<text>"` | Declare an existing test in `.gateforge/test-map.yml` (see the test-reuse workflow below). Validates against the CURRENT catalog and obligation registry, writes atomically and idempotently, prints the exact diff. Never edits test files, never adds waivers, refuses contradictions. | 0/2 |
| `gateforge tests sync [--json]` | AST-only scan of test annotations; updates generated `source: annotation` entries in `.gateforge/test-map.yml` and leaves handwritten entries unchanged. Reports unresolved helpers with source locations; does not run tests. | 0/1/2 |
| `gateforge tests explain --test <key> [--json]` | Per-test report: requirements, existing-test identity, mapping origin, honest execution status, next action, `New test needed`. | 0/2 (unknown key → 2) |
| `gateforge tests diagnose [--suite <name>] [--json]` | Run the configured pytest diagnostic suites once per suite, isolated (own process, `GATEFORGE_*` stripped, finite timeout). Advisory: exit 0 completed run (≥1 pass, no unexpected failures), 1 test failures, 2 unavailable/incomplete (collection error, timeout, missing interpreter, interruption, zero tests, or only skipped/xfail). Never E2E proof. | 0/1/2 |
| `gateforge obligations [--json]` | Evaluate policies against the automatically classified graph and dump obligations, blocking entries, and claim assessments. | 0/1/2 |
| `gateforge check [--changed] [--staged] [--candidate-commit <sha>] [--require-e2e] [--timing] [--no-cache] [--format text\|json\|sarif]` | The full gate: discover → classify → obligations → claims → verdicts → report. `--timing` appends per-step wall-clock timings (detectors, test collection, TS scan, planning, total) — an additive report key in json and one line in text, never an input to any verdict. Detector and pytest-collection results are cached under the excluded run-state dir. Detector keys include plugin config, executable module/script bytes, Python import environment, inputs, interpreter packages, and Gateforge engine version; pytest keys include all Python/config file bytes, collector argv/environment, interpreter identity, and engine version. Unchanged successful pytest collections reuse their node ids; any changed Python byte recollects. Any uncertainty runs fresh. The report carries additive `cache: {hits, misses}` counts. `--no-cache` (or `GATEFORGE_NO_CACHE=1`, or a CI environment) disables cache reads and writes. | 0 clean/waived, 1 unresolved, 2 config/usage error |

| `gateforge test-gates [--changed] [--scope full\|changed] [--progress stderr\|file:<path>\|off] [--result-only] [--suite <cmd>] [--out <dir>] [--format F] [--witness-url <url>] [--run-token <token>]` | The progress stream (additive, `--progress`, or the `run.progress` config key) prints the registered expected-set size, one line per finished test with exact `N/M` counters and the catalog title, an alive line per quiet minute, and the finish line before grading. It is built from witness-side facts only and never from runner output; a failing test's first error line passes a credential guard and is replaced whole when it matches, and the full guarded diagnosis lands in `.gateforge/test-gates/failures.json`. `auto` (the default) is stderr under `CI=true` and off locally. The stream is not evidence and no gate reads it. Supervised `--changed` plans and runs mapped Playwright tests through the trusted adapter, checks planned/executed completeness, and seals an authenticated receipt only after complete success. `--scope changed` limits a sealed slice to obligations affected by changed files; incomplete mappings block, and `check --require-e2e` accepts it only when it covers every currently changed obligation. `--result-only` requires `--changed --scope changed`, reports selected results plus repository debt, and has no gate authority: without an external witness it uses private temporary state; with `--witness-url` it requires `--out` + `--run-token` shared with the external witness in a separate state directory (not the configured authoritative state directory). It never creates or clears a receipt. `--suite` remains legacy and cannot combine with `--changed` or redefine strict expected cases. Verifier keys use `GATEFORGE_WITNESS_VERIFIER_KEY` or the external key ring selected by `GATEFORGE_WITNESS_VERIFIER_KEY_FILE`. | 0/1/2 (suite failure forces 1) |
| `gateforge broker commit --workspace <dir> --message <msg> [--receipt <path>] [--ref <ref>]` | Managed-mode commit broker (MECHANISM, not deployment): snapshots the workspace bytes into a throwaway index, recomputes the input + trusted-policy digests, verifies a valid non-stale gate receipt for EXACTLY those bytes, then creates the commit via compare-and-swap `git update-ref`. Typed rejections (`ENFORCEMENT_UNTRUSTED` / `EVIDENCE_STALE` / `RUN_INCOMPLETE` / `KEY_UNKNOWN` / `BROKER_CAS_MISMATCH` / `BROKER_UNSAFE_MESSAGE`); symlinks/submodules are typed rejections. Verifier keys use either supported environment source; the key file must be outside authority, workspace, and receipt artifact roots. | 0/2 |
| `gateforge key create|import-env|rotate|retire [--file <path>] --confirm` | Owner-only key ceremony. Defaults to the external XDG key ring; creates, imports, rotates, or retires keys without printing secrets. | 0/2 |
| `gateforge pre-commit --scope staged\|full` | The witnessed commit gate: freezes the Git index, materializes it into a scratch checkout, prepares the candidate's staged runtime (`.gateforge/runtime.yml` — below), runs the supervised witness gate INSIDE that checkout (`staged`: only tests mapped to obligations affected by the staged paths, `EVIDENCE_SCOPE_INCOMPLETE` blocks an unmapped affected obligation; `full`: the complete relevant mapped suite), validates the fresh receipt against the same checkout, rechecks the original index/HEAD/MERGE_HEAD, and copies only Gateforge audit artifacts (run state incl. runtime logs) back. Runtime preparation/readiness failures are typed (`RUNTIME_PREPARATION_FAILED` / `RUNTIME_READINESS_FAILED`); child process groups are cleaned up on every exit path. Install via `gateforge init --blocking --witnessed staged\|full`. | 0/1/2 |
| `gateforge enforcement doctor [--json]` | Reports verified enforcement `level` (0–3), hook activation, wired CI templates, and read-only GitHub/GitLab branch-protection results; missing credentials or uncertain responses remain `not verified`. A local hook never counts as server protection. Its `engine:` line reports the install provenance npm's own metadata proves: a tarball/directory install (read from `node_modules/.package-lock.json`, or the manifest's `_resolved`) is named as such instead of claiming the registry, and an install with no readable metadata is reported as unproven rather than as an all-clear. The receipt's `engine.source` is receipt-bound and keeps its meaning. Diagnostic only: exit 0 whenever it runs. | 0/2 |
| `gateforge enforce [--ci github\|gitlab]` | Add blocking wiring to an initialized repository. The provider defaults to GitLab unless GitHub is the only detected CI provider; the explicit flag selects GitHub Actions or GitLab CI. Appending to an EXISTING `.pre-commit-config.yaml` is announced as an action on one line, naming the file as the repository's own and printing the exact way back (`git restore -- .pre-commit-config.yaml` for a tracked file; for an untracked one, which has nothing to restore, the line says to delete the appended entry). The generated GitHub workflow installs `@gate-forge/cli@<version>` from the registry unless `GATEFORGE_CI_ENGINE_SOURCE` is set when the generator runs: it then installs that one npm specifier (a `.tgz` path, a directory, or any specifier) through the step environment, for a release that is not on the registry. Unset the variable and rerun for the registry install. | 0/2 |
| `gateforge baseline update <fp...>` | Shrink the baseline to a strict subset (invariant 4). | 0/2 |
| `gateforge baseline diff <before> <after>` | Compare adopted obligations by ID without printing fingerprints. | 0/2 |

On a repo that already has Gateforge files, `init` reports only what THAT run did: it keeps an existing `.gateforge.yml` and says so instead of claiming to write a preset, and the `undo:` line it prints names only the paths the run created (it prints no undo line when it created nothing) — so following it can never delete pre-existing config, baselines, waivers, hooks or CI files. A preset that wires no local hook says whether your existing commit hook and/or CI job still decide what blocks your commits.

The cache is disabled by `--no-cache`, `GATEFORGE_NO_CACHE=1`, or recognized CI-provider markers (`GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD`). A bare `CI=true` does not disable it.

Global flags: `--help`, `--version`. Exit codes per architecture contract 4:
`0` clean/waived, `1` unresolved obligations (or a failed/supervision-blocked
run), `2` config/usage error. `tests diagnose` has its own advisory contract
(0/1/2 above).

### Result-only with an external witness

Start the witness with a dedicated state directory, then pass that same
directory and its run token to `test-gates`. The directory must be separate
from the configured authoritative `.gateforge/test-gates` directory:

```sh
gateforge test-gates --changed --scope changed --result-only \
  --witness-url "$GATEFORGE_WITNESS_URL" \
  --out "$GATEFORGE_STATE_DIR" \
  --run-token "$GATEFORGE_RUN_TOKEN"
```

`test-gates` claim planning reads current Playwright annotations using a
disposable `GATEFORGE_STATE_DIR`, plus the tracked `test-map.yml`. It never
treats a previous run's `claims.json` as a declaration source.

The report remains `authority: non-authoritative`. The external-witness
state may contain this run's report and attestation, but this command never
creates, replaces, or clears a gate receipt. Pre-commit, hook, and CI gate
paths remain authoritative and do not accept `--result-only`.

### Re-check one failing test in seconds (`--test`)

To re-confirm a handful of hand-picked tests you do not need a whole
suite. `--test` names them, and the run is witnessed exactly like a full
gate run — the same supervisor, the same run token, the same server-side
evidence:

```sh
# one test (a logical key, or any unique substring of one)
gateforge test-gates --test 'backend/tests/test_x.py::test_commits' --result-only

# several at once — --test is repeatable
gateforge test-gates --test UC-53 --test UC-51 --result-only
```

`--test` is accepted **only** together with `--result-only`. A
hand-picked list never seals a receipt, so combining `--test` with a
sealing run exits 2 and says so. The named run never reads, writes, or
clears a gate receipt, so `check --require-e2e` is unaffected, and it
carries `authority: non-authoritative` plus `outcome: partial-selection`
in the report.

A selector is resolved against the **planned** rows — the expected set
fixed before the run — never against raw runner output, so it can only
name a test the gate already planned. An exact logical key always wins;
otherwise a unique case-insensitive substring is used. An unknown or
ambiguous selector exits 2 and lists the candidate logical keys, because
a narrower selection is never guessed:

```sh
$ gateforge test-gates --test 'session proxy' --result-only
gateforge: the selector 'session proxy' matches 2 planned tests — pick one exact logical key. Run `gateforge tests discover --json`. [TEST_SELECTOR_AMBIGUOUS]
candidate logical keys:
  - tests/green.test.mjs#creates account through the session proxy
  - tests/second.test.mjs#creates the billing account through the session proxy
```

The report gains an additive `selectors` field naming exactly what each
selector resolved to, and the run uses the `named-selection` selection
mode, so it can never collide with a full or a diff-linked slice:

```json
{ "outcome": "partial-selection", "selectors": [{ "selector": "UC-53", "logicalKeys": ["pytest:backend/tests/test_x.py::test_commits"] }] }
```

Selection works for every runner (Playwright, pytest, vitest, Cypress)
through the shared runner-adapter contract. Because it works from the
plan, it does not need the changed-file set — that is why `--test` is
useful when a fix touches a `.env`, a fixture, or a helper that no test
links to.

Each runner narrows to the named tests as far as it honestly can:
Playwright, pytest and vitest receive the exact `file:line` / node id /
anchored test name, so a named test never drags its file neighbours
along. Cypress cannot filter below the spec without a plugin the gate
refuses to trust, so it executes the whole spec, drops every unselected
outcome and session (an unselected test never becomes evidence), and
says `also ran N other test(s) in the same file — not graded`.

#### What a named run grades, and its exit codes

A named run grades **only the selection**: the obligations its selected
tests declare through the sidecar or native annotations. Everything else
— repository-wide policy, mapping and inventory findings, the coverage
policy — is still reported, under `repositoryDebt` and as
`not graded in a named run: N obligation(s)`, but never blocks: the run
never observed it. What still blocks is everything about the run itself
(supervision findings, lifecycle conflicts, intent failures, the witness
channel, evidence-context failures) and any finding that names a graded
obligation. The report and the diagnostic context both carry
`scope: "named"`, and the execution summary keeps the whole-repository
counts next to the selection's own.

| Exit | Meaning |
| --- | --- |
| `0` | every selected test passed and every obligation it declares is satisfied (or waived by the owner), with a complete run and no run-execution finding |
| `1` | anything else: a red selected test, an unproven graded obligation, an incomplete run, changed inputs, or a workspace that moved during the run |
| `2` | the selector could not be resolved (unknown or ambiguous) — nothing ran |

A named run never carries gate authority: it is `--result-only` only,
never creates, replaces or clears a receipt, and `check --require-e2e`
keeps reading the seal the authoritative run left. A run without
`--test` is unaffected by any of this.

## Staged runtime (`.gateforge/runtime.yml`)

`gateforge pre-commit` executes the candidate inside a materialized checkout
that contains TRACKED bytes only — no installed dependencies, no built
assets, no application processes. The reviewed staged-runtime document
declares how that checkout becomes a runnable candidate. It is
security-sensitive: its bytes are hashed into the trusted policy digest and
the authenticated input snapshot, so a candidate that edits its own runtime
commands cannot approve the edit in the same commit.

```yaml
schemaVersion: 1
prepare:
  command: npm ci --offline     # or pnpm/bun/uv — frozen install, build steps
  reuse: [node_modules]         # dependency dirs EXPLICITLY allowed to link from the user repo
  timeoutSeconds: 600
  preflight:                   # optional cheap checks before prepare
    - { name: lint, command: npm run lint, timeoutSeconds: 60 }
health:                         # optional probes before/after the suite
  - { name: database, tcp: '127.0.0.1:5432', timeoutSeconds: 5 }
  - name: worker-startup
    logAbsent:
      command: ./tools/recent-worker-logs.sh
      pattern: 'worker startup failed'
services:                       # candidate-owned app/database/worker processes
  - id: app
    command: node server.js --port ${service:app:port}
    attested: true              # fronted by the gate's attestation proxy
    fingerprint: prod-v1        # GF-13 marker (reviewed adapters must declare the same)
    target: true                # this proxy URL becomes the run's attested target
    ready: { log: 'listening on', timeoutSeconds: 60 }   # or http: <url>
envAllowlist: [DATABASE_URL]    # operator env names allowed through to children
executionTimeoutSeconds: 1800   # whole-run budget handed to the supervised gate
```

Contract highlights:

- Services start from the CHECKOUT bytes (never the worktree) in their own
  process groups; readiness (`log` regex or `http` 2xx), startup, and
  execution timeouts are bounded; stdout/stderr are captured to
  `<run-state>/runtime/<id>.log`; teardown happens on success, failure,
  timeout, and interruption (SIGINT/SIGTERM kill the whole groups).
- `prepare.preflight` checks run in order before `prepare`; the first
  non-zero exit blocks preparation with `PREFLIGHT_FAILED <name>` and the
  command's last 30 output lines.
- `health` supports one `tcp`, `http`, `command`, or `logAbsent` probe per
  entry. `logAbsent` runs its declared log command after startup and blocks
  when the configured regex is found. A failed startup probe blocks with
  `FIXTURE_UNHEALTHY <name>`; the post-run probe is advisory and does not
  change test verdicts. HTTPS uses normal certificate verification.
- Every `prepare.reuse` tree is constrained to a normalized repository-relative
  path. Its reachable dependency bytes are hashed into the authenticated
  input identity, so changing an ignored reused dependency invalidates the
  receipt even though the checkout uses a link.
- `${service:<id>:port}` / `${service:<id>:url}` placeholders are
  substituted by the supervisor and injected into every service's
  environment (`GATEFORGE_SERVICE_PORT_<ID>` / `GATEFORGE_SERVICE_URL_<ID>`).
- The attested target is the process THE GATE started from the frozen
  candidate — a bare target URL proves nothing. The receipt binds the raw-
  ingested tree of the prepared checkout (`targetArtifactDigest`), and the
  user's index is rechecked before authorization.
- ABSENT document = no bridge, no services (fail closed): discovery that
  needs installed dependencies blocks honestly instead of silently reusing
  the worktree's environment.

## Harness and run history

The optional `.gateforge.yml` `harness` section declares `up`, `reset`,
`seed`, `health`, and `down` shell commands. Supervised runs invoke configured
setup commands in that order before the suite; the first failure blocks the
suite, prints its last 30 output lines, and still attempts `down`. Gateforge
executes these commands but does not manage containers or other infrastructure.
Absent `harness` preserves current behavior.

```yaml
harness:
  up: ./tools/test-up.sh
  reset: ./tools/test-reset.sh
  seed: ./tools/test-seed.sh
  health: ./tools/test-health.sh
  down: ./tools/test-down.sh
  serviceLogs:
    command: docker compose logs --no-color --tail ${lines} ${service}
    services: [database, worker]
    lines: 100
```

On a failed supervised run, `serviceLogs` runs the declared log command for
each service and saves the configured tail to
`<run-state>/diagnostics/service-logs.txt`. Log capture is advisory and does
not change test verdicts.

Each `verifyPersistence` adapter call is timed in
`<run-state>/diagnostics/adapter-timing.jsonl`; calls over two seconds also
print a warning. Timed-out tests report the observed app/runner time separately
from their summed witness-adapter time. These diagnostics do not alter the
receipt or verdict.

Run history is opt-in through `.gateforge.yml` `history`; when configured,
retention defaults to 14 days and is capped at 90. Set `retentionDays: off`
to disable it. History is stored beneath the ignored test-gates state and is
not receipt input. Query it with `gateforge history [--test TEXT] [--failed]
[--since ISO-8601]`.

## Existing-test reuse (`gateforge tests`)

The reuse-first workflow: inspect what exists, declare what is unclear, run
it, and add a new test only for a confirmed behavior gap. The fixed agent
sequence is: `tests discover` → `tests suggest` → `tests sync` for annotated
tests or `tests mark` for hand-written sidecar mappings → run the suite under
supervision → `check --require-e2e`.

`tests discover` writes the catalog to `.gateforge/test-gates/test-catalog.json`
— a DERIVED artifact under the excluded run-state directory, never a pipeline
input and never beside the tests it inventories. Logical keys are stable
(`playwright:<project>:<file>:<title path>`; `-` when the runner has no
project) so manual mappings survive comment edits; source digests still move,
so old evidence goes stale. Renamed/deleted tests and removed parameters
surface as stale or ambiguous mappings — never a silent reassignment.

`tests sync` statically resolves direct Gateforge annotations and local pure
helpers that return literals. It never loads a test runner or executes a test.
Entries marked `source: annotation` are regenerated; handwritten entries are
preserved. Unresolvable annotations are printed as `UNRESOLVED` with the test
file and location. `check` reports missing/extra generated claims as the
non-blocking `TEST_MAP_OUT_OF_SYNC` advisory for this release period; run
`gateforge tests sync` to reconcile them.

`tests mark` validates the declaration against the current catalog AND the
current obligation registry (an unknown obligation id or test key is a
precise exit-2 error) before writing `.gateforge/test-map.yml`:

```yaml
schemaVersion: 1
tests:
  - key: playwright:chromium:e2e/accounts.spec.ts:deletes an account
    selector:
      runner: playwright
      project: chromium
      file: e2e/accounts.spec.ts
      titlePath: [Accounts, deletes an account]
    kind: browser-e2e
    categories: [persistence.delete]
    claims: [tenant.accounts:persistence:delete]
    reason: Existing journey deletes the selected account.
```

`--kind` is one of `browser-e2e`, `observed-e2e`, `api-e2e`, `unit`, `integration`,
`component`, `unknown`. A declaration is INTENT, never proof:

- Native `{ type: 'gateforge', description: '<obligation id>' }` annotations
  keep working; sidecar entries and native claims normalize through ONE
  resolver. Exact duplicate claims deduplicate; contradictions block with
  both source locations (`TEST_MAPPING_AMBIGUOUS`).
- An explicit kind may resolve `unknown` — and `observed-e2e` may refine an
  inferred `browser-e2e` (same journey, witness-watched instead of
  engine-driven) — but cannot override observed mocking or any other
  strong code-signal inference — `tests mark` refuses with
  both locations instead of writing the file.
- Agents may edit the sidecar directly; both paths receive identical
  validation. `mark` is idempotent: re-running an exact declaration writes
  nothing and reports `no changes`.
- Nothing here waives, weakens, or satisfies anything: a mapped test with no
  witnessed evidence for this change grades `EVIDENCE_NOT_COLLECTED` —
  blocking.

`tests suggest` emits `newTestNeeded: true` only when no suitable existing
candidate survives resolution. An unsupported proof channel produces a
capability task (`VERIFIER_UNSUPPORTED`), never a request to generate more
tests.

## Advisory pytest diagnostics

Register existing pytest suites under `diagnostics.suites` in
`.gateforge.yml` (explicit, tracked configuration — gateforge never scans
directories or executes commands on its own; only the `pytest` runner has an
adapter today):

```yaml
diagnostics:
  suites:
    - name: backend-pytest
      runner: pytest
      cwd: server
      argv: [python, -m, pytest]
      testPaths: [tests]
      timeoutMs: 600000
  hostLoad: true              # opt-in: sample load average, CPU count, and disk space
```

`gateforge tests diagnose` runs each configured suite once against the
current inputs (drift around discovery refuses the run) and prints a SEPARATE
diagnostic report with `DIAGNOSTIC_TEST_FAILURE` /
`DIAGNOSTIC_RUN_INCOMPLETE` / `DIAGNOSTIC_RESULT_STALE` causes. Skips and
expected failures stay explicit counters; a run of only skipped/xfail cases
is INCOMPLETE (exit 2), never a passing alarm. Diagnostic results are never
fed into claims, witness records, baselines, waivers, or E2E satisfaction,
and are never merged into E2E pass counts — 100 passing pytest tests do not
clear one missing browser obligation. When the supervised run executes the
same suites, their results are displayed separately without changing the E2E
exit decision.

When enabled, the supervised run writes `diagnostics/host-load.json` at start,
every 30 seconds, and at completion. Failed tests completed while load exceeds
1.5× CPU count get a note with the nearest preceding sample. Free disk below
5% at start emits a warning; load and disk data are diagnostic only.

## Enforcement

Two named modes (ADR 0005 D1); the CLI never reports a hook as more than it
is.

When a witnessed pre-commit run reaches a blocking result, Gateforge reports
how many tests the current commit selected and, when recorded, how long the
last full run took. This is cost context only; the current run and its receipt
still decide whether the commit passes.

**Standard mode** — an active local hook PLUS a mandatory trusted server
check:

- `gateforge init --blocking` installs a static pre-commit check and, for
  new configs (`enforcement.receiptStage: pre-push`), a pre-push hook that
  checks each pushed commit tip with `check --candidate-commit <sha>
  --require-e2e`. The static lane does not require a receipt; the pre-push
  lane does. Existing configs without `receiptStage` keep their previous
  pre-commit behavior. Hook activation is verified; foreign hooks are never
  overwritten.
  By default, `init --blocking` writes `.gateforge/ci/gitlab-gateforge.yml`
  plus the `.gitlab-ci.yml` include. `gateforge enforce --ci github` writes
  `.github/workflows/gateforge.yml` instead. Both strict templates run
  `test-gates --changed`, then verify the exact CI commit with
  `check --changed --candidate-commit "$CI_COMMIT_SHA"` (GitLab) or
  `--candidate-commit "$GITHUB_SHA"` (GitHub). The verifier key and policy
  pin come from protected CI secrets.
  `init --blocking` prints exact GitHub/GitLab protection commands for
  owner review; it never runs server mutations itself.
  Protect the branch, require its Gateforge pipeline to succeed (skipped jobs
  do not count), exclude agent roles from direct pushes, and use an
  organization-controlled pipeline execution policy so a candidate cannot
  remove the gate job. THE HONEST LIMIT: `--no-verify`, an alternate
  `core.hooksPath`, direct plumbing, or an unrelated clone bypass any local
  hook — keeping bypassed commits out of protected history is the server's
  job, not the hook's.
  `gateforge enforcement doctor` reports level 0–3. It reports level 3 only
  when a read-only provider API confirms branch protection plus a required
  Gateforge status check or passing-pipeline setting.
- The CI template checks that the installed `@gate-forge/cli` version equals
  the version that generated it. Add that exact version as a root
  `devDependency`. The template uses a package-manager lockfile when present;
  without one, it installs from the manifest. Set
  `GATEFORGE_CI_NESTED_PACKAGE_DIRS` to a space-separated list such as `e2e`
  when the Playwright config imports dependencies from nested packages.
  `enforce` and `adopt` use the same install and version checks, then run the
  static `check --changed` gate. They do not recommend gating on report counts.
- A generated hook uses `GATEFORGE_DEV_ENGINE` when set, then the
  repository-pinned CLI, `.gateforge/engine`, and `GATEFORGE_CLI`. A global
  `gateforge` on `PATH` is a last-resort fallback with a warning.
- `check --staged [--require-e2e]` gates the EXACT staged bytes: the index
  tree is frozen, materialized into an isolated scratch checkout, and the
  regular gate runs against those bytes (never the worktree). The candidate
  is re-checked after the gate — any index/HEAD drift during the run is a
  typed `ENFORCEMENT_UNTRUSTED` block. Partial staging is fine; symlinks,
  submodules, and unmerged index entries are typed blocks, never fallbacks.
- `check --changed --require-e2e` is the CI-side strict gate over the checked-
  out candidate.
- `--strict-e2e` (config `enforcement.strictE2E`) makes waived or baselined
  in-scope E2E obligations NOT proof (they block with `ENFORCEMENT_UNTRUSTED`
  — no automatic debt forgiveness), and blocks unclassified changed files as
  `CHANGE_UNMAPPED` until a resolved mapping covers them. Candidate edits to
  policies, classification, adapters, waivers, baselines, or the mapping
  sidecar cannot authorize weaker checks: gates evaluate under the trusted
  policy digest, so a weakened candidate fails closed until a separate
  trusted update is accepted.

**Receipts (the strict saved-state gate).** `check --require-e2e` accepts
only an authenticated gate receipt sealed by a COMPLETE supervised run for
the current input digest and trusted policy digest:

- no receipt (old record bundles included) → `RUN_INCOMPLETE`;
- receipt for different bytes/inputs → `EVIDENCE_STALE` (rerun for the
  exact candidate);
- forged/tampered receipt → `ENFORCEMENT_UNTRUSTED`.

Receipts sealed by newer Gateforge versions add the `engine` identity
(`version`, `source`, and `unpublished`) inside the authenticated envelope.
When present, `check --require-e2e` requires the installed CLI version to
match the version that sealed the receipt. Legacy receipts without `engine`
continue to verify as before.

`test-gates --changed` seals a receipt only after planned-vs-executed
completeness, evidence grading, and a successful runner exit: zero selected
tests, skips, `.only`, retries, teardown failures, and incomplete shards all
fail the run. Identical authenticated inputs may reuse a prior receipt
(printed as `reused receipt <id>`); any changed input forces a fresh run.
Without the verifier key in the trusted environment nothing can be sealed
and `--require-e2e` blocks — it never downgrades to a weaker pass.

**Owner-declared documentation exclusions (explicit trust mode).** By default,
Gateforge hashes all inputs and all candidate files. On a terminal, the first
`gateforge init` asks for documentation-only folders to exclude. Automation can
use `gateforge init --docs-exclude docs,handbook`; a non-interactive run with no
option keeps the default. Gateforge writes the approved declaration to
`.gateforge/docs-exclusions.yml` and prints the candidate trusted-policy digest
to approve through the protected `GATEFORGE_APPROVED_POLICY_DIGEST` setting.
Gate checks refuse to use the exclusions until that external pin matches. A
later change to the exclusion declaration changes the digest; use
`--confirm-doc-exclusions` when `init` changes an existing approval.

The project states these folders do not affect the product or its tests.
Gateforge does not prove this. If application or test code reads an excluded
file, a later edit can make old evidence look valid without running the tests
again. Reports show the approved folders, pin identity, and this reduced
guarantee. Gateforge rejects exclusions that contain configured scan inputs,
source files, gate or trust metadata, manifests, lockfiles, or symlinks.
Every file must also use a supported document or raster-image format. MDX,
WASM, SVG, HTML, and unknown formats fail closed. This format allowlist does
not prove that an allowed file cannot affect application or test behavior;
the project assertion and its reduced guarantee still apply.

**Owner-declared Python bytecode exclusions (explicit trust mode).** By
default, Python bytecode remains part of candidate and input identity. To
exclude only exact generated cache files, run
`gateforge init --cache-exclude src/__pycache__/module.cpython-313.pyc`.
The command writes `.gateforge/cache-exclusions.yml` and prints the trusted
policy digest to approve outside the repository. A matching protected
`GATEFORGE_APPROVED_POLICY_DIGEST` pin is REQUIRED before a gate uses the
list; changing an existing list requires `--confirm-cache-exclusions`.
Only exact `.pyc` or `.pyo` files directly under `__pycache__` are allowed;
globs, symlinks, configured inputs, and other file types fail closed. Reports
show the exact files, pin status, and reduced trust guarantee. This is an
owner assertion, not proof that the excluded bytecode cannot affect runtime
behavior.

**Managed mode** (config `enforcement.mode: managed`) — the literal
no-bypass guarantee requires putting the authoritative Git metadata, commit
service, gate executable, policy authority, and signing material OUTSIDE the
agent's write/process boundary. `gateforge broker commit` ships the
MECHANISM — verify a receipt for the exact workspace bytes, then commit via
compare-and-swap ref update — not the deployment. Running the broker inside
the agent's own boundary provides NO managed guarantee.
`gateforge enforcement doctor` reports which boundary is actually active:
hook activation, runner/browser readiness, capability availability, trusted
binary/policy ownership, snapshot mode, and — in managed mode — an
agent-writable authoritative Git directory is a `fail`, never a pass.
When `.pre-commit-config.yaml` exists, the doctor runs its hooks twice in a
temporary checkout, reports files they modify, and recommends placing
`gateforge-check` before mutating hooks. Hook commands still run with the
caller’s system permissions; review them as you would any local command.

### Owner-operated systemd deployment recipe

This is an operator deployment pattern, not an installed Gateforge service.
Use a dedicated authority account and keep the bare authoritative repository,
trusted config, CLI binary, and verifier key outside the agent's writable
process boundary. Give agents write access only to unique inbox workspaces;
allow them to request this one fixed unit, never arbitrary systemd units.
Do not pass candidate-controlled environment variables to the service.

Create an owner-only key ring and approved config as the authority account:

```sh
sudo install -d -o gateforge-authority -g gateforge-authority -m 0700 /etc/gateforge
sudo -u gateforge-authority gateforge key create --file /etc/gateforge/verifier-keyring.json --confirm
```

Install `/etc/systemd/system/gateforge-broker@.service` (replace the
root-owned CLI path and ref for your installation):

```ini
[Unit]
Description=Verify and commit one Gateforge workspace

[Service]
Type=oneshot
User=gateforge-authority
Group=gateforge-authority
WorkingDirectory=/srv/gateforge/authority.git
Environment=GATEFORGE_WITNESS_VERIFIER_KEY_FILE=/etc/gateforge/verifier-keyring.json
Environment=GATEFORGE_TRUSTED_CONFIG=/etc/gateforge/approved.yml
ExecStart=/usr/local/bin/gateforge broker commit --workspace /srv/gateforge/inbox/%i --message "verified candidate" --ref refs/heads/main
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadOnlyPaths=/srv/gateforge/inbox
ReadWritePaths=/srv/gateforge/authority.git
```

Provision `/srv/gateforge/authority.git`, `/srv/gateforge/inbox/<opaque-id>`,
and `/etc/gateforge/approved.yml` with owner-controlled permissions. Restrict
service activation to the agent role via an exact polkit rule; do not grant
general `sudo systemctl` access. The broker verifies the workspace receipt,
current approved policy, raw tree bytes, and compare-and-swap target ref
before committing. A missing, stale, forged, or wrong-key receipt fails
closed. `enforcement doctor` can verify the local boundary only; the owner
must separately audit the service account, polkit rule, filesystem
permissions, and immutable engine/config deployment.

## Contract capabilities

What the engine can grade today (single source of truth: the core capability
registry; `init --strict-e2e` preflight rejects setups that require anything
else):

| Namespace | Status |
| --- | --- |
| `persistence:create\|read\|update\|delete` | AVAILABLE — engine-observed same-entity persistence reads with the exact-value echo requirement (`EVIDENCE_VALUE_MISMATCH` on a mismatched echo, even when the status was 2xx) |
| `http:request-observed`, `http:response-status-ok` | AVAILABLE — transport semantics only: a witness-observed exchange plus a provenance-verified claimed `ui.action` anchor from the declaring test |
| `http:frontend-request-observed` | UNAVAILABLE — no independent browser/test attribution channel; explicit selection remains blocking `missing` with `VERIFIER_UNSUPPORTED` |
| `crud:*` (UI-semantic) | FAIL-CLOSED — the tested suite owns the browser; use `persistence:*` |
| `http:effect-verified`, `http:read-result-verified` | AVAILABLE (behavior-case channel) — graded across the approved required cases with witness-issued `behavior.case` records; needs a compiled `behaviorPolicy` requirement set |
| `auth:*`, `validation:*`, `task:*`, `webhook:*`, `workflow:*` | AVAILABLE (behavior-case channel) — same required-case aggregation over engine-controlled requests with independent state scopes. A repository that declares no case for the obligation stays blocking `missing`: the grader never falls back to transport evidence |

Unsupported proof stays blocking. Nothing silently replaces browser proof
with HTTP status proof.
`gateforge init` includes the available transport-only contracts for consumed
HTTP endpoints in new installations. Existing policies are unchanged;
explicitly requiring `http:frontend-request-observed` still blocks. The init
scan names that unavailable channel once as not yet provable.


## Configuration

`.gateforge.yml` is loaded fail-closed from the working directory (the repo
root); see `@gate-forge/core` for the pinned schema. All paths are
repo-root-relative. `changed.provider: auto` (the default) picks
`github-pr` when `GITHUB_BASE_REF` is set, `gitlab-mr` when
`CI_MERGE_REQUEST_DIFF_BASE_SHA` is set, else `local-staged`
(`git diff --cached --name-only`). `clock.mode: fixed` freezes the run
instant for deterministic reports; `system` (default) freezes it at run
start.

Enforcement-relevant sections:

- `enforcement:` — `mode: standard | managed` (default `standard`),
  `strictE2E: boolean` (default `false`), and optional
  `receiptStage: pre-push | pre-commit | ci`. New configs choose `pre-push`;
  omission preserves legacy behavior.
- `coveragePolicy:` (opt-in, fail closed) — the closed-world CRUD coverage
  policy: enumerated user-facing tables (validated against the run's
  resource inventory on EVERY run — an unknown table name is a config error,
  a silently dropped inventory table is a violation), required operations,
  and owner dispositions (`read-only-surface`, `admin-plane-unreachable`,
  `not-user-facing`, `other`, with a note). With the policy enabled, an
  uncovered, undispositioned required operation blocks with
  `CRUD_COVERAGE_MISSING`. Recording or approving a disposition is a
  trusted-policy act — the policy participates in the trusted policy
  revision, so an agent edit never self-approves.
- `diagnostics.suites:` — the advisory pytest suites (see above).
- `runner:` — the test runner the supervised gate drives:
  `playwright` (the default when the key is absent), `pytest`, `vitest` or
  `cypress`. `check`, `next`, `tests`, `test-gates`, `doctor` and `init`
  all follow it. See `guides/RUNNER-NEUTRAL-EVIDENCE.md`.

## Plugin invocation

Every configured plugin runs over the same expanded include path list
(`project.paths.include` minus `exclude`; `.git` and `node_modules` are
never scanned):

- **subprocess** (GPP/3): `command` argv is spawned via
  `@gate-forge/plugin-protocol`'s `PluginSession` — pinned handshake, one
  lock-step `discover`, shutdown handshake, fail-closed on any protocol
  violation. Plugins run without network.
- **in-process**: `module` is dynamically imported and its *default
  export* must provide `discover(paths)` returning
  `{resources, unresolved, findings}` in the pinned discovery shape.
  Relative module specifiers resolve against the repo root; the result is
  schema-validated and fails closed on invalid output.

The plugin's `discover` receives repo-relative file paths; in-process
plugins resolve them against the process working directory, which for a
CLI run is the repo root.

## Endpoint plane rules (`.gateforge/planes.json`)

The same declarative plane document the packs apply to business tables
also carries endpoint-plane evidence. It is consumed by the endpoint
compiler (the pipeline stage that builds `http.endpoint` resources) with
the same strict reader, the same schema
(`{ rules: [{ match?, tables?, plane, reason }] }`), and the same
fail-closed posture.

**Endpoint plane rules are explicit human declarations keyed on the
router SOURCE FILE path — not automatic filename inference.** The config
IS the documented evidence (mirroring the classification policy's
declaration channels): a rule whose `match` glob (repo-root-relative,
posix, core classifier glob semantics) matches an endpoint's router file
asserts that endpoint's `plane` (`tenant` | `master` | `global`) with a
required non-empty `reason` as the review artifact. `tables` rules never
apply to endpoints — endpoints carry no table identity.

Evaluation per endpoint, deterministic and fail closed:

- **All matching rules agree** → the plane is applied as a plane-dimension
  declaration signal (`gateforge.endpoint-compiler:config`), the same
  evidence channel the classifier's inheritance pass uses, so the graph
  qualifies the endpoint id as `plane.<name>`.
- **Matching rules disagree** → a blocking `PLANE_RULE_CONTRADICTION`
  entry is emitted (the required `reason` of each matching rule rides the
  diagnostic) and NO plane is applied — never first-match-wins.
- **No rule matches** → no evidence; the endpoint stays on the existing
  channels (linked-resource inheritance, operational `global`, else
  `PLANE_UNRESOLVED`).

Interaction with the other plane channels: the config plane participates
as EVIDENCE, never as a blanket override. When the plane the classifier
would derive for the endpoint (exactly one linked business resource, or
the operational `global` rule) is already derivable from the detector
contributions and CONTRADICTS the config plane, the compiler emits both
assertions so the classifier blocks with `PLANE_CONTRADICTION`; when they
agree, one plane remains and the endpoint resolves.

Absence of `.gateforge/planes.json` is normal and byte-identical to not
having this channel; a malformed document (bad JSON, unknown keys, a rule
without `plane`/`reason`, an absolute or `..`-escaping `match`) fails the
run closed at startup (exit 2).

### Review an endpoint plane

When `next` cannot resolve a route's plane, it asks which data boundary owns
the route and prints one command for each supported choice. Run only the
choice the owner has reviewed. `classify plane` accepts one repo-relative
router source path, one plane, and a non-empty reason:

```sh
gateforge classify plane 'src/routes.js' tenant \
  --reason 'Owner review confirms tenant-owned records for this route.'
```

The default is a dry run: it prints the exact config diff and does not write.
Add `--confirm` to append the rule to an **existing**
`.gateforge/planes.json`. The command never creates another trust file,
replaces a rule, or writes an internality declaration; conflicting rules
must be resolved by editing the owner-reviewed config. This file is a
classification input, so changing it changes the trusted-policy digest; an
approved policy pin must be re-approved before strict gates run.

The alternative in `next` is owner-only: use the existing
`.gateforge/classification-policy.yml` `internalRules` declaration only when
the route is genuinely internal. Internal rules still require the existing
internality certificate; they are not overrides.

## Endpoint capability rules (`.gateforge/endpoints.json`)

Capability derivation uses detector FACTS only (method, canonical path,
handler simple name, schema symbols, resource linkage). A handler whose
logic lives behind a service call has no positive evidence and fail-closes
with `ENDPOINT_SEMANTICS_UNRESOLVED` — the compiler cannot see through
service-layer delegation, by design, and will not guess. This document is
the escape hatch that the blocking message names: an explicit, human
assertion of what an endpoint DOES.

A rule carries at least one selector (AND semantics when several) plus a
capability from the closed compiler vocabulary and a required non-empty
`reason` (the review artifact):

- `match` — repo-root-relative glob on the ROUTER SOURCE FILE path;
- `handlers` — globs on the handler SIMPLE name (case-sensitive; a route
  with no handler symbol never matches);
- `paths` — globs on the canonical path (`/analytics/**`; must start
  with `/`);
- `method` — optional exact verb (`GET`…`DELETE`, never `ANY`).

```json
{
  "rules": [
    {
      "handlers": ["get_analytics_*"],
      "capability": "crud-read",
      "reason": "delegates to analytics_service; declared by the service owner"
    },
    {
      "match": "backend/api/v1/accounts.py",
      "method": "DELETE",
      "capability": "crud-archive",
      "reason": "sets archived_at via the service; soft delete by design"
    }
  ]
}
```

Evaluation per endpoint identity, deterministic and fail closed:

- **All matching rules agree** → the capability is declared (composed
  with detected ones; overlapping agreeing rules are one declaration).
  A declared `crud-delete`/`crud-archive` on a DELETE endpoint resolves
  the archive-vs-hard question the linked model could not prove.
- **Matching rules disagree** → a blocking
  `ENDPOINT_CAPABILITY_CONTRADICTION` entry names every matching rule,
  its capability, and its reason; NOTHING is applied — never
  first-rule-wins.
- **No rule matches** → the endpoint stays on detector-fact evidence
  only (and blocks if that is nothing).

The vocabulary is the compiler's own: `health-operations`,
`auth-session`, `webhook-callback`, `workflow-command`, `task-async`,
`search-query`, `validation-preview`, `file-transfer`, `ai-automation`,
`realtime`, `crud-create`, `crud-read`, `crud-update`, `crud-delete`,
`crud-archive`. Absence of the file is normal and byte-identical to not
having the channel; a malformed document fails the run closed at startup
(exit 2).

## Proposing planes at init (`gateforge init --planes`)

`gateforge init --planes` runs discovery over the repo's own include and
exclude configuration and PROPOSES `.gateforge/planes.json` from the
directories the discovered tables live in: one non-overlapping `match`
glob per model tree, `master` for trees whose path names a control-plane
segment (`admin`, `master`, `control`, `root`, `operator`), `tenant`
otherwise, and a reason on every rule naming the directory it was
inferred from. The keyword mapping IS a heuristic — that is why the file
is a review artifact: it is written only after explicit consent (flag,
or the TTY prompt), only when absent, and must be reviewed before the
next run reads it. Tables under test directories are excluded from the
proposal (fixtures are not business surface); they stay plane-less and
gate-visible. Non-interactive runs without `--planes` propose nothing
and print the tip.

## test-gates protocol (G6 surface)

`gateforge test-gates` writes a run state directory (default
`.gateforge/test-gates/`, `--out` overrides):

| File | Content |
| --- | --- |
| `manifest.json` | Pin #4 RunManifest (runId, injected-clock startedAt, gitSha, provider, plugin registrations, plus the `test-gates`-minted `invocationId` and tested `inputDigest`). At shutdown the witness appends `recordIds` + the v2 `attestation` envelope (never a legacy `recordIdsMac`). |
| `obligations.json` | Every obligation the suite must cover, with pin #2 fingerprint and resource source/location. |
| `env.json` | `GATEFORGE_RUN_ID`, `GATEFORGE_RUN_TOKEN`, `GATEFORGE_STATE_DIR`, `GATEFORGE_OBLIGATIONS`, `GATEFORGE_WITNESS_URL`. |
| `claims.json` / `records.json` | Reporter output consumed by the verifier (written by the suite). |
| `execution-result.json` / `receipt.json` / `diagnostics.json` | Supervised `--changed` mode: the sealed execution result (planned vs executed instances, outcomes, native claim inventory, runner exit, completeness), the authenticated gate receipt issued after complete success, and the separate advisory diagnostic report. |
| `report.json` | Canonical json-format run report after evaluation. |
| `last-full-run.json` | Advisory test count and measured duration for the latest completed full run; used only to explain commit cost, never as gate evidence. |


The legacy suite command (`--suite`) runs with those env vars; its reporter
extracts claims from `{type: 'gateforge', description: '<obligation id>'}`
annotations and posts evidence through the witness service (pin #7, header
`x-gateforge-run: <token>`; `GATEFORGE_WITNESS_URL` is set when a witness
service URL is provided via `--witness-url`). `gateforge check` reads
run-state evidence but takes native bindings only from `claimInventory`
in an execution result authenticated by a receipt for the current inputs;
it combines those with the current tracked `test-map.yml`. Raw
`claims.json` cannot add current declarations. Receipts created before
`claimInventory` existed remain valid, but supply no native bindings.
Records whose provenance does not verify never satisfy (GF-23). The
legacy escape hatch can never redefine the strict gate's expected cases
or turn an arbitrary exit-zero command into E2E proof — the hook and CI
run `check --staged/--changed --require-e2e`, which accept only supervised
receipts.

Before supervised execution, Gateforge compares Playwright's scrubbed
inventory with a second `--list` using the safe run variables supplied to
the runner. A difference stops the run before tests start and names each
project, file, and title present in only one inventory. Static discovery
also warns when `process.env.GATEFORGE_*` controls test registration.

### Provenance trust model (GF-23, audited 2026-08-31, three rounds)

`records.json` and `manifest.json` live in the suite-writable state
directory, so NEITHER proves anything on its own: a hostile suite can
fabricate records (the id hash `recordIdOf` is public) and can write any id
list into the manifest. Two layers close this.

**Layer 1 — trust follows origin.** A record's `origin` is part of its
hashed identity:

- `suite-submitted` (`ui.action`, `ui.visible-result` POSTed by the
  suite): the witness RECEIVED the assertion but cannot verify it
  happened — the suite owns the browser and holds the run token. These
  records are stamped `trust: 'claimed'` at issuance and only ANCHOR a
  claim (entity + operation).
- `engine-observed` (`persistence.entity`, stamped by the witness from
  its own adapter read): the only `trust: 'witnessed'` origin. This is
  where `satisfied` is earned — the engine requires a witnessed
  persistence record for the claimed entity, so fabricated outcomes can
  never satisfy.

**Supervised session binding (Phase 1).** The trusted reporter opens ONE
witness session per started test (`runId`, `sessionId`, `testId`,
`worker`), and the evidence fixture's five primitives (`ui`, `visible`,
`persistence`, `http`, `finalize`) submit only under that OPEN session:
the witness rejects submissions without a session and forces each record's
testId onto the session's supervisor-registered value; sealing rejects all
late submissions. Every UI action runs inside a witness-recorded
observation interval (supervisor-issued session clock), so proxy exchanges
observed outside the action's interval — direct setup calls, stray
navigation — are never credited as browser evidence. For a mutation whose
journey collects input in the UI, the `ui.action` record's `fields` are
the declared input, and the independent engine-observed persistence read
must echo those values EXACTLY on the same entity identity: a mismatched
echo fails the obligation with `EVIDENCE_VALUE_MISMATCH` even when the
status was 2xx. Primitive receipts are frozen and branded — hand-rolled
forgeries fail closed (GF-22).

**UI-semantic `crud:*` contracts fail closed (audit round 5).** The suite
still owns the browser, so a claimed UI action cannot be verified at the
DOM level; the namespace advertises no gradable contract. The gradable
surface is the lifecycle-gated `persistence:*` namespace, graded on the
witness's OWN engine-side observation
(`{resourceId, entityId, found, fields, before}`) with expectations that
NEVER come from the tested suite:

- `persistence:create`: an engine-side id-set PRE-OBSERVATION (`POST
  /witness/pre-observation`, backed by the adapter's optional `list`)
  shows the entity absent before the action; the post-read shows it
  present.
- `persistence:update`: an engine-side entity pre-observation exists,
  the engine observed an actual before/after field delta, AND the delta
  touches at least one classification-declared `updateableFields` entry
  (audit round 6) — bookkeeping drift such as `updated_at` alone never
  satisfies, and a resource whose classification omits
  `updateableFields` fails closed for update obligations.
- `persistence:read`: the entity is present in the engine-observed state.
- `persistence:delete`: a hard delete observes the entity ABSENT; an
  archive observes it present and matching the classification's
  owner-declared `archiveFields` (e.g. `{status: archived}`) — the suite
  cannot bless an unarchived entity by declaring its current state as
  the expected result.

An adapter may declare an optional literal `fields: [...]` projection.
Anchored persistence fails before consuming its pre-observation when the
action changes a field outside that projection. `check` also reports
model updateable fields missing from a statically readable projection.
Adapters without this metadata keep their existing behavior.

Presence alone, contradicted observations, missing pre-observations, or
absent deltas grade `invalid` — even when every provenance check passes.


When the complete endpoint inventory contains no update-capable route linked
to the resource, the failure also says that no observed UI request writes the
fields and the feature may be unreachable from the UI. This is diagnostic only;
it does not change the verdict.

**Layer 2 — versioned attestation binding evidence to tested inputs.** A witnessed record is authorized only by ONE validated
v2 envelope that simultaneously matches its run id, the expected input
digest, the required invocation identity, and its record id:

- the durable manifest `attestation` (`attestationVersion: 2` with
  `runId`, `invocationId`, `inputDigest`, sorted unique `recordIds`, and
  `mac` — HMAC-SHA256 over the domain-tagged body
  `gateforge.ledger.v2`), written by the witness at shutdown from its
  FROZEN bound context plus EXACTLY its own ledger (pre-seeded forged
  ids are discarded, never signed), or
- the live `GET /ledger-attestation` response: the SAME signed object,
  fetched (and MAC-verified) by `test-gates` from a still-running wired
  witness and persisted into the manifest as the durable fallback
  before the witness stops (401 to the run token alone).

The `inputDigest` is a deterministic snapshot of everything the
pipeline examines (all Git-tracked files, nonignored untracked files,
configured scan inputs even when ignored, `.gateforge.yml`,
policies/classification/pack configs, adapters, local plugin modules,
manifests/lockfiles, effective obligations/classifications/routes —
`packages/cli/src/input-snapshot.ts`). A deleted file, an untracked
file, a policy edit, or a lockfile change all move the digest, so old
evidence blocks after any source/configuration change. The
`invocationId` is fresh per `test-gates` run, so a restored old bundle
cannot satisfy a new invocation. `check` (no suite) reuses a completed
signed run only for byte-identical inputs — it never equates its own
fresh manifest UUID with the evidence run UUID.

The witness never signs what a suite-writable file says: `test-gates`
binds the context with authenticated `POST /run-context` (run token
AND verifier key) BEFORE the suite starts, and the witness freezes it
in memory. Binding is allowed only before any observation or issuance;
a used witness answers 409, an identical rebind is idempotent, any
change is 409, and an unbound witness issues no attestation. A proxy
exchange in flight at bind time refuses the bind, and observations
that completed before binding are never consumable under the new
context.

The legacy v1 `recordIdsMac` (HMAC over `{runId, recordIds}` with no
digest binding) NEVER authorizes evidence — even when it verifies.
Invalid durable envelopes contribute nothing; live and durable
contexts are validated independently and never merged; mismatches
surface as explicit `evidence-context` blockers (missing vs malformed
vs forged stay distinguished) that waivers cannot hide.

The key comes from one trusted source: the protected
`GATEFORGE_WITNESS_VERIFIER_KEY` environment variable, an external
owner-only key ring named by `GATEFORGE_WITNESS_VERIFIER_KEY_FILE`, or the
default `$XDG_CONFIG_HOME/gateforge/verifier-keyring.json` (otherwise
`~/.config/gateforge/verifier-keyring.json`) when present. Do not set both
explicit sources. The file must be a regular file owned by the current
user, with mode `0600` or stricter, and it must not be a symlink. Store
it outside the candidate repository, Git directory, run state, `--out`
directory, workspace, and receipt-artifact directory. Gateforge refuses
unsafe paths and permissions. File mode is not supported on Windows;
use the protected environment source there.
Create and rotate keys only after an owner review:

If you already use an environment key, keep it in the protected environment
while you import it. Do not place key material in shell history or argv.

```sh
gateforge key create --confirm
gateforge key import-env --confirm
unset GATEFORGE_WITNESS_VERIFIER_KEY
gateforge key rotate --confirm
gateforge key retire --key-id key-old-id --confirm
```

Create the parent directory first. `key import-env` retains an existing
environment key under its stable id before switching to the file source.
Key commands print only a non-secret
key id. Rotation keeps old keys so their receipts still verify. Retire an
old key only when its receipts no longer need to verify. Gateforge stores
the key id, not the secret, in new receipts. A receipt for a removed id
fails with `KEY_UNKNOWN`. The key ring file contains raw signing keys, so
protect its backups with the same care as the original.

`test-gates` strips both key-source variables from the suite child's
environment. The supervised browser runner and candidate runtime also
refuse both sources, and Gateforge does not write either value or file
path into run state. The trusted witness process receives the active key
to authenticate records. A suite-owned Playwright global setup therefore
cannot bootstrap trusted issuance by inheriting the key — it fails closed
unless an externally wired trusted witness is provided. Residuals (not
eliminable by env hygiene alone): a same-uid process can read environ when yama
`ptrace_scope=0`, and env vars never isolate hostile same-user OS
processes — for strong isolation run the suite as a distinct user or
container. File-change capture is snapshot-based, not an OS sandbox:
it guards changes visible at capture points, not a malicious process
that changes and restores files between snapshots.

Fail closed: without the key, or when no envelope validates for the
expected context, every witnessed record demotes to claimed-tier
(blocking, never satisfied).

### Evidence migration (v1 → v2, no auto-migration)

- Existing evidence bundles need a FRESH run: there is no command
  that signs old records into the new format without observations, and
  none will be added (signing old records would certify untested code).
- Gate receipts (ADR 0005 D3) are a separate versioned, domain-separated
  envelope — never a repurposed v2 attestation, and never a mutable
  `passed` flag on a claim. `check --require-e2e` rejects old record
  bundles that lack the required complete-run receipt.
- Policies and waivers keep their explicit semantics: snapshot binding
  never rewrites their IDs to evade blockers — and in strict E2E mode an
  in-scope waived/baselined E2E obligation is not proof at all
  (`ENFORCEMENT_UNTRUSTED`).
- External witness setup: start `gateforge-witness` (or `startWitness`)
  with the run id/token from a TRUSTED parent env carrying
  `GATEFORGE_WITNESS_VERIFIER_KEY`, pass `--witness-url`/`--run-token`
  to `test-gates`, and start a FRESH witness per invocation (a witness
  used by an older invocation rejects binding with 409).
- Non-Git checkouts keep discovery but fail evidence authorization
  with a `snapshot-unavailable` diagnostic; submodules, escaping
  symlinks, and `--out` overlapping source fail closed with explicit
  diagnostics.

## Limitations

- Staged candidates containing symlinks or submodules (and unmerged index
  entries) are typed blocks in `check --staged` and `broker commit` —
  explicit, never fallbacks; support is not implemented.
- A Playwright config with NO named project yields native rows with an
  empty project name, which the strict catalog schema rejects as an
  internal error (exit 2) instead of a typed row. The documented consumer
  shape uses named projects; a typed empty-project row is open work.
- Run-state hygiene is enforced, not forgiven: a committed run-state
  directory (it overlaps source inputs) or config include globs that omit
  the spec directories produce fail-closed diagnostics — gitignore
  `.gateforge/test-gates/` and include the spec globs.
- Consumer-worktree migration (writing `.gateforge` configuration,
  `coveragePolicy`, or `test-map.yml` into the inventoried ERP consumer
  worktree) and the server-side GitLab enforcement settings are pending
  owner actions — the complete template and settings list ship from
  `init --blocking`, but a local simulation does not complete a server
  rollout (`docs/plans/immediate/20260913_consumer_migration_record.md`).

## Development

```bash
npm test              # workspace-wide (vitest projects)
npm run build         # compile to dist/ (dependency order: core → plugin-protocol → cli)
node bin/gateforge.js --help
```
