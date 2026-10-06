# Gateforge CLI reference

The reference for the `gateforge` CLI: every command, flag, exit
code, and protocol, plus the usage documentation that lived in the
repository README before the 0.9.0 documentation split. Both halves
moved verbatim from `packages/cli/README.md` and the root
`README.md`. The [CLI README](../README.md) covers install and the
first commands; the guides cover the walks:
[Quickstart](QUICKSTART.md), [Connect your project](CONNECT-YOUR-PROJECT.md),
[Test environment](TEST-ENVIRONMENT.md),
[Runners other than Playwright](RUNNER-NEUTRAL-EVIDENCE.md),
[Upgrade from 0.8 to 0.9](UPGRADE-0.8-to-0.9.md),
[Upgrade from 0.9 to 0.10](UPGRADE-0.9-to-0.10.md).

## Contents

- [Commands](#commands)
- [Staged runtime (`.gateforge/runtime.yml`)](#staged-runtime-gateforgeruntimeyml)
- [Harness and run history](#harness-and-run-history)
- [Existing-test reuse (`gateforge tests`)](#existing-test-reuse-gateforge-tests)
- [Advisory pytest diagnostics](#advisory-pytest-diagnostics)
- [Enforcement](#enforcement)
- [Contract capabilities](#contract-capabilities)
- [Configuration](#configuration)
- [Pages](#pages)
- [Classification policy (`.gateforge/classification-policy.yml`)](#classification-policy-gateforgeclassification-policyyml)
- [Plugin invocation](#plugin-invocation)
- [Endpoint plane rules (the `planes:` section)](#endpoint-plane-rules-the-planes-section)
- [Endpoint capability rules (the `endpoints:` section)](#endpoint-capability-rules-the-endpoints-section)
- [Proposing planes at init (`gateforge init --planes`)](#proposing-planes-at-init-gateforge-init---planes)
- [test-gates protocol (G6 surface)](#test-gates-protocol-g6-surface)
- [Limitations](#limitations)
- [Pick a goal, not a wall of flags](#pick-a-goal-not-a-wall-of-flags)
- [Agent loop](#agent-loop)
- [Fix a failing test without a full run](#fix-a-failing-test-without-a-full-run)
- [What the gate catches that ordinary tests can miss](#what-the-gate-catches-that-ordinary-tests-can-miss)
- [Running in CI](#running-in-ci)
- [Gate strictness and flaky tests](#gate-strictness-and-flaky-tests)
- [Run the whole proof with one command](#run-the-whole-proof-with-one-command)
- [The witnessed CI job](#the-witnessed-ci-job)
- [Known limitations](#known-limitations)

## Commands

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `gateforge init [--preset light\|normal\|strict] [--explain-presets] [--languages <comma,list>] [--plugins <comma,list>] [--accept-recommended] [--no-scan] [--proof overlay\|observe] [--blocking] [--no-blocking] [--pre-commit] [--no-pre-commit] [--ci] [--no-ci] [--planes] [--no-planes] [--strict-e2e] [--docs-exclude <folder,...>] [--docs-exclude-file <path>] [--confirm-doc-exclusions]` | Scan the repo (heuristics, no network), print the recommended install (plugins, persistence policy, transport-only HTTP policy for consumed endpoints, overlay proof), and write the standard Gateforge scaffold. Idempotent — never overwrites existing files unless `--confirm-doc-exclusions` approves an exclusion update. It also appends Gateforge's own engine state (`.gateforge/test-gates/`) to `.gitignore`, and on a repository that already has code it names `gateforge adopt` as the way through the debt the first commit will meet. `pack-task` is opt-in only (`--plugins`); `--proof observe` skips the overlay scaffold and prints the observe wiring checklist instead. Default language: `python`. `--preset` applies one goal in one step (`light` -> `mode: warn`, no hooks; `normal` -> `mode: changed` + pre-commit hook + CI job; `strict` -> `mode: strict` + staged gate + pre-push receipt check + CI job) and prints what it wrote plus `undo:` lines for created and in-place-changed files; `--explain-presets` prints that mapping and writes nothing. In a terminal init asks the same question instead; with no terminal and no `--preset` it writes `light` only and says so on one line with the `--preset` flag that changes it. The negative forms (`--no-blocking`, `--no-pre-commit`, `--no-ci`, `--no-planes`) answer the matching question without a prompt. A preset never writes a waiver, an adopted baseline or a plane rule, and an existing `.gateforge.yml` is never rewritten. `--strict-e2e` writes the `enforcement` block and refuses unavailable required proof channels. | 0/1/2 |
| `gateforge migrate [--confirm]` | Move owner declarations out of their own files and into `.gateforge.yml`. Today that is the evidence exclusions: `.gateforge/docs-exclusions.yml` and `.gateforge/cache-exclusions.yml` become `evidence.exclude.docs` and `evidence.exclude.cache`. Preview by default — it prints the exact `.gateforge.yml` diff and the files it would delete, writes nothing, exits 0; `--confirm` writes the block as TEXT (your YAML is never re-serialized), deletes the old files, and ends with `policy inputs changed: re-pin the approved digest (gateforge enforcement doctor)`. It validates the old files with the loader rules, refuses an `evidence:`/`exclude:`/`docs` form it cannot extend safely by name, and is idempotent (`nothing to migrate`, exit 0). Every other command refuses a repository that still carries an old file, naming this one. | 0/2 |



| `gateforge next [--changed] [--json]` | Print the ONE blocking next action (`next`/`cause`/`why`/`do`; `--json` adds `remainingBlocking` and route-specific `guidance` when relevant). For an endpoint with no plane, ask which boundary owns its data and show the owner-reviewed choices; internality remains owner-only. Navigation, not the gate: never requires an E2E receipt. Exit 0 clean, 1 next action, 2 config/usage. | 0/1/2 |
| `gateforge discover [--json]` | Run every configured detector over the expanded `project.paths` and dump the resource graph (default: human listing; `--json`: GF-canonical JSON). | 0 |
| `gateforge classify [--json] [--write-snapshot <path>]` | Recompute effective classifications from detector signals and print decisions, traces, and typed blocks. `classify plane` previews or explicitly appends an owner-reviewed endpoint plane rule to the existing `planes:` section of the owner-answers document; snapshots are derived review artifacts and never pipeline input. | 0/1/2 |
| `gateforge classify delete <file\|folder\|glob> <hard\|archive> [--archive-field <key=value>]... --reason <text> [--confirm]` | Preview (default) or explicitly append one owner delete-semantics rule to `.gateforge/classification-policy.yml`: how removal manifests for every model whose source file matches the pattern. `archive` requires at least one `--archive-field` (the owner-owned archived state the run grades removal against); `hard` refuses the flag. The preview writes nothing, prints the exact diff, and quotes the policy-pin consequence; `--confirm` appends the rule at TEXT level — the key at the end of the document when absent, a new `- match:` item at the end of the block when present — so every byte the owner wrote survives (comments, key order, flow sequences), and the resulting document is validated against the pinned schema. A `deleteRules` the command cannot extend safely (flow style, or a value that is not a list of rules) is refused by name. An existing rule for the same source is reported, never shadowed. Declaring is an evidence contract, not an override: contradicting detector evidence still blocks. | 0/2 |
| `gateforge explain <resourceId\|path> [--json]` | Show one resource's detector signals, classification rules, decision fingerprint, typed blocks, and generated obligations. A repo-relative PATH is also a target: when no resource matches it, the command prints what the file is and what governs it (Gateforge policy input, declared gate input, owner-declared documentation folder, known source of a resource, or an unclassified change) with the steps that attribute it — this is the answer an unmapped `CHANGE_UNMAPPED` file needs. An unknown target stays unknown (exit 1). | 0/1/2 |
| `gateforge tests discover [--json] [--pytest]` | Inventory existing tests into the derived run-state catalog: static analysis reconciled with native Playwright enumeration (`--list`). Unresolved wrappers, parse errors, and inventory gaps are DATA (never an empty catalog — failed native enumeration is exit 2). `--pytest` additionally collects the configured diagnostic suites' node ids (`--collect-only`). Playwright enumeration runs ONE config (a repo-root config wins; otherwise the alphabetically first config one directory deep), and when the repo holds more than one the runner line names every config, the one used, why, and the ones NOT inventoried. `inventoryComplete=false` means a reconciliation gap (an enumerated-vs-static mismatch, an unresolved case, or a not-inventoried extra config), not a partial success. | 0/2 |
| `gateforge tests suggest [--changed] [--json]` | Resolve mappings for the run's obligations and produce reuse-ordered existing-test candidates with typed causes (`TEST_MAPPING_MISSING` / `TEST_KIND_UNKNOWN` / `TEST_MAPPING_AMBIGUOUS` / `TEST_MAPPING_STALE`). Candidates are RANKED by the evidence their catalog row carries (explicit tag, resource token in title/file, operation word, route segment, unmocked folder, minus mocks) with the matching reason printed as `why:`; the text surface prints the top five and names how many it hid, `--json` carries every candidate with its `rank` and `score`. The reuse verdict `newTestNeeded` has THREE honest values: `no` (the `#1` candidate is an unmocked e2e row more than one signal supports), `yes` (no candidate survived resolution, or every candidate mocks the system under test) and `unverified` (a candidate exists but one signal carries it — confirm the request with `gateforge explain <obligation>` before marking). The next action follows it: MARK the candidate and run it under the witness when the verdict is `no`, write the overlay when it is `yes`. When Playwright reports load errors and enumerates no tests, report one `TEST_INVENTORY_INCOMPLETE` with the error count and first error instead of stale-mapping fan-out; the action is to install the missing dependency and rerun Gateforge. An inspection surface, NOT a gate: exit 0 even with blocking problems. | 0/2 |
| `gateforge tests mark --test <key> --kind <kind> [--category <c>]... --obligation <id>... --reason "<text>"` | Declare an existing test in `.gateforge/test-map.yml` (see the test-reuse workflow below). `--test` accepts EITHER documented key form: the catalog `logicalKey` (`playwright:chromium:e2e/accounts.spec.ts:Accounts>deletes an account`) or the reconciliation key `<file>#<titlePath joined by '>'` (`e2e/accounts.spec.ts#Accounts>deletes an account`). The sidecar always stores the `logicalKey`. Validates against the CURRENT catalog and obligation registry, writes atomically and idempotently, prints the exact diff. Never edits test files, never adds waivers, refuses contradictions. | 0/2 |
| `gateforge tests sync [--json]` | AST-only scan of test annotations; updates generated `source: annotation` entries in `.gateforge/test-map.yml` and leaves handwritten entries unchanged. Reports unresolved helpers with source locations; does not run tests. | 0/1/2 |
| `gateforge tests explain --test <key> [--json]` | Per-test report: requirements, existing-test identity, mapping origin, honest execution status, next action, and the same three-state reuse verdict `New test needed` (`no` / `yes` / `unverified`) `tests suggest` prints — built from the SAME route evidence, so the two surfaces never disagree about one test. `--test` takes the same two key forms as `tests mark` (see above). | 0/2 (unknown or ambiguous key → 2) |
| `gateforge tests diagnose [--suite <name>] [--json]` | Run the configured pytest diagnostic suites once per suite, isolated (own process, `GATEFORGE_*` stripped, finite timeout). Advisory: exit 0 completed run (≥1 pass, no unexpected failures), 1 test failures, 2 unavailable/incomplete (collection error, timeout, missing interpreter, interruption, zero tests, or only skipped/xfail). Never E2E proof. | 0/1/2 |
| `gateforge obligations [--json]` | Evaluate policies against the automatically classified graph and dump obligations, blocking entries, and claim assessments. | 0/1/2 |
| `gateforge check [--changed] [--staged] [--candidate-commit <sha>] [--require-e2e] [--timing] [--no-cache] [--format text\|json\|sarif]` | The full gate: discover → classify → obligations → claims → verdicts → report. `--timing` appends per-step wall-clock timings (detectors, test collection, TS scan, planning, total) — an additive report key in json and one line in text, never an input to any verdict. Detector and pytest-collection results are cached under the excluded run-state dir. Detector keys include plugin config, executable module/script bytes, Python import environment, inputs, interpreter packages, and Gateforge engine version; pytest keys include all Python/config file bytes, collector argv/environment, interpreter identity, and engine version. Unchanged successful pytest collections reuse their node ids; any changed Python byte recollects. Any uncertainty runs fresh. The report carries additive `cache: {hits, misses}` counts. `--no-cache` (or `GATEFORGE_NO_CACHE=1`, or a CI environment) disables cache reads and writes. | 0 clean/waived, 1 unresolved, 2 config/usage error |

| `gateforge test-gates [--changed] [--scope full\|changed] [--progress stderr\|file:<path>\|off] [--result-only] [--suite <cmd>] [--out <dir>] [--format F] [--witness-url <url>] [--run-token <token>]` | The progress stream (additive, `--progress`, or the `run.progress` config key) prints the registered expected-set size, one line per finished test with exact `N/M` counters and the catalog title, an alive line per quiet minute, and the finish line before grading. It is built from witness-side facts only and never from runner output; a failing test's first error line passes a credential guard and is replaced whole when it matches, and the full guarded diagnosis lands in `.gateforge/test-gates/failures.json`. `auto` (the default) is stderr under `CI=true` and off locally. The stream is not evidence and no gate reads it. Supervised `--changed` plans and runs mapped Playwright tests through the trusted adapter, checks planned/executed completeness, and seals an authenticated receipt only after complete success. `--scope changed` limits a sealed slice to obligations affected by changed files; incomplete mappings block, and `check --require-e2e` accepts it only when it covers every currently changed obligation. `--result-only` requires `--changed --scope changed`, reports selected results plus repository debt, and has no gate authority: without an external witness it uses private temporary state; with `--witness-url` it requires `--out` + `--run-token` shared with the external witness in a separate state directory (not the configured authoritative state directory). It never creates or clears a receipt. `--suite` remains legacy and cannot combine with `--changed` or redefine strict expected cases. Verifier keys use `GATEFORGE_WITNESS_VERIFIER_KEY` or the external key ring selected by `GATEFORGE_WITNESS_VERIFIER_KEY_FILE`. | 0/1/2 (suite failure forces 1) |
| `gateforge test-gates --chaos <seed> --result-only` | Timing chaos (additive, opt-in, E63): the witness observation proxy releases proxied app RESPONSES on a schedule derived from `<seed>` — a delay in `[0, maxDelayMs]` per response, and, for requests sharing a route key inside one test session, the option of releasing a later response before an earlier one. Only timing changes; bytes, status, headers and evidence semantics never do. The schedule is a pure function of (seed, session identity, route key, k), so the same seed replays it exactly, and the report plus the sealed execution result carry `chaos: { seed, maxDelayMs, reorder, schedule }` (route key = method + pathname, query stripped) with the text line `timing chaos: seed <n>`. Accepted only with `--result-only`: a chaos run finds races, it never seals a receipt. `run.chaos: { maxDelayMs, reorder }` tunes the bounds of a witness the run spawns itself (default 400 ms, reorder on) and never enables chaos by itself — without the flag every run, report and execution result is byte-identical to before. With `--witness-url` nothing is configured on the witness side: the plan travels with the supervisor-authenticated run-context binding (`options.chaos`), which the witness applies before the first session opens, so `run.chaos` tunes the bounds in both cases. A NORMAL run against a witness that was itself started with `GATEFORGE_CHAOS_SEED` exits 2 before any test runs, naming the variable to unset (a perturbed witness can never seal), and a witness too old to accept run options is refused for `--chaos` rather than reporting a schedule it never applied. A normal run against a witness with no plan — including one too old to have the route — is byte-identical to before. A seed that is not a non-negative integer exits 2 with one plain line. |
| `enforcement.twinPaths` (with `enforcement.twinQueryKeys`) | Twin path coverage (additive, opt-in, E64): links a raw test and its witnessed twin — by `twinOf` in `.gateforge/test-map.yml` or by the title convention `X [witnessed]` next to `X raw` (or the one `X raw: <description>`) — and compares the REQUEST SHAPES each side exercised (method, route template, and the values of the allowlisted query keys; never a URL, a body or a non-allowlisted value). A pair that disagrees is reported as `TWIN_PATH_DIVERGENT`, naming both tests and the exact differing value; `advisory` reports it and leaves the exit code alone, `block` makes it a blocking entry (exit 1). The raw twin's session is marked OBSERVATION-ONLY engine-side, so every submission from it is refused with 403: it can issue no record, no attestation and satisfy nothing, and contributes only its shapes. Absent (or set with no pair linked), nothing is wired, no state file is written and the report is byte-identical. With `--witness-url` the shape plan travels with the run-context binding (`options.twinShapes`: the allowlist and the route inventory as templates), so a repository's own witness needs no twin environment; a witness too old to accept run options records nothing and the run says so in one line instead of reporting twins that agree because nobody looked. |
| `gateforge broker commit --workspace <dir> --message <msg> [--receipt <path>] [--ref <ref>]` | Managed-mode commit broker (MECHANISM, not deployment): snapshots the workspace bytes into a throwaway index, recomputes the input + trusted-policy digests, verifies a valid non-stale gate receipt for EXACTLY those bytes, then creates the commit via compare-and-swap `git update-ref`. Typed rejections (`ENFORCEMENT_UNTRUSTED` / `EVIDENCE_STALE` / `RUN_INCOMPLETE` / `KEY_UNKNOWN` / `BROKER_CAS_MISMATCH` / `BROKER_UNSAFE_MESSAGE`); symlinks/submodules are typed rejections. Verifier keys use either supported environment source; the key file must be outside authority, workspace, and receipt artifact roots. | 0/2 |
| `gateforge key create|import-env|rotate|retire [--file <path>] --confirm` | Owner-only key ceremony. With no `--file` the ring is `${XDG_CONFIG_HOME:-$HOME/.config}/gateforge/verifier-keyring.json` — the parent directory is created, mode `0600` — and every later command reads that same path, so no `GATEFORGE_WITNESS_VERIFIER_KEY_FILE` export is needed; pass `--file <path>` AND export that variable only when the ring lives elsewhere. Creates, imports, rotates, or retires keys without printing secrets. | 0/2 |
| `gateforge pre-commit --scope staged\|full` | The witnessed commit gate: freezes the Git index, materializes it into a scratch checkout, prepares the candidate's staged runtime (`.gateforge/runtime.yml` — below), runs the supervised witness gate INSIDE that checkout (`staged`: only tests mapped to obligations affected by the staged paths, `EVIDENCE_SCOPE_INCOMPLETE` blocks an unmapped affected obligation; `full`: the complete relevant mapped suite), validates the fresh receipt against the same checkout, rechecks the original index/HEAD/MERGE_HEAD, and copies only Gateforge audit artifacts (run state incl. runtime logs) back. Runtime preparation/readiness failures are typed (`RUNTIME_PREPARATION_FAILED` / `RUNTIME_READINESS_FAILED`); child process groups are cleaned up on every exit path. Install via `gateforge init --blocking --witnessed staged\|full`. | 0/1/2 |
| `gateforge enforcement doctor [--json]` | Reports verified enforcement `level` (0–3), hook activation, wired CI templates, and read-only GitHub/GitLab branch-protection results; missing credentials or uncertain responses remain `not verified`. A local hook never counts as server protection. Its `engine:` line reports the install provenance npm's own metadata proves: a tarball/directory install (read from `node_modules/.package-lock.json`, or the manifest's `_resolved`) is named as such instead of claiming the registry, and an install with no readable metadata is reported as unproven rather than as an all-clear. The receipt's `engine.source` is receipt-bound and keeps its meaning. Diagnostic only: exit 0 whenever it runs. | 0/2 |
| `gateforge enforcement pin --pin-file <path> [--confirm]` | Writes the owner-approved policy digest of the STAGED candidate into an env file OUTSIDE the repository. The flag is `--pin-file`, NOT `--env-file`: Node itself consumes `--env-file <path>` (and `--env-file-if-exists <path>`) anywhere in argv — it reads the file and exits 9 on a missing one, so the CLI would never run. The digest is the one the commit gate computes: the index is frozen and materialized exactly as `check --staged` does, and the entries are hashed by the same function. It refuses when a policy input is not fully staged, naming the files. Preview by default — the line it would write, nothing written. `--confirm` replaces exactly the `GATEFORGE_APPROVED_POLICY_DIGEST=<hex>` line, drops a duplicate assignment, leaves every other line untouched, never prints another line of the file, and writes the file mode `0600`. A path inside the repository is refused: the pin must live outside the candidate, because a candidate-controlled file cannot approve policy. A symlink or a non-regular file is refused too (fail closed). | 0/2 |
| `gateforge enforce [--ci github\|gitlab]` | Add blocking wiring to an initialized repository. The provider defaults to GitLab unless GitHub is the only detected CI provider; the explicit flag selects GitHub Actions or GitLab CI. Appending to an EXISTING `.pre-commit-config.yaml` is announced as an action on one line, naming the file as the repository's own and printing the exact way back (`git restore -- .pre-commit-config.yaml` for a tracked file; for an untracked one, which has nothing to restore, the line says to delete the appended entry). The generated GitHub workflow installs `@gate-forge/cli@<version>` from the registry unless `GATEFORGE_CI_ENGINE_SOURCE` is set when the generator runs: it then installs that one npm specifier (a `.tgz` path, a directory, or any specifier) through the step environment, for a release that is not on the registry. Unset the variable and rerun for the registry install. | 0/2 |
| `gateforge adopt` | Adopt an EXISTING repository: run it once, after `init`, on a project that already has code and therefore already has findings. Records today's blocking findings (pin-#2 obligation fingerprints, blocking entries, and the classification-blocked resource identities) into `.gateforge/baselines/obligations.json`, sanctioned by a dated, count-annotated receipt `.gateforge/baselines/adoption.json` — without that receipt a baseline forgives nothing — then applies the blocking wiring through the same idempotent path as `init --blocking`. It is the ONE sanctioned bulk-add and only once per repository: a second `adopt` is a no-op success. The recorded set is shrink-only (`gateforge baseline update` shrinks it) and never forgives new work. With `enforcement.strictE2E: true`, a baselined E2E obligation is not proof and blocks with `ENFORCEMENT_UNTRUSTED` again as soon as a change touches it. `adopt --help` prints this contract. | 0/2 |
| `gateforge baseline update <fp...>` | Shrink the baseline to a strict subset (invariant 4). | 0/2 |
| `gateforge baseline diff <before> <after>` | Compare adopted obligations by ID without printing fingerprints. | 0/2 |

On a repo that already has Gateforge files, `init` reports only what THAT run did: it keeps an existing `.gateforge.yml` and says so instead of claiming to write a preset, and the `undo:` lines it prints name every path the run created (`rm -rf`) and every file it changed in place (`git restore --`, for an appended `.gitlab-ci.yml` include, an appended `.pre-commit-config.yaml` entry, or an added ignore rule) — so following them can never delete pre-existing config, baselines, waivers, hooks or CI files, and a run that changed nothing prints no undo line at all. A preset that wires no local hook says whether your existing commit hook and/or CI job still decide what blocks your commits.

`init` also adds Gateforge's own engine state to `.gitignore` (`.gateforge/test-gates/` — the run catalog, plugin caches, receipts and history the engine regenerates on every run). Without it the first `git add -A` stages the run cache and the gate then blocks on its own files. The file is created when absent and appended to when present, your own lines are preserved, and a second run reports it as already ignored instead of appending again. The same run prints the `undo:` line for it.

`init` reads the repository to recommend detectors, and prefers quoting evidence from application code: hidden dot-folders (agent tooling, tool caches, leftover working directories) are not scanned at all, and a file inside an `archive/`, `vendor/`, `generated/`, `fixtures/`-style directory is only quoted when no application file carries the same signal. The generated `.gateforge.yml` carries the matching default excludes, so the detectors make the same choice.

`init` on a repository that ALREADY has code says so and names the way through the debt it will report on day one: `gateforge adopt` records today's findings as forgiven, shrink-only, and — under `strictE2E` — still blocks on an adopted E2E obligation as soon as a change touches it. A fresh, empty project never sees that block.

`--docs-exclude <folder,...>` and `--docs-exclude-file <path>` are the same owner assertion in two spellings (the file holds one folder per line; blank lines and `#` comments are ignored); they combine into one deduplicated list, and the interactive prompt says the flag exists so a long list does not have to be typed into one prompt.

`--unmatched-routes block|warn` answers, ahead of the terminal question, the
one thing a NEW repository must say about routes whose name matches no
discovered table: gate commits on them, or only report them. In a terminal
`init` asks once ("Routes whose name matches no table: block commits, or
warn only? [block/warn]"); headless it writes `warn` and prints the exact
key that turns blocking on. A repository that already has a
`.gateforge.yml` is never asked and never rewritten here — it keeps saying
nothing, which the `check`/`next` banner keeps pointing at.

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

ONE document, TWO independent key groups that may coexist:
`schemaVersion`, `prepare`, `health`, `services`, `envAllowlist`,
and `executionTimeoutSeconds` are read by the staged/supervised
runtime — `check --staged` and `test-gates` (see
`packages/cli/src/runtime.ts`), where `check --staged` reads
`prepare` (its `command`, `reuse`, `timeoutSeconds`, and
`preflight` sub-keys) — while `env_files`, `reset`, `seed`,
`services_up`, `healthcheck`, and `services_down` are the
`gateforge run` recipe (see `packages/cli/src/run-recipe.ts`),
which also reads `prepare` (its `commands`, `runTimeoutSeconds`,
and `runRetries` sub-keys). Neither group requires the other: a
document may carry both, one, or none of the staged keys. Minimal
combined example:

```yaml
schemaVersion: 1
prepare:
  command: npm ci --offline           # staged runtime (check --staged / test-gates)
  commands: [['npm', 'run', 'build']] # gateforge run recipe step
envAllowlist: [DATABASE_URL]
executionTimeoutSeconds: 1800
env_files: [.gateforge/test.env]
reset: { commands: [['./scripts/reset-db.sh']] }
services_up: { commands: [['./scripts/start-stack.sh']] }
```

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
envAllowlist: [DATABASE_URL]    # operator env names for services and supervised tests
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

### Whole-run budget and the stall bound

By default there is NO whole-run cap. The engine used to kill any supervised
run at 30 minutes of wall clock — a bound nobody declared, and it killed a real
1 101-test Playwright suite that needs two hours while every test was still
passing. A whole-run budget applies only when the operator declares one:

- `runtime.yml executionTimeoutSeconds` — the owner's own budget, honoured by
  the command it is written for (`check --staged` and `test-gates`);
- `--run-timeout-min <n>` — the flag still wins over the document.

What the engine keeps is a STALL bound: if no test has FINISHED for
`runtime.yml stallTimeoutSeconds` (new key, 1–3600, default 15 minutes) the run
is killed and fails closed with
`stalled: no test finished for 15 min (last finished: <title>, <k>/<n>)`. It
rides the same per-test completion signal the `--progress` stream already
consumes, so a run carries one completion signal, not two. A suite that keeps
finishing tests is never killed, however long it takes.

**Playwright only, and here is why.** A stall bound needs a stream of per-test
completions; today only the Playwright pack reads one. The pytest, Vitest,
Cypress and other supervisors keep their historical 30-minute whole-run
default until they can report completions the same way — on those runners an
over-long run still dies at 30 minutes, and `executionTimeoutSeconds` (or
`--run-timeout-min`) is how you raise it.

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

`--test` accepts EITHER of the two key forms the surfaces hand you, and
both name the same test. The catalog `logicalKey` is what `tests discover`,
`tests suggest` and `check` print:

```bash
gateforge tests mark --test 'playwright:chromium:e2e/accounts.spec.ts:Accounts>deletes an account' …
```

The reconciliation key `<file>#<titlePath joined by '>'` — the form
REFERENCE uses for sidecar bindings and the one the runner's own test
events carry — resolves to the same catalog row, so a key copied out of a
report works without a lookup step:

```bash
gateforge tests mark --test 'e2e/accounts.spec.ts#Accounts>deletes an account' …
gateforge tests explain --test 'e2e/accounts.spec.ts#Accounts>deletes an account'
```

The sidecar always stores the `logicalKey` (as above), so a mapping's
identity never depends on which form was typed. When the same file and
title run under SEVERAL runner projects, the reconciliation key matches
more than one catalog row and the error names every matching
`logicalKey` — only that form tells the projects apart. An unknown key
names both accepted forms and, when the file part does exist in the
catalog, lists up to five of that file's real keys.

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

`tests suggest` emits a THREE-STATE reuse verdict, never a boolean:
`no` when the `#1` candidate is an unmocked e2e row that more than ONE
signal supports (an explicit tag naming this resource, or a resource-token
match together with a file that names the route); `yes` when no candidate
survived resolution or every candidate mocks the system under test; and
`unverified` when a candidate exists but ONE signal carries it — a name in
common is not proof the test drives that request, so the next action is
the check (`new test needed: unverified — check that a candidate really
sends <METHOD> <route> before marking (gateforge explain <obligation>)`),
never a ready-made `tests mark` command. An unsupported proof channel
produces a capability task (`VERIFIER_UNSUPPORTED`), never a request to
generate more tests.

### Ranked candidates

Candidates are RANKED by the evidence the catalog row itself carries, not
listed alphabetically: an explicit `@crud(...)` tag, a resource token in the
title path or the file, the obligation's operation word, a route segment from
the run's route inventory, a `real/` (unmocked) folder, minus a mock signal.
Tokens are matched WHOLE-WORD (title path words; file path segments split on
`/ . _ -`), never inside a longer word, and a generated resource id
contributes only its NAME: the plane (`tenant`), the transport (`http`), the
method (`get`), route furniture (`api`, `v1`), the `param` marker that stands
in for a `{route_param}`, and the trailing id hash identify no resource, so
`@crud(tenant.accounts:create)` is never evidence for
`tenant.http-get-api-v1-notifications-…`. A tag is a DECLARATION: only its
resource part (the text before `:` in `@crud(tenant.accounts:read)`, minus the
plane) counts as a resource name, and the tag text itself is stripped before
the title is read as prose — the `:read` in that tag never matches a `…/read`
route segment.
For an `http:*` obligation that operation must also FIT the route's method —
`GET`/`HEAD` read, `POST` create, `PUT`/`PATCH` update, `DELETE` delete. A tag
declaring `create` says the test creates the resource, which is no evidence
that it reads `GET /api/v2/accounts`, so it scores nothing there; with no
other evidence the row is not a candidate and the verdict is `unverified`,
never a `no` that would send the owner to mark a create test as the proof of
a read. A non-transport obligation has no route method to fit, so its tags
stay judged on the resource alone.

Every weight is additive and printed as a `why:` line, so the order explains
itself — the score is never a bare number. Ties break on the logical key, so
the list is deterministic. The text surface prints the top five and says how
many it hid; `--json` carries every candidate with its `rank` and `score`:

```text
obligation: tenant.accounts:persistence:create  cause: TEST_MAPPING_MISSING
  candidates (ranked by evidence):
  - #1 playwright:chromium:tests/e2e/real/account_create_matrix.spec.js:company tenant persists (tests/e2e/real/account_create_matrix.spec.js)
    why: explicit tag names this obligation's resource 'accounts'
    why: lives in a 'real' folder (unmocked)
    ... and 286 more candidate(s) — run `gateforge tests suggest --json` for the full ranked list
```

In `--json`, each candidate's `overlaps` lists the obligations that
DECLARE that test (a `test-map.yml` entry or a `@gateforge` annotation) —
not every obligation the test merely came up as a candidate for. The
candidate list itself is unchanged and still carries every candidate.

`already declared for: …` is printed only when a DECLARATION exists (a
`test-map.yml` entry or an `@gateforge` annotation). An inferred or
prior-run binding is a suggestion, never a declaration, and no longer prints
that line.

### One instruction, not two

When a candidate exists and its verdict is `no`, the suggestion's next
action is to MARK that existing test `observed-e2e` and run it under the
witness (`gateforge tests mark --test <key> --kind observed-e2e
--obligation <id> --reason "…"` then `gateforge test-gates --changed`).
The overlay instruction — write
`tests/e2e/gateforge/<resource>.<op>.spec.js` — belongs to
`newTestNeeded: yes`, i.e. no existing test fits; an `unverified` verdict
asks you to confirm the candidate's request first. A suggestion block
never tells you to write a new overlay test and, in the same breath, to
reuse the test it just listed.

### A declared mapping is visible in `check`

After `tests mark`, `check` says `mapped to: <test keys> (not yet witnessed)`
for every obligation whose test ids are declared but whose records were not
consulted, and its next action names the command that collects the evidence
(`gateforge test-gates --changed`) instead of the generic "write a test"
advice. The JSON report adds `declaredTests` and
`mappingState: "declared" | "declared-not-witnessed"`. Only DECLARED ids
appear there — an inferred or prior-run binding never does.

### Runner file scope (`tests discover`)

The static scan is seeded from Gateforge's own include globs, so it finds
test-shaped calls anywhere in the repository — including files no configured
runner would ever collect. Each runner's OWN file selection is therefore read
as data and decides the row's runner:

- Playwright: the enumeration's project-graph reporter records each
  project's resolved `testDir`, `testMatch` and `testIgnore`. A file outside
  every project's selection is not a playwright test and is not catalogued as
  one.
- Vitest: `vitest.config.*` / `vite.config.*` (at any depth, bounded) are read
  with the TypeScript AST only — `test.include`, `test.exclude`,
  `test.globals` literals, never an evaluated expression. A vitest suite
  inside a playwright-configured repository is catalogued as a vitest row
  with a `runner-file-scope` weak signal naming the evidence; with
  `globals: true`, a bare `describe`/`it` is a registration the runner owns,
  not an `unresolved-test-alias` gap.

Every selection is FAIL-OPEN and says so. A pattern that cannot be translated
(`!`-negated class, unbalanced group), a computed value, a function-valued
selector, or a missing config makes the scope select everything — today's
behaviour — and the runner summary line states which selection could not be
read. A file that NO runner's selection claims keeps the configured runner
and stays a blocking row (`reconciliation-static-only`, carrying a
`no-runner-claims-file` weak signal that says so): ownership is never
invented.
`inventoryComplete` is judged over the CONFIGURED runner's unresolved rows.

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

**A change that is only `docs/**.md` is the engine's own.** No obligation
can arise from a Markdown file, so a commit whose WHOLE changed set is
`docs/**.md` is exempt from the unclassified-change handling — never
candidate-configurable, and denied the moment one non-docs file joins the
commit (a mixed change keeps the docs files as unknown changes, exactly as
before). Since no obligation arises from it, the slice has nothing to prove,
and `test-gates --changed --scope changed` seals a receipt for the current
candidate with ZERO records: `scope: changed`, an empty covered set, and a
`docs-only-slice` execution result naming an expected set that is empty by
decision. It is bound to the same input digest, candidate tree and trusted
policy digest as any other receipt, so `check --staged` finds a current one.
It proves nothing — the commit gate recomputes the docs-only decision from
its own changed set rather than believing the receipt's claim, the empty
covered set satisfies no obligation, and the next product change has a
different input digest and needs its own run. This is separate from
`--docs-exclude` below, which is an owner assertion about input hashing and
is never required or implied by it.

**Developer and CI tooling is owner-declared.** A `scripts/e2e/run.sh`
only `package.json` scripts name, or a custom reporter the runner
configuration NAMES but no test imports, is test infrastructure by
different evidence — the import graph roots at the runner configurations
too, so a `reporter`, `globalSetup`, `globalTeardown`, project
`storageState` or `require.resolve('./…')` path that resolves to an
existing file is attributable, together with its own import closure. What
NOBODY names, the owner declares: `project.paths.testTooling` in
`.gateforge.yml` takes a list of globs, and a changed file matching one is
attributed `test-tooling:<file>`. The pass is deliberately weak — it
EXPANDS the evaluation scope exactly like test infrastructure (so a change
to declared tooling is never proven by a slice of the suite) and it is
NEVER `CHANGE_UNMAPPED`. It cannot hide product code: a discovered
resource's own source keeps its own treatment, and a glob that matches
one is a config error — `gateforge check` exits 2 and
`gateforge enforcement doctor` fails a `test-tooling` row, both naming the
file and the glob. The key lives in `.gateforge.yml`, so it is inside the
approved policy digest: widening the list needs your pin re-approved.
Absent means today's behaviour, byte for byte, digests included.

**Gateforge's own files are policy inputs.** The config, the policy,
classification, behavior and runtime documents, the exclusion declarations,
the mapping sidecar, the adapter/waiver/baseline/quarantine records, the
generated gate wiring (hook script, CI job templates, `GATEFORGE.md`, the
overlay-proof README, the engine reference) and your CI/pre-commit config
*while they still carry Gateforge's managed block* are policy inputs, not
product files: a change to one of them is never an unmapped `CHANGE_UNMAPPED`
change, and a change set that contains only those files cannot change product
behavior — so it does not drag your adopted E2E obligations into a strict
re-grade, and the setup/adopt commit passes `check --changed` without
`--no-verify`. Their integrity is governed exactly as before: they are inside
the approved policy digest, so a change to them needs your pin to be
re-approved, and a mismatching pin still blocks. Deleting the gate job from
your CI config, or
the entry from `.pre-commit-config.yaml`, is not a policy input — it goes back
to blocking. Everything Gateforge does not own (your source, tests, runner
config, manifests, ignore controls, documentation you did not exclude) keeps
today's treatment, including the scope expansion that makes a policy change
re-check the whole repository.

### Adoption mode: the first commit that wires the gate

The commit that introduces the gate always touches gate-defining inputs — the
manifest, `.gateforge.yml`, the runner configuration, the mapping sidecar and
the specs — so the evaluation expands to EVERY obligation in the repository,
while the only affordable proof of a large repository is
`test-gates --changed --scope changed`. Before 0.10.2 the hook refused that
receipt as a scope mismatch, so the first commit of every adopting repository
had to be committed with `--no-verify`.

A commit is judged in **adoption mode** when, and only when:

1. HEAD has NO gate — no `enforcement` block in its `.gateforge.yml`, and no
   generated `.gateforge/hooks/gateforge-check.mjs`; and
2. the candidate DOES wire one (it introduces `.gateforge/hooks/` /
   `.gateforge/ci/` wiring, or turns `enforcement` on); and
3. the candidate's trusted policy digest matches your owner-approved pin.

Condition 1 is monotone and one-shot: once a gate exists at HEAD it can never
hold again, so no later commit can re-enter adoption mode. The mode is
COMPUTED from the base revision — there is no flag, no config key and no
environment variable a candidate could set.

What it changes:

- **Which obligations must be proven.** A sealed `--scope changed` receipt for
  the SAME staged candidate tree is accepted; only the obligations whose
  source files this change set touches must be inside the receipt's
  `coveredFingerprints`. Every obligation the commit does not touch stays
  unproven debt, recorded by `gateforge adopt` and still named in the report.
- **Adopted debt survives the strict-E2E re-grade** when the change set is
  product-behaviour-neutral — every changed file is a policy input, a
  gate-defining input, a catalog test file, test infrastructure, a
  runtime-declared input or `docs/**.md`, and NO discovered resource's source
  is in it — and your pin is enforced. One changed product source in the same
  commit denies it, and the debt is re-graded blocking exactly as before. (An
  owner WAIVER is never forgiveness: strict E2E re-grades it either way.)

What is still refused in adoption mode, unchanged: a policy-input pin
mismatch; a sealed receipt that does not cover the staged bytes (see
"The candidate tree a sealed receipt is bound to" below); a
`CHANGE_UNMAPPED` file; an obligation the change newly claims with no
mapping or no sealed evidence; and any commit after the first one. Adoption
mode moves WHICH obligations must be proven, never WHO may approve the
policy.

### Adopted debt after adoption

`gateforge adopt` records the debt a repository already carries, and under
`enforcement.strictE2E` a baselined obligation is still not proof: every
adopted `missing` verdict is re-graded blocking. From 0.10.3 that made the
FIRST commit after setup — the one that adds tests, the mapping sidecar and
runner configuration, with no product code at all — demand proof of every
adopted obligation, which no scoped run can produce.

`enforcement.adoptedDebt` is the owner-pinned setting that decides it:

- `lenient` (the DEFAULT; the key may be absent) — the adopted baseline keeps
  its forgiveness on any change set that carries no product behaviour: every
  changed file is a policy input, a gate-defining input (including the
  manifest and lockfile), a catalog test file, test infrastructure, a
  runtime-declared input, declared `testTooling`, or documentation, and NO
  discovered resource's source is in it. Such a commit demands receipt
  coverage of the obligations it NEWLY CLAIMS — the same slice an adoption
  commit demands — and the adopted debt it cannot have affected stays named,
  forgiven debt. Any discovered resource's source in the change set denies
  the neutrality, and the debt is re-graded blocking exactly as before.
- `strict` — the 0.10.3 treatment: only an ADOPTION COMMIT (the one-shot,
  computed condition above) keeps the forgiveness, so every later commit
  re-grades adopted debt blocking again.

What the setting never moves: the owner pin is required in BOTH values
(`evaluateApprovedPolicy(...).status === 'enforced'`, or nothing is
forgiven), a newly claimed or newly arising obligation is still graded on
its own evidence in both values, and an owner WAIVER is never forgiveness —
strict E2E re-grades it either way. The key lives in `.gateforge.yml`, so its
bytes are inside the approved policy digest: flipping it is a policy-revision
change the owner re-approves, never something a candidate grants itself.
`gateforge init --preset strict` writes no key, so a preset install gets the
lenient default like every other configuration; declare `strict` in
`.gateforge.yml` to keep the 0.10.3 treatment.

### The owner answers and the generated wiring are owner-pinned

The owner-answers document and `.gateforge.yml` are owner-owned
policy inputs: they are classified as such, so they are never unmapped product
changes and never expand the evaluation scope — but that exemption is only
honest while your approved digest binds their bytes. Before 0.10.2 nothing
bound them, so a candidate could narrow `clientScanRoots` (deleting
obligations) in the same commit and the pin still matched. Their bytes are now
inside the approved policy digest, and so are the generated `.gateforge/hooks/`
and `.gateforge/ci/` wiring, for the same reason: deleting the generated hook
is a policy-revision change, not a way back into adoption mode.

**Upgrading:** a repository that ships a pack config or the generated gate
wiring re-pins ONCE, after upgrading —
`git add -A .gateforge .gateforge.yml && gateforge enforcement pin --pin-file
<path outside the repository> --confirm`. A repository with NO pack config
keeps a byte-identical digest: an absent config adds no digest entry and no
absence marker.

### The candidate tree a sealed receipt is bound to

A candidate tree is the raw-ingested workspace a run tested, so it also
carries that workspace's untracked and gitignored bytes — `node_modules/`, a
blob report, a Playwright storage state. `check --staged` therefore binds a
sealed receipt by CONTAINMENT, not by string equality: the receipt is
accepted when the sealed candidate tree carries every path of the frozen
index tree with the SAME mode and blob, and refused when a single staged
byte is missing or differs. Two shapes therefore work, and neither is a
weakened commitment:

- a receipt sealed INSIDE a staged checkout (`gateforge pre-commit`), whose
  candidate tree is the prepared checkout itself;
- a receipt sealed in the WORKSPACE (`gateforge test-gates --changed`)
  while every tracked byte is staged — its candidate tree is a superset of
  the index tree, and the input digest (which must still equal the digest
  the checkout computes) pins the rest.

An unreadable receipt, an unreadable tree listing, or any difference falls
back to the previous, stricter test: the receipt's candidate tree id must
equal the frozen index tree.

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
option keeps the default. Gateforge writes the approved declaration into
`.gateforge.yml`, under `evidence.exclude.docs`, and prints the candidate
trusted-policy digest to approve through the protected
`GATEFORGE_APPROVED_POLICY_DIGEST` setting. Gate checks refuse to use the
exclusions until that external pin matches. A later change to the declaration
changes the digest; use `--confirm-doc-exclusions` when `init` changes an
existing approval. The declaration is inserted as text, so the rest of your
`.gateforge.yml` (comments, key order, quoting) is preserved byte for byte.
Before 0.10 this list lived in its own `.gateforge/docs-exclusions.yml`; a
repository that still carries that file is refused by name until
`gateforge migrate --confirm` moves it.

The project states these folders do not affect the product or its tests.
Gateforge does not prove this. If application or test code reads an excluded
file, a later edit can make old evidence look valid without running the tests
again. Reports show the approved folders, pin identity, and this reduced
guarantee. Gateforge rejects exclusions that contain configured scan inputs,
source files, gate or trust metadata, manifests, lockfiles, or symlinks.
Every file must also use a supported document, data, or raster-image format.
Besides Markdown, reStructuredText, plain text, PDF, and static raster images,
an excluded folder may hold `.json`, `.yaml`, `.yml`, `.csv`, and `.html`
files. Refusal is by name first, so `package.json`, `tsconfig.json`,
`.pre-commit-config.yaml`, `.gitlab-ci.yml`, `pnpm-workspace.yaml`,
`composer.json`, any `*.config.*` file, and lockfiles stay refused inside an
excluded folder. MDX, WASM, SVG, and unknown formats fail closed. HTML is
accepted only as content of a declared folder; elsewhere it keeps full
evidence identity. This format allowlist does not prove that an allowed file
cannot affect application or test behavior; the project assertion and its
reduced guarantee still apply.

**Owner-declared Python bytecode exclusions (explicit trust mode).** By
default, Python bytecode remains part of candidate and input identity. To
exclude only exact generated cache files, run
`gateforge init --cache-exclude src/__pycache__/module.cpython-313.pyc`.
The command writes the list into `.gateforge.yml` under
`evidence.exclude.cache` and prints the trusted policy digest to approve
outside the repository. A matching protected
`GATEFORGE_APPROVED_POLICY_DIGEST` pin is REQUIRED before a gate uses the
list; changing an existing list requires `--confirm-cache-exclusions`. Before
0.10 this list lived in `.gateforge/cache-exclusions.yml`, and
`gateforge migrate --confirm` moves it.
Only exact `.pyc` or `.pyo` files directly under `__pycache__` are allowed;
globs, symlinks, configured inputs, and other file types fail closed. Reports
show the exact files, pin status, and reduced trust guarantee. This is an
owner assertion, not proof that the excluded bytecode cannot affect runtime
behavior.

**Re-pinning the approved policy digest.** The pin is one aggregate hash, so a
mismatch alone never said WHICH input moved. Two things answer that now.
`gateforge enforcement doctor` reports `policy-inputs-vs-HEAD` — the
trusted-digest inputs whose STAGED bytes differ from HEAD, named one by one
(`policy inputs changed since HEAD: .gateforge.yml, .gateforge/runtime.yml`); a
whitespace-only edit counts, because it moves the digest — and `approved-digest`,
which compares the provisioned pin with the STAGED digest: `matches staged`,
`does NOT match staged (changed inputs: …)`, or `absent`. Both rows read the one
entry list the digest is computed from, so they cannot disagree.
`gateforge enforcement pin --pin-file <path> [--confirm]` then writes that value
for you. The policy inputs it covers are `.gateforge.yml`, the policies and
classification-policy documents, `.gateforge/test-map.yml`, the behavior and
runtime documents, the adapters, waivers and quarantine directories, and every
local in-process plugin module. Stage every policy file first: the pin digests
the STAGED bytes, and a working tree that differs from the index is refused by
name instead of pinning a revision the gate never digests.

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
| `http:request-observed`, `http:response-status-ok` | AVAILABLE — engine browser, or the Observe channel for tests mapped `observed-e2e` (an exchange the witness proxied in the test's own session; test attribution is suite-claimed). The engine path grades FIRST and its verdict is final: a `satisfied` grade keeps its own record ids, and an `invalid` one (a witnessed exchange of a different endpoint, a non-2xx response) is an engine-found error no second channel may mask. The Observe channel is consulted only when the engine path found nothing |
| `http:frontend-request-observed` | UNAVAILABLE — no independent browser/test attribution channel; explicit selection remains blocking `missing` with `VERIFIER_UNSUPPORTED` |
| `crud:*` (UI-semantic) | FAIL-CLOSED — the tested suite owns the browser; use `persistence:*` |
| `http:effect-verified`, `http:read-result-verified` | AVAILABLE (behavior-case channel) — graded across the approved required cases with witness-issued `behavior.case` records; needs a compiled `behaviorPolicy` requirement set |
| `auth:*`, `validation:*`, `task:*`, `webhook:*`, `workflow:*` | AVAILABLE (behavior-case channel) — same required-case aggregation over engine-controlled requests with independent state scopes. A repository that declares no case for the obligation stays blocking `missing`: the grader never falls back to transport evidence |


A behavior case may declare a `signatureProfile` on its `request`
action: an algorithm plus bounded `;key=value` parameters
(`header`, `timestampHeader`, `toleranceMs`, `attemptHeader`,
`attempt`, `forgery`). One parser serves both the config schema and
the witness driver, so `hmac-sha256;forgery=signature` is understood
identically at parse time and at run time and an unknown parameter is
refused rather than defaulted. The signing secret is read only from
the trusted lease; the signature always covers the exact bytes on the
wire.

Unsupported proof stays blocking. Nothing silently replaces browser proof
with HTTP status proof.
`gateforge init` includes the available transport-only contracts for consumed
HTTP endpoints in new installations. Existing policies are unchanged;
explicitly requiring `http:frontend-request-observed` still blocks. The init
scan names that unavailable channel once as not yet provable.

### Observation scope for HTTP endpoints (opt-in policy option)

By default an `http.endpoint` owes the observation contracts
(`http:request-observed`, `http:response-status-ok`) only when a
`consumed: true` policy matches it — the static join with the frontend.
A brand-new route that no UI calls therefore owes nothing, and "you
forgot a test" stays invisible: `check` exits 0.

The pinned policies document (`.gateforge/policies.yml`, the trusted
policy) takes one additive option that widens that scope:

```yaml
schemaVersion: 1
options:
  'http.endpoint.requireObservation': all   # or 'consumed' (the default)
policies:
  - id: frontend-consumed-endpoints-transport-only
    when:
      kind: http.endpoint
      consumed: true
    require:
      - http:request-observed
      - http:response-status-ok
```

- Absent (or `consumed`): today's behavior, byte for byte. A document
  without the `options` section generates the same obligations, the same
  report and the same exit code it always did.
- `all`: EVERY discovered endpoint owes the observation contracts of a
  `consumed: true` endpoint policy. An unmapped one is `missing` with the
  existing `TEST_MAPPING_MISSING` cause and the existing overlay next
  action. Existing routes are not re-litigated: run `gateforge adopt`
  once (the sanctioned bulk-add) and the adopted baseline forgives them,
  so only NEW routes block.
- The option never widens a `consumed: false` policy, a policy that does
  not name the `http.endpoint` kind, or anything that is not a route; it
  adds no contract, cause code or exit code.
- It lives in the pinned policy document, so an agent cannot widen or
  narrow the scope by itself — that is a policy revision.
- `gateforge next` names the option on the one item it explains (an
  unmapped obligation on a route the frontend never calls while the
  option is `all`) and stays silent everywhere else.



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
- `enforcement.adoptedDebt:` — `lenient | strict` (default `lenient`): how
  ADOPTED debt is treated under `strictE2E` after the adoption commit. See
  "Adopted debt after adoption" below.
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
- `project.paths.testTooling:` — globs the owner asserts are test/developer
  tooling (`scripts/e2e/**`, `tools/dev/**`). A changed file matching one is
  attributed `test-tooling:<file>`: scope-expanding exactly like test
  infrastructure and never `CHANGE_UNMAPPED`, and never a pass over a
  discovered resource's own source — a glob that matches one is a config
  error (`check` exits 2). Optional; inside the trusted policy digest, so
  changing the list moves the approved revision. See "Developer and CI
  tooling is owner-declared" above.

## Pages

Each detected frontend route creates two page promises: `page:loads` and
`page:data-ok`. Existing Playwright journeys prove them through the browser
fixture (channel `observed`); after the tests, the referee sweeps only pages
without a clean observed record (channel `swept`). A clean test visit always
takes precedence over the sweep. Both channels use the same route, redirect,
crash, error-marker, and API-response grader. Browser API tampering in tests
is refused as `PAGE_OBSERVATION_TAMPER_RISK`.

Configure the reader and audience in `.gateforge.yml`:

```yaml
pages:
  router: react-router
  audiences:
    - name: tenant
      loginRoute: /login
      guard: TenantGuard
  errorMarkers: ['Something went wrong']
  params:
    '/orders/:id': { id: 'seeded-order-id' }
  exclude: []
  sweep: true
```

`pages.params` supplies seeded IDs for dynamic routes. When no seed is
configured, the referee can use a unique engine-observed create ID for the
route's matching resource; ambiguous or unmatched IDs are never guessed, and
produce `PAGE_PARAM_UNBOUND` with the page left unproven. `pages.sweep: false`
disables referee visits, so an unopened page remains visible as unproven debt.
The sealed `test-gates` JSON and text reports include a `pages` section with
each page's route, proof channel, test/referee, status, and reason. Use
`gateforge explain <page-obligation-id>` for that page's latest proof details;
`gateforge next` names the visit, seed, or failure fix.

## Owner answers (`.gateforge/classification-policy.yml`)

The repository-wide deterministic classification ANSWERS. `gateforge init`
scaffolds the file; every key is an owner answer, and the file participates
in the trusted-policy digest, so changing it re-approves any approved policy
pin before strict gates run.

| Key | What it decides | Shape |
| --- | --- | --- |
| `trustedInternalEntryPoints` | which entry-point categories certify internality | category + patterns + detector |
| `internalRules` | organization rules for internal resources | `resourceName` / `resourceKind` patterns |
| `lifecycleRules` | operations that structurally do not exist, for one EXACT resource | exact `<plane>.<resource>` + `disable` |
| `deleteRules` | how removal manifests, per source glob (a RESOURCE's own answer) | `match` glob + `semantics` (+ `archiveFields`) |
| `planes` | the plane of a source tree or table set (see [below](#endpoint-plane-rules-the-planes-section)) | `rules[]` of `match`/`tables` + `plane` + `reason` |
| `endpoints` | capabilities detector facts cannot see (see [below](#endpoint-capability-rules-the-endpoints-section)) | `rules[]` of selectors + `capability` + `reason` |
| `rules` | business rules a named test type must prove (see [below](#business-rules-the-rules-section)) | `rules[]` of id + title + cases + `test` + `enforcement` |
| `coverage` | which detector must examine which files before a proof counts | capability + detector + globs (+ `exhaustive`) |

Since 0.11.0 this document holds ONLY answers. The four scanner settings
(`scanRoots`, `coverage`, `declarations`, `volatileFields`) live in
`.gateforge.yml` under [`scan:`](#scanner-settings-gateforgeyml-scan), and
`.gateforge/planes.json`, `endpoints.json`, `http-clients.json` and
`fastapi.json` are sections of one of the two documents — run
`gateforge migrate` to move them (see [Migrating to 0.11](#migrating-to-011)).

Unknown keys, an unknown value, and two rules answering the same target
are refused (exit 2, fail closed) — the document is an input, never a
place to smuggle intent past the schema.

## Business rules (the `rules:` section)

Owner-declared statements about the product — "an invoice can only be
cancelled while it is unpaid" — that a test of a NAMED type must prove in
a sealed supervised run (0.12.0). The section lives in the answers
document, so it is owner-pinned: adding, weakening, deleting a rule, or
making it advisory changes the trusted-policy digest and re-approves the
pin. A repository without a `rules:` section is byte-identical to a
release without the feature.

```yaml
rules:
  - id: invoice-cancel-only-unpaid
    title: An invoice can only be cancelled while it is unpaid
    subject: invoices            # optional; must exist in the inventory (unknown -> exit 2)
    test: e2e                    # e2e (default) | pytest
    enforcement: block           # block (default) | advisory (+ required advisoryReason)
    cases:
      - id: unpaid-can-cancel
        describe: Cancelling an unpaid invoice succeeds and it shows as cancelled
      - id: paid-cannot-cancel
        describe: Cancelling a paid invoice is refused and it stays paid
```

A rule's CASES are its observable consequences (usually a positive and a
negative side; a rule without `cases:` has one implicit `default` case).
A case is mapped by the claim id `business-rule:<ruleId>/<caseId>` — the
same sidecar (`tests mark --rule <ruleId>/<caseId> --test <key> --kind
<kind> --reason "…"`) and the same resolver as obligations, so stale,
ambiguous, quarantined and inferred-only declarations behave exactly as
they do there.

**A declaration is never proof.** The type table decides what proof each
mapped test owes, and every mapped test of a case must deliver it — a red
test is never forgiven by a green sibling, a mocked spec never proves an
end-to-end rule, and a test the run's graded slice did not select is
reported `unproven`, never satisfied and never silently absent.

| `test:` | Accepted kinds / runner | Required proof per mapped test |
| --- | --- | --- |
| `e2e` (default) | `browser-e2e`, `observed-e2e` (runner playwright) | Executed in the sealed supervised run, passed, AND witness evidence attributable to that test's own session: an engine `ui.action` anchor (browser-e2e) or a witnessed `http.request` exchange of its session (observed-e2e). The channel is named in the output (`engine` / `observe`). |
| `pytest` | `unit`, `integration`, `server-e2e` (runner pytest) | Executed inside the WITNESSED pytest suite of the sealed run and passed (channel `execution`). Not run, or the suite not declared `witnessed`, stays `unproven` — no weaker labelled proof. |

Case statuses, in the evaluator's own words: `unmapped`
(`BUSINESS_RULE_TEST_MISSING`), `wrong-type`
(`BUSINESS_RULE_TEST_TYPE_MISMATCH` — a weaker kind never satisfies a
stronger type), `failing` (`BUSINESS_RULE_TEST_FAILING`), `unproven`
(`BUSINESS_RULE_TEST_UNPROVEN` — no sealed run, test not executed,
outside the graded slice, or missing the type's proof), and `satisfied`
with the proof channel. Findings are run-wide — never diff-scoped away —
and an `enforcement: advisory` rule's findings ride the report's advisory
channel every run, out of `blocking` and out of the exit code.

**Honest scope of the proof.** Gateforge proves the named test exists,
ran under supervision, passed, and (e2e) exercised the real app through
the witness. It does NOT prove the test asserts the rule's meaning: the
mapping's `reason` carries that claim, the owner reviews it, and the
output always names which of these was proven. `gateforge next` prints a
starter test and the exact mark command per missing case; `init --rules`
adds a commented example to the answers document.

## Scanner settings (`.gateforge.yml` `scan:`)

The machine-wide settings that decide what a closed-world proof may claim.
**REQUIRED**: a repository that has not answered them fails the config load
(exit 2) instead of silently getting the weaker today's-default behaviour.
They live in `.gateforge.yml`, so they are inside the owner-approved policy
digest exactly like the answers they replaced — moving the bytes between
documents never moves them out of the pin.

| Key | What it decides | Shape |
| --- | --- | --- |
| `scanRoots` | the files a closed-world proof must cover | repo-root-relative globs, non-empty |
| `coverage` | which detector must examine which files before a proof counts | capability + detector + globs (+ `exhaustive`) |
| `declarations` | the declaration syntax detectors may emit | detector key → source string |
| `volatileFields` | bookkeeping columns that never satisfy an update | column names |
| `httpClients` | HTTP client-scan settings (was `.gateforge/http-clients.json`) | `clientSymbols`, `wrapperFunctions`, `urlBuilders`, `sameOriginHosts`, `clientScanRoots`, `serverScanRoots` |
| `fastapi` | Python import roots (was `.gateforge/fastapi.json`) | `importRoots` |

## Migrating to 0.11

0.11.0 folds four owner-answer FILES into the two documents above. Nothing
reads the old files: a repository that still carries one is refused **by
name**, with the command that moves it, because silently ignoring a file
would silently drop the owner's declaration and quietly change what the
engine may conclude.

`gateforge migrate` previews by default (prints the exact diff, writes
nothing) and applies with `--confirm`:

| From | To |
| --- | --- |
| `.gateforge/planes.json` | `planes:` section of the answers document |
| `.gateforge/endpoints.json` | `endpoints:` section of the answers document |
| `.gateforge/http-clients.json` | `scan.httpClients` in `.gateforge.yml` |
| `.gateforge/fastapi.json` | `scan.fastapi` in `.gateforge.yml` |
| `scanRoots` / `coverage` / `declarations` / `volatileFields` at the top of the answers document | `scan:` in `.gateforge.yml` |

Each section is spliced in at TEXT level — every other byte of both
documents survives, and the comment above a moved key travels with it. Every
old value is validated by the reader that will read it after the move BEFORE
anything is written, so a migration can never leave a repository that cannot
load. The command is idempotent: a repository with nothing to migrate prints
`nothing to migrate` and exits 0.

**Upgrading:** run `gateforge migrate --confirm`, then re-approve the
policy digest once (`gateforge enforcement pin --pin-file <path> --confirm`).
The digest moves exactly once, at the re-pin.

**Upgrading Gateforge or dependencies:** do it in that order — upgrade
first, re-seal second, commit both together. The manifest and the lockfile
are gate-defining inputs, so they are inside the sealed receipt's
`inputDigest`: bumping either one (or Gateforge itself) invalidates the
proof the last run sealed, and the commit is then refused with
`evidence-context: … inputDigest does not match the current input
snapshot`. That refusal is CORRECT — old evidence cannot certify changed
configuration — so re-seal it with `gateforge test-gates --changed`
(without `--scope changed`: a change set that holds no product source has
no runnable slice) before committing. Committing the upgrade alone leaves a
commit that cannot pass; committing the upgrade and its re-seal together
leaves one that always can.

### Owner-declared delete semantics (`deleteRules`)

Delete semantics are proven, never guessed. A detector that reads the
model's own declaration can prove `hard` or `archive`; when nothing
proves them, the resource stays `unclassified` and blocks with
`DELETE_SEMANTICS_UNRESOLVED` (no obligations accrue, and `gateforge
explain <resource>` names the resource and its source file). `lifecycleRules`
can DISABLE delete for one exact resource; declaring semantics is the
other half of the answer, and it needs a pattern because one declaration
usually covers a whole model tree.

`deleteRules` are the answer for a RESOURCE — their `match` names that
resource's source file, so one declaration answers every DELETE route
linked to it. They are not the answer for a DELETE ROUTE THAT LINKS NO
RESOURCE (a link-row teardown, a draft discard, a cache purge): there is
no resource to match a glob against. Declare those in the
[`endpoints:` section](#endpoint-capability-rules-the-endpoints-section)
as `crud-archive` / `crud-delete`, which needs no model. A DELETE with
neither stays `ENDPOINT_SEMANTICS_UNRESOLVED` — a word like `archive` in
a handler name is not evidence about a model that is not there.

```yaml
deleteRules:
  - match: 'backend/models/session/**'
    semantics: hard
    reason: 'Sessions are removed the moment the tenant logs out.'
  - match: 'backend/models/invoice/**'
    semantics: archive
    archiveFields:
      status: archived
    reason: 'Invoices are retained for the audit window.'
```

- `match` is a repo-root-relative glob over the SOURCE FILE of the
  resources it declares for — the same glob engine the `planes:` section
  uses. It must stay inside the repository.
- `semantics` is `hard` or `archive`. `archive` REQUIRES non-empty
  `archiveFields`: the owner-owned archived state (e.g.
  `{status: archived}`) the engine grades removal against. `hard` must not
  carry the key — a permanent removal has no archived state.
- `reason` is required and is shown with the rule in traces.

Write it with the command, which previews without `--confirm` and writes
with it (folder answers become `match: '<folder>/**'`):

```sh
gateforge classify delete backend/models/invoice archive \
  --archive-field status=archived \
  --reason 'Invoices are retained for the audit window.' --confirm
```

Declaring semantics is an evidence CONTRACT, not an override: the rule
contributes the same delete-semantics / archive-state evidence a detector
would. Detector evidence that disagrees therefore still blocks — the
conflicting-semantics detail names the owner declaration — and nothing is
ever silently overridden. A resolved decision names the rule it used
(`DELETE_SEMANTICS_OWNER_RULE(<match>)` in the trace), and a resource
outside every `match` is exactly as it was.

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

**Gitignored files are not scanned.** Untracked files Git ignores —
anything a `.gitignore` at any depth, or `.git/info/exclude`, excludes —
never enter the detector input list, so a dirty working copy (a built
`playwright-report/`, a cache tree, local output) produces exactly the
scan a clean clone of the same commit does. TRACKED files are always
scanned, even when an ignore pattern matches them: Git's own semantics.
The user's global excludes file is deliberately not consulted, so the
same repository scans identically on every machine; only repository
state decides. Outside a Git work tree (or without `git` on `PATH`)
nothing is skipped. The evidence digest still hashes configured scan
inputs even when Git ignores them, so an edit to an ignored file still
invalidates old evidence — the digest is a deliberate superset of the
scan, never a subset.

## Endpoint plane rules (the `planes:` section)

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

Absence of the `planes:` section is normal and byte-identical to not
having this channel; a malformed document (bad JSON, unknown keys, a rule
without `plane`/`reason`, an absolute or `..`-escaping `match`) fails the
run closed at startup (exit 2).

### Review an endpoint plane

When `next` cannot resolve a route's plane, it asks which data boundary owns
the route and prints one command for each supported choice. Run only the
choice the owner has reviewed. `classify plane` takes one repo-relative
file path, FOLDER, or glob, one plane, and a non-empty reason:

```sh
# one router file (as before)
gateforge classify plane 'src/routes.js' tenant \
  --reason 'Owner review confirms tenant-owned records for this route.'

# a whole router folder — written as the rule 'src/routes/**'
gateforge classify plane 'backend/api/v1' tenant \
  --reason 'Every router in this folder serves tenant-owned records.'

# your own glob, matched verbatim
gateforge classify plane 'backend/api/v1/*_admin.py' master \
  --reason 'These admin routers serve operator-managed records.'
```

The default is a dry run: it prints the exact config diff and does not write.
Add `--confirm` to append the rule to the **existing** `planes:`
section of the owner-answers document. The command never creates that
section,
replaces a rule, or writes an internality declaration; a source outside the
repository (absolute, drive-qualified, backslashed, or `..`-escaping) is
refused, and a new rule that would overlap an existing one with a different
plane is refused too — conflicting rules must be resolved by editing the
owner-reviewed config. This file is a classification input, so changing it
changes the trusted-policy digest; an approved policy pin must be
re-approved before strict gates run.

The alternative in `next` is owner-only: use the existing
`.gateforge/classification-policy.yml` `internalRules` declaration only when
the route is genuinely internal. Internal rules still require the existing
internality certificate; they are not overrides.

## Endpoint capability rules (the `endpoints:` section)

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

Resource linkage accepts the path-derived name or its singular form with
one trailing `s` removed: `/items/{id}` can link to model `item`.
Exactly one discovered model must match, and a schema symbol or whole
handler-name word must corroborate it. Name coincidence alone never links;
if both `items` and `item` exist, the compiler blocks the ambiguity rather
than preferring one.

Evaluation per endpoint identity, deterministic and fail closed:

- **All matching rules agree** → the capability is declared (composed
  with detected ones; overlapping agreeing rules are one declaration).
  A declared `crud-delete`/`crud-archive` on a DELETE endpoint resolves
  the archive-vs-hard question the linked model could not prove.
  The declaration also supplies that evidence to the linked model's
  classifier. Conflicting model/route semantics still block; an archive
  declaration still needs the model's archive-state evidence.
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

### Answering `ENDPOINT_SEMANTICS_UNRESOLVED`

When `gateforge next` prints that code, the run has found an endpoint and
cannot tell what it DOES; the remedy is an owner-authored rule, not
another read-only command. The printed block carries the whole answer for
THAT endpoint: its own method and canonical path as the selectors, the two
owner-chosen fields (`capability`, `reason`) marked in the snippet, and the
allowed values. Answer it by replacing the two marked fields and writing
the file (append the rule to `rules` when the file already exists), then
prove it applied with the printed `gateforge explain <endpoint-id>` — its
`capabilities:` line names the capability and its trace says
`endpoints:`.

The shortest useful file — one exact endpoint, no glob at all — is:

```json
{
  "rules": [
    {
      "method": "DELETE",
      "paths": ["/items/{item_id}"],
      "capability": "crud-archive",
      "reason": "The handler sets archived_at; the row is never removed."
    }
  ]
}
```

`paths` patterns are globs on the canonical path (`*` within a segment,
`**` across segments, `?` one character); a path with no wildcard is an
exact selector, which is what you want for one route. On a `DELETE`, the
capability is the archive-vs-hard answer (`crud-archive` /
`crud-delete`) and nothing else resolves that block; on any other verb it
is the closed vocabulary above. A rule left with a placeholder capability
fails the run closed at startup (exit 2) with the allowed values named.

### Answering `ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED`

This code says one thing: the route reads a single entity, and the name
its path carries is not a name Gateforge found among your resources.
`GET /api/v1/reports/logs/{}` served by a table called `report_logs` used
to produce nothing at all, which read like a route that does not
exist. The entry names the route, the name it derived, and up to three
discovered resources whose last `_`-segment could be the same thing.

Those names are CANDIDATES, never links. Gateforge links an endpoint to a
resource only on an exact name plus a corroborating fact (a response or
request schema named after it, or a handler named after it), and it does
not do that here. If one of the candidates is right, give the route the
evidence: name the response model or the handler after the resource, or
declare the missing mapping. If none is right, the route genuinely serves
something the resource graph does not model. A route that links, a route
with nothing near it, and any collection route are unaffected.

Whether the entry BLOCKS is the owner's call, in `.gateforge.yml`:

```yaml
endpoints:
  unmatchedRoutes: warn   # the default; `block` gates commits on them
```

Absent the key means `warn`: the entries are reported under this same code
in the advisory channel, `check --changed` does not block on them, and
`check` and `next` print a banner at the top with the count, the first
three examples and the key above — a repository that upgraded must not
start failing commits over a finding it never chose. `warn` says the same
thing with the "you have not chosen" sentence gone; `block` makes the entry
a blocking entry like any other. `gateforge init` asks once in a terminal
and takes `--unmatched-routes block|warn`.

## Proposing planes at init (`gateforge init --planes`)

`gateforge init --planes` runs discovery over the repo's own include and
exclude configuration and PROPOSES a `planes:` section from the
directories the discovered tables live in: one non-overlapping `match`
glob per model tree, `master` for trees whose path names a control-plane
segment (`admin`, `master`, `control`, `root`, `operator`), `tenant`
otherwise, and a reason on every rule naming the directory it was
inferred from. The keyword mapping IS a heuristic — that is why the file
is a review artifact: it is written only after explicit consent (flag,
or the TTY prompt), only when absent, and must be reviewed before the
next run reads it.
Tables under test directories are excluded from the proposal (fixtures are
not business surface) and never enter the resource graph at all, so a
fixture that re-declares a real table's name cannot collide with it. The
same rule (a `test/` or `tests/` directory segment) is generic — it names
no repository. Non-interactive runs without `--planes` propose nothing and
print the tip.

### Route folders get their own question

Model folders alone leave every discovered endpoint `PLANE_UNRESOLVED`, so
`--planes` also asks ONE question per ROUTE folder — the directory of the
file that declares the handlers, e.g. `backend/api/v1` — and writes one
`match: 'backend/api/v1/**'` rule per answer. A route's plane is never
inferred from the model it links to (an `accounts` route can serve master
data): the question may SHOW that model's plane as a hint, and only when
every model behind the folder's routes has the same resolved plane —
otherwise no hint is shown and the owner answers from the routes.

Nothing is applied without an answer. In a non-interactive run init prints
each folder, its unresolved route count, the hint (labelled as a hint) and
the exact command to run later:

```sh
gateforge classify plane 'backend/api/v1' tenant \
  --reason 'These routers serve tenant-owned records.'
```

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

### The operator's fixture/actor provider

A declared behavior case names a `fixture` recipe and an `actor`, and the
witness — not the test suite — must materialize them before it drives the
case. `GATEFORGE_FIXTURE_PROVIDER` names the module that does that. The
CLI-spawned witness loads it at startup; a repository that declares no
behavior cases is unaffected.

The module's default export is `{ prepare(input), release(leaseId),
resolveCredential(credentialRef) }`:

- `prepare` provisions the case's subjects and actor identities and returns
  `{ leaseId, namespace, subjects, actors }`. Subjects are server-issued
  identities; a lease namespace keeps concurrent cases isolated.
- `release` drops what that lease provisioned.
- `resolveCredential` turns a lease `credentialRef` into request material.
  It runs in the witness process, so a secret stays there; a declared
  `credentialVariant: valid` that cannot resolve fails closed rather than
  degrading.

The provider is ENGINE-SIDE code and is the only caller of its own
provisioning HTTP calls — the suite never imports it, and nothing it
returns can mint evidence, only supply the subjects a case drives. Because
of that, a repository should exclude the provider from its product scan
scope (`.gateforge.yml` `project.paths.exclude`, matching
`classification-policy.yml` `scanRoots`): its calls are fixture
provisioning, not application call sites, and scanning them reports the
engine's own traffic as unresolved frontend targets. See
`example/behavior/fixtures/fixture-provider.mjs` for a working provider.

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
- A Playwright config with NO named project: `tests discover` prints an
  error line naming the config and the fix
  (`projects: [{ name: 'chromium' }]`) and still writes the catalog, and
  `enforcement doctor` fails the `playwright-projects` row — `test-gates`
  needs a named project.
- Gateforge reads the FIRST of `playwright.config.{ts,mts,cts,js,mjs,cjs}`
  at the repository root; a suffixed config such as
  `playwright.config.e2e.js` is not read — rename it to
  `playwright.config.js` if it is the suite to prove.
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
single `do:` line and stop. New proof goes in `tests/e2e/gateforge/`
(overlay, engine-driven fixture — wizard creates via surface v2 steps);
existing suite-driven browser tests prove persistence and transport via the
Observe channel once mapped `--kind observed-e2e` — but ONLY when the test's
`page` comes from Gateforge's own test object, because that fixture is what
routes the test's app traffic through the supervisor's session observation
proxy. A test that takes `page` from plain `@playwright/test` reaches the app
directly, the witness observes nothing, and the claims finalize missing while
the test passes. When the suite has one shared fixture file, rebase it on
Gateforge's fixture and change nothing else in the suite:

```js
// CommonJS suite (Node >= 20.19 / >= 22.12 for require)
const { test: baseTest, expect } = require('@gate-forge/pack-playwright/fixture');
```

```ts
// ESM suite
import { test as baseTest, expect } from '@gate-forge/pack-playwright/fixture';
```

Rebasing the shared base is not rewriting a journey: the journeys' own steps,
assertions and fixtures stay as they are, and only the `test` object they
extend changes. Never rewrite existing `tests/e2e/**` journeys, never
`tests mark` as proof, never edit policies or waivers to self-approve.
`GATEFORGE.md` (written by `gateforge init`) carries the full loop contract.

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
[`Fix one test without a full run`](TEST-ENVIRONMENT.md#fix-one-test-without-a-full-run)
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

## Run the whole proof with one command

Reproducing a witnessed proof locally used to mean hand-building every
precondition: the verifier key, the policy pin, the interpreter paths, the
bytecode guard, the services, the database reset, the seed, the freeze, the
strict check. One missed precondition cost the whole run.

`gateforge run` owns the generic lifecycle; your app owns the recipe:

```sh
gateforge run -- --changed --scope full     # preflight, recipe, full supervised suite, strict check, teardown
gateforge run -- --changed --scope changed  # prove only the changed slice
gateforge enforcement doctor              # every precondition as one PASS/FAIL line with its fix command
```

Keep `-- --changed`: `run` forwards only the arguments after `--`, and
`test-gates` needs `--changed` to supervise the tests and seal a receipt.
`--scope full` proves the whole suite; `--scope changed` proves a changed slice.

The order is fixed: a **strict preflight** (the first failing precondition
ends the run before a minute is spent), then the optional recipe
`prepare → reset → seed → services_up → healthcheck`, then the supervised
`test-gates` with your flags, then `check --require-e2e`, then
`services_down` — always, after success and after failure. Every step prints
one line with its duration, and the exit code is the first failing step's own
code (2 for a usage/config/recipe error, 1 for a preflight failure or a
failing gate, the command's own code for a recipe step, 124 for a step
timeout).

`gateforge run` adds no authority: it only SEQUENCES commands you could run
yourself, and every verdict still comes from the same engine. Recipe command
output never reaches the console — it goes to a log file under
`.gateforge/test-gates/run-recipe/`, because your commands may print secrets.

The recipe is optional and lives in `.gateforge/runtime.yml` (absent = today’s
behavior, byte for byte). It holds **paths, never secrets**:

```yaml
schemaVersion: 1
env_files:
  - .gateforge/test.env        # paths only; the values are never printed
reset:
  commands: [['./scripts/reset-db.sh']]
  timeoutSeconds: 300
seed:
  commands: [['./scripts/seed.sh']]
  retries: 1
services_up:
  commands: [['./scripts/start-stack.sh']]
healthcheck:
  commands: [['./scripts/health.sh']]
  timeoutSeconds: 60
  retries: 5
services_down:
  commands: [['./scripts/stop-stack.sh']]
```

The recipe shares `.gateforge/runtime.yml` with the
staged/supervised runtime: it is ONE document with TWO
independent key groups that may coexist. `env_files`, `reset`,
`seed`, `services_up`, `healthcheck`, and `services_down` are
read only by `gateforge run` (see
`packages/cli/src/run-recipe.ts`, which also reads `prepare`
— its `commands`, `runTimeoutSeconds`, and `runRetries`
sub-keys), while `schemaVersion`, `prepare`, `health`,
`services`, `envAllowlist`, and `executionTimeoutSeconds`
belong to the staged/supervised runtime (`check --staged` and
`test-gates`; see `packages/cli/src/runtime.ts`, where
`check --staged` reads `prepare`'s `command`, `reuse`,
`timeoutSeconds`, and `preflight` sub-keys). Both groups may
live in the same document; neither enables the other.

An unknown key, a malformed step, or an inline value in `env_files` is a
plain error with exit 2 — Gateforge never runs a half-understood recipe. See
the [test environment guide](TEST-ENVIRONMENT.md) for the
full schema, the exit-code table, and how the recipe relates to the
witnessed pre-commit staged runtime.

## The witnessed CI job

`gateforge enforce --ci gitlab|github` writes the **static** check job.
Add `--witnessed` and it writes the **witnessed** job next to it — the
lane that actually seals a receipt in CI:

```sh
gateforge enforce --ci gitlab --witnessed    # .gateforge/ci/gitlab-witnessed.yml
gateforge enforce --ci github --witnessed    # .github/workflows/gateforge-witnessed.yml
```

One job, one proof. It installs the pinned Gateforge, forwards the
merge-request base sha into BOTH supervised commands (without it the
scope provider falls back to a local diff and can select zero changed
files), runs `gateforge run -- --changed --scope full` so your recipe
owns the services, reads the verdict out of `report.json`, and uploads
`report.json`, `receipt.json`, `execution-result.json` and the run log as
artifacts. Job-scoped stack/image names and a private per-job workspace
come from the CI job id, so two concurrent jobs never collide.

You fill in exactly two things: the recipe (`.gateforge/runtime.yml`)
and the secret variables (`GATEFORGE_WITNESS_VERIFIER_KEY`,
`GATEFORGE_APPROVED_POLICY_DIGEST` as protected/masked CI variables or
GitHub secrets). The generated files are plain YAML you review and edit
yourself; an existing file is never overwritten, and without the flag
every generated file is byte-identical to what it always was. No secret
variable is ever echoed, and the recipe log is deliberately NOT an
artifact — it may contain your app's secrets.

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
