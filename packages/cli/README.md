# @gate-forge/cli

The gateforge command-line interface: initialize a project, discover
resources and classification signals, inspect automatic decisions, reuse a
repository's existing tests, evaluate obligations, run the supervised E2E
gate, enforce the exact staged candidate, and maintain baselines.

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

## Commands

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `gateforge init [--languages <comma,list>] [--plugins <comma,list>] [--accept-recommended] [--no-scan] [--proof overlay\|observe] [--blocking] [--strict-e2e] [--managed]` | Scan the repo (heuristics, no network), print the recommended install (plugins, persistence-only policy, overlay proof), and write `.gateforge.yml`, `.gateforge/policies.yml`, `.gateforge/classification-policy.yml`, `.gateforge/baselines/obligations.json`, `GATEFORGE.md`, and (overlay proof only) `tests/e2e/gateforge/README.md`. Idempotent — never overwrites existing files. `pack-task` is opt-in only (`--plugins`); `--proof observe` skips the overlay scaffold and prints the observe wiring checklist instead. Default language: `python`. `--strict-e2e` writes the `enforcement` block and runs capability preflight. `--managed` tries the targeted native Podman package install first; if Arch requires a full `pacman -Syu` fallback, Gateforge asks the owner before running it. It then verifies rootless `podman info`, writes `enforcement.mode: managed`, and implies strict/blocking wiring. No npm lifecycle install or silent privilege escalation. | 0 (blocking/install failure → 2) |
| `gateforge next [--changed] [--json]` | Print the ONE blocking next action (`next`/`cause`/`why`/`do`; `--json` adds `remainingBlocking`). Navigation, not the gate: never requires an E2E receipt. Exit 0 clean, 1 next action, 2 config/usage. | 0/1/2 |
| `gateforge discover [--json]` | Run every configured detector over the expanded `project.paths` and dump the resource graph (default: human listing; `--json`: GF-canonical JSON). | 0 |
| `gateforge classify [--json] [--write-snapshot <path>]` | Recompute effective classifications from detector signals and print decisions, traces, and typed blocks. Snapshots are derived review artifacts and never pipeline input. | 0/1/2 |
| `gateforge explain <resourceId> [--json]` | Show one resource's detector signals, classification rules, decision fingerprint, typed blocks, and generated obligations. | 0/1/2 |
| `gateforge tests discover [--json] [--pytest]` | Inventory existing tests into the derived run-state catalog: static analysis reconciled with native Playwright enumeration (`--list`). Unresolved wrappers, parse errors, and inventory gaps are DATA (never an empty catalog — failed native enumeration is exit 2). `--pytest` additionally collects the configured diagnostic suites' node ids (`--collect-only`). | 0/2 |
| `gateforge tests suggest [--changed] [--json]` | Resolve mappings for the run's obligations and produce reuse-ordered existing-test candidates with typed causes (`TEST_MAPPING_MISSING` / `TEST_KIND_UNKNOWN` / `TEST_MAPPING_AMBIGUOUS` / `TEST_MAPPING_STALE`) and a `newTestNeeded` verdict per obligation. An inspection surface, NOT a gate: exit 0 even with blocking mapping problems. | 0/2 |
| `gateforge tests mark --test <key> --kind <kind> [--category <c>]... --obligation <id>... --reason "<text>"` | Declare an existing test in `.gateforge/test-map.yml` (see the test-reuse workflow below). Validates against the CURRENT catalog and obligation registry, writes atomically and idempotently, prints the exact diff. Never edits test files, never adds waivers, refuses contradictions. | 0/2 |
| `gateforge tests explain --test <key> [--json]` | Per-test report: requirements, existing-test identity, mapping origin, honest execution status, next action, `New test needed`. | 0/2 (unknown key → 2) |
| `gateforge tests diagnose [--suite <name>] [--json]` | Run the configured pytest diagnostic suites once per suite, isolated (own process, `GATEFORGE_*` stripped, finite timeout). Advisory: exit 0 completed run (≥1 pass, no unexpected failures), 1 test failures, 2 unavailable/incomplete (collection error, timeout, missing interpreter, interruption, zero tests, or only skipped/xfail). Never E2E proof. | 0/1/2 |
| `gateforge obligations [--json]` | Evaluate policies against the automatically classified graph and dump obligations, blocking entries, and claim assessments. | 0/1/2 |
| `gateforge check [--changed] [--staged] [--require-e2e] [--format text\|json\|sarif]` | The full gate: discover → classify → obligations → claims → verdicts → report. `--changed` evaluates one effective scope: only obligations/blockers tied to files the resolved diff provider reports — unless the diff touches a gate-defining input (`.gateforge.yml`, configured policy/classification paths, planes/http-clients/fastapi configs, adapters, waivers, repo-local plugin modules, dependency manifests/lockfiles, ignore controls), a test file or helper, the runner configuration, or the mapping sidecar, which expands the run to all obligations (reported as `scope` metadata with `expandedBecause` reasons). `--staged` gates the EXACT staged candidate (frozen index checkout, never the worktree; mutually exclusive with `--changed`). `--require-e2e` blocks without a valid, non-stale gate receipt (see Enforcement). `--format` default `text`. Verifier key via `GATEFORGE_WITNESS_VERIFIER_KEY` env (see trust model). | 0 clean/waived, 1 unresolved, 2 config/usage |
| `gateforge test-gates [--changed] [--scope full\|changed] [--suite <cmd>] [--out <dir>] [--format F] [--witness-url <url>] [--run-token <token>]` | Two modes. Supervised `--changed`: trusted runner supervision over the obligations — resolves catalog + mappings, fixes the expected test set, executes the configured Playwright suite through the adapter, enforces planned-vs-executed completeness, and seals an authenticated gate receipt ONLY after complete success. `--scope changed` (supervised only, opt-in): plan, execute, and seal only the slice of tests whose files claim obligations affected by the resolved changed-file set — an affected obligation with no testable declared mapping blocks (`EVIDENCE_SCOPE_INCOMPLETE`), an empty slice seals nothing, and `check --require-e2e` accepts a slice receipt only when it covers every obligation arising from the currently-changed files. Without the flag behavior is unchanged (full suite, whole-repo receipt). Legacy `--suite`: the orchestration escape hatch (cannot be combined with `--changed`, and can never redefine the strict gate's expected cases). A nonzero suite exit fails the run. Verifier key via `GATEFORGE_WITNESS_VERIFIER_KEY` env. | 0/1/2 (suite failure forces 1) |
| `gateforge broker commit --workspace <dir> --message <msg> [--receipt <path>] [--ref <ref>]` | Managed-mode commit broker (MECHANISM, not deployment): snapshots the workspace bytes into a throwaway index, recomputes the input + trusted-policy digests, verifies a valid non-stale gate receipt for EXACTLY those bytes, then creates the commit via compare-and-swap `git update-ref`. Typed rejections (`ENFORCEMENT_UNTRUSTED` / `EVIDENCE_STALE` / `RUN_INCOMPLETE` / `BROKER_CAS_MISMATCH` / `BROKER_UNSAFE_MESSAGE`); symlinks/submodules are typed rejections. Verifier key via env; runs with cwd = the AUTHORITATIVE repository. | 0/2 |
| `gateforge enforcement doctor [--json]` | Honest enforcement diagnostics: config, hook presence + ACTIVATION, runner readiness, observer capability, trusted binary/policy ownership, snapshot mode, and the standard/managed boundary. Detecting a hook NEVER counts as managed protection. Diagnostic only: exit 0 whenever it runs. | 0/2 |
| `gateforge baseline update <fp...>` | Shrink the baseline to a strict subset (invariant 4). | 0/2 |

Global flags: `--help`, `--version`. Exit codes per architecture contract 4:
`0` clean/waived, `1` unresolved obligations (or a failed/supervision-blocked
run), `2` config/usage error. `tests diagnose` has its own advisory contract
(0/1/2 above).

## Existing-test reuse (`gateforge tests`)

The reuse-first workflow: inspect what exists, declare what is unclear, run
it, and add a new test only for a confirmed behavior gap. The fixed agent
sequence is: `tests discover` → `tests suggest` → `tests mark` (or edit the
sidecar directly) → run the suite under supervision → `check --require-e2e`.

`tests discover` writes the catalog to `.gateforge/test-gates/test-catalog.json`
— a DERIVED artifact under the excluded run-state directory, never a pipeline
input and never beside the tests it inventories. Logical keys are stable
(`playwright:<project>:<file>:<title path>`; `-` when the runner has no
project) so manual mappings survive comment edits; source digests still move,
so old evidence goes stale. Renamed/deleted tests and removed parameters
surface as stale or ambiguous mappings — never a silent reassignment.

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

## Enforcement

Two named modes (ADR 0005 D1); the CLI never reports a hook as more than it
is.

**Standard mode** — an active local hook PLUS a mandatory trusted server
check:

- `gateforge init --blocking` installs the pre-commit hook into the resolved
  hooks directory (`core.hooksPath` honored), verifies activation (exec bit +
  a verified `--gateforge-verify` invocation), and writes a standalone
  staged-gate script (`.gateforge/hooks/gateforge-staged.sh`) for consumers
  with a foreign hook manager. The hook runs `gateforge check --staged
  --require-e2e`; a missing engine blocks (fail closed). Idempotent — an
  existing gateforge-owned hook is verified, never rewritten.
- The same `init --blocking` run writes `.gateforge/ci/gitlab-gateforge.yml`
  plus the `.gitlab-ci.yml` include — the SERVER-side strict gate (pinned
  engine, `test-gates --changed` receipt seal, `check --changed
  --require-e2e`), with the required server-side settings documented in the
  template header:
  "Pipelines must succeed" (skipped ≠ successful), protected branches
  excluding the agent role from direct pushes, and an organization-controlled
  pipeline execution policy so a candidate cannot delete the gate job. THE
  HONEST LIMIT: `--no-verify`, an alternate `core.hooksPath`, direct
  plumbing, or an unrelated clone bypass any local hook — keeping bypassed
  commits out of protected history is the server's job, not the hook's.
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

`test-gates --changed` seals a receipt only after planned-vs-executed
completeness, evidence grading, and a successful runner exit: zero selected
tests, skips, `.only`, retries, teardown failures, and incomplete shards all
fail the run. Identical authenticated inputs may reuse a prior receipt
(printed as `reused receipt <id>`); any changed input forces a fresh run.
Without the verifier key in the trusted environment nothing can be sealed
and `--require-e2e` blocks — it never downgrades to a weaker pass.

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

## Contract capabilities

What the engine can grade today (single source of truth: the core capability
registry; `init --strict-e2e` preflight rejects setups that require anything
else):

| Namespace | Status |
| --- | --- |
| `persistence:create\|read\|update\|delete` | AVAILABLE — engine-observed same-entity persistence reads with the exact-value echo requirement (`EVIDENCE_VALUE_MISMATCH` on a mismatched echo, even when the status was 2xx) |
| `http:request-observed`, `http:response-status-ok` | AVAILABLE — transport semantics only: a witness-observed exchange plus a provenance-verified claimed `ui.action` anchor from the declaring test |
| `http:frontend-request-observed` | UNAVAILABLE — no independent browser/test attribution channel; grades blocking `missing` before examining evidence |
| `crud:*` (UI-semantic) | FAIL-CLOSED — the tested suite owns the browser; use `persistence:*` |
| `http:effect-verified`, `http:read-result-verified` | AVAILABLE (behavior-case channel) — graded across the approved required cases with witness-issued `behavior.case` records; needs a compiled `behaviorPolicy` requirement set |
| `auth:*`, `validation:*` | AVAILABLE (behavior-case channel) — same required-case aggregation over engine-controlled requests with independent state scopes |
| `task:*`, `webhook:*`, `workflow:*` | UNSUPPORTED — every contract fail-closed; surfaces as `VERIFIER_UNSUPPORTED` (remove the contract or drop the pack; do not add tests) |

Unsupported proof stays blocking. Nothing silently replaces browser proof
with HTTP status proof.

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

- `enforcement:` — `mode: standard | managed` (default `standard`) and
  `strictE2E: boolean` (default `false`); see Enforcement above.
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
| `execution-result.json` / `receipt.json` / `diagnostics.json` | Supervised `--changed` mode: the sealed execution result (planned vs executed instances, outcomes, runner exit, completeness), the authenticated gate receipt issued after complete success, and the separate advisory diagnostic report. |
| `report.json` | Canonical json-format run report after evaluation. |

The legacy suite command (`--suite`) runs with those env vars; its reporter
extracts claims from `{type: 'gateforge', description: '<obligation id>'}`
annotations and posts evidence through the witness service (pin #7, header
`x-gateforge-run: <token>`; `GATEFORGE_WITNESS_URL` is set when a witness
service URL is provided via `--witness-url`). `gateforge check` reads the
same state directory for claims and records. Records whose provenance does
not verify never satisfy (GF-23). The legacy escape hatch can never
redefine the strict gate's expected cases or turn an arbitrary exit-zero
command into E2E proof — the hook and the CI job run `check
--staged/--changed --require-e2e`, which accept only supervised receipts.

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

Presence alone, contradicted observations, missing pre-observations, or
absent deltas grade `invalid` — even when every provenance check passes.

**Layer 2 — versioned attestation binding evidence to tested inputs
(plan §11, F2).** A witnessed record is authorized only by ONE validated
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

The key travels by ENVIRONMENT (`GATEFORGE_WITNESS_VERIFIER_KEY`),
never argv — `/proc/<pid>/cmdline` is world-readable. `test-gates`
strips the var from the suite child's environment so a suite cannot
inherit it, and the witness binary reads it from the TRUSTED parent
env only (never argv/stdout/state/suite env). A suite-owned
Playwright global setup therefore cannot bootstrap trusted issuance
by inheriting the key — it fails closed unless an externally wired
trusted witness is provided. Residuals (not eliminable by env hygiene
alone): a same-uid process can read environ when yama
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
- Managed mode ships the broker mechanism plus rootless-Podman reference
  deployment assets under `deploy/managed/`; those assets do not provision
  the authoritative Git directory, credentials, protected refs, or external
  app/worker services. The current managed backend supports Linux rootless
  Podman only and rejects other platforms rather than guessing.

## Development

```bash
npm test              # workspace-wide (vitest projects)
npm run build         # compile to dist/ (dependency order: core → plugin-protocol → cli)
node bin/gateforge.js --help
```
