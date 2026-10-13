# @gate-forge/cli

The gateforge command-line interface: initialize a project, discover
resources and classification signals, inspect automatic decisions, reuse a
repository's existing tests, evaluate obligations, run the supervised E2E
gate, enforce the exact staged candidate, and maintain baselines.
**0.13.8:** Selecting one step of a serial journey (`test.describe.serial`, or a describe or file that calls `test.describe.configure({ mode: 'serial' })`) selects the whole serial group in file order, so a named run no longer starts at step 3 without steps 1–2; each expansion is printed and recorded in the report. `runtime.yml trace` sets the supervised run's Playwright trace mode (e.g. `retain-on-failure`), and the trace lands in `<state dir>/last-failures/`.
**0.13.7:** Registration order reaches apps that mount every router through one registration function (`register_all_routers(app)`): when the function is a plain module-level `def` called exactly once at the app module's top level, its top-level `include_router` calls are ordered in place, so literal-vs-parameter overlaps such as `/items/export` vs `/items/{item_id}` resolve there too. Conditional or looped includes, repeated or nested calls and foreign call sites stay unordered (ambiguous).
**0.13.6:** A FastAPI literal-vs-parameter route overlap (`/items/export` vs `/items/{item_id}`) is attributed by registration order, as Starlette dispatches it, whenever pack-fastapi can place every matching route statically (otherwise it stays ambiguous). `runtime.yml expectTimeoutSeconds` sets the supervised run's `expect` timeout. A red `--result-only` run keeps Playwright's failure artifacts in `<state dir>/last-failures/`. A blocked transport claim names its own blocked call instead of an unrelated exchange from the same test.
**0.13.5:** Supervised runs honour a project's declared test timeout: the timeout Playwright resolves for each project (read from `playwright test --list` JSON, never by loading the config) becomes that project's timeout in the generated config, with 60 s as the floor.
**0.13.4:** A suite that mixes the fixture's `test` with Playwright's own runs in file order again when page observation is off: the fixture replaces Playwright's worker-scoped `browser` only for page observation, so the two runners no longer land in separate worker groups.
**0.13.3:** Hooks registered on the Gateforge fixture's `test` receive their fixtures again: 0.13.2 handed `test.beforeEach(async ({ page }) => …)` an undefined `page`. Titled hooks (`test.beforeEach('title', fn)`) work too, and a runner built with `test.extend(...)` keeps hook setup traffic uncredited like the base runner.
**0.13.2:** API tests are witnessed: the Gateforge Playwright fixture rehosts APIRequestContext calls (the `request` fixture, `page.request`/`context.request`, and the exported `request.newContext()`) onto the test's session proxy, while hook and module-scope setup traffic stays uncredited. `tests suggest --from-run` names tests from a witnessed run's own recorded exchanges (now stamped with their method) and prints the exact `tests mark` command; unmatched and ambiguous exchanges are listed separately. A refused sweep page names the requests behind `PAGE_API_UNSETTLED`/`PAGE_API_ERROR`. First-install fixes: an unreferenced `.gateforge/runtime.yml` warns, a repeated `tests mark` adds claims instead of replacing them, `explain` accepts printed obligation ids, init's no-terminal notice names the `mode:` edit, a closed output reader no longer changes the exit code, the test scan ignores JSON files, and init recommends the React Router pack for React Router apps.
**0.13.1:** The frontend detector now reads a trailing template-literal hole that provably renders only query or fragment text as a bare query marker instead of gluing it to the last path segment, so calls like `.../meters${qs}` join their backend route instead of reporting unwired (anything not provably a query suffix is unchanged). The supervisor's post-suite page sweep performs its witness HTTP calls with `node:http`/`node:https` directly, so the computed budget is the only deadline and a sweep budgeted longer than five minutes no longer aborts with `fetch failed` (error types, messages, and fail-closed behavior unchanged). A storage-only `addInitScript` (`localStorage`/`sessionStorage` set, `removeItem`/`clear`, optional `window.` receiver, and the `context.addInitScript` form) is no longer a page-observation tamper; the scan continues past it, and a real tamper later in the same file is still reported at its own line.
**0.13.0:** React Router pages become first-class proof targets. `@gate-forge/pack-react-router` reads JSX and object route trees into `ui.page` resources, and each plane-resolved page carries two promises — `page:loads` and `page:data-ok` — graded from settled, route-matched witnessed visits (a page's API call counts only when its response BODY completed; a `net::ERR_ABORTED` cancel settles only when the same method and URL completed in the same visit). The engine's post-suite referee sweep visits the pages no test proved, with seeded `pages.params`; a failed page-observation flush never fails the app's own passing test. Page paths honor a code-read router `basename` plus the optional `pages.basePath`, and a relative route with no parent to place it under is refused (`PAGE_ROUTE_UNRESOLVED`) instead of silently joined. `gateforge adopt --family pages` records pre-existing page debt for already-adopted repositories (preview by default, one atomic receipt write, permanent marker, shrink via `baseline update --family-pages`); a 401 on a page whose audience has no login counts as the expected not-logged-in answer; page promises report honest causes and honor owner waivers; and `gateforge init` now asks for `pages.audiences` plane declarations.
**0.12.0:** owner-declared business rules, test-type agnostic. The owner writes the product's rules down in the `rules:` section of `.gateforge/classification-policy.yml` (`gateforge init --rules` adds a commented example; a repository without the section is byte-identical to a release without the feature). Each rule names the test type that must prove it — `e2e` (default) or `pytest` — and splits into CASES mapped by the claim id `business-rule:<ruleId>/<caseId>` through the ONE mapping resolver (`tests mark --rule <ruleId>/<caseId> …`). A declaration is never proof: the case is graded by a pure evaluator over the sealed run's own facts, every mapped test of a case must deliver the proof (a green sibling never forgives a red one), a mocked spec never proves an end-to-end rule, a test outside the run's graded slice is reported `unproven`, and rule findings are run-wide, never diff-scoped away. `enforcement: advisory` (requires `advisoryReason`) rides the report's advisory channel every run, out of `blocking` and out of the exit code. `check` blocks (or advises) per case, `check --require-e2e` and `test-gates` grade from the sealed receipt's authorized records, the json report carries an additive `businessRules` section, and `gateforge next` prints a starter test plus the exact `tests mark --rule` line per missing case. Fixed: an empty optional config directory is digested exactly like an absent one, so the pin an owner minted over their adoption commit is the digest every gate computes and a fresh adoption can push again.
**0.11.1:** Gateforge's own `check` cache is excluded from candidate trees, so a concurrent check cannot alter a run using a non-default `test-gates --out` directory. No other ignored or run-state files are excluded.
**0.11.0:** one owner answer per fact. The four owner-answer FILES become SECTIONS of the two documents that already exist: `.gateforge/planes.json` and `.gateforge/endpoints.json` are now the `planes:` and `endpoints:` sections of `.gateforge/classification-policy.yml`, `.gateforge/http-clients.json` and `.gateforge/fastapi.json` are `.gateforge.yml` `scan.httpClients` and `scan.fastapi`, and the four scanner settings moved out of the answers document into a REQUIRED `scan:` block. There is no dual read — a repository still carrying one of the old files is refused BY NAME, with the command that moves it and its new home. `gateforge migrate` previews by default and applies with `--confirm`, one step per moved document, splicing at TEXT level so every comment survives, and validating every old value with the reader that will read it after the move. The hard-vs-archive answer keeps BOTH channels because they answer different questions: a declared `crud-delete`/`crud-archive` in the `endpoints:` section needs no linked model at all — a DELETE route that links no resource (a link-row teardown, a draft discard) cannot be expressed in `deleteRules`, whose globs name a resource's source file — while `deleteRules` answer for every route of one resource in a single line, and a DELETE with neither stays `ENDPOINT_SEMANTICS_UNRESOLVED` rather than being resolved by a word in a handler name. A diff-scoped report's `[NEW_DEBT]` entry no longer blocks a commit while saying there is nothing to prove — with no newly-unproven obligations it now names the cause it is actually reporting (a sealed receipt whose evidence-context `inputDigest` the change invalidated, typically) and the re-seal command. Upgrading: upgrade first, re-seal, commit both together.
**0.10.4:** `enforcement.adoptedDebt` (default `lenient`) decides how ADOPTED debt is treated under `strictE2E` after the adoption commit. With `lenient`, a change set that carries no product behaviour at all — tests, the mapping sidecar, runner configuration, no discovered resource's source — keeps the adopted baseline's forgiveness and is demanded only the coverage of the obligations it newly claims, so the first test-adding commit after `gateforge adopt` commits through the hook instead of re-grading every adopted obligation blocking. `strict` keeps the 0.10.3 behaviour exactly. Both values still require the owner pin to be enforced, still grade a newly claimed obligation on its own evidence, and still re-grade the moment a product source is in the change; the key lives in `.gateforge.yml`, so it is inside the approved policy digest.
**0.10.3:** the two receipt paths that read the RAW policy blocking list now read the ADOPTED baseline instead, so both engage in a repository that ran `gateforge adopt` — a `docs/**.md` commit re-seals its zero-record receipt, and a receipt carried forward over sealed candidate trees is carried. Neither ever seals over NEW debt: an entry the adoption receipt forgives (by whole-entry fingerprint or by the classification layer's resource identity) is forgiven in the guard through the same split the grader uses, and an entry adoption never recorded still refuses the path. Nothing else about either receipt moved.
**0.10.2:** the whole-run cap is the operator's (`runtime.yml executionTimeoutSeconds` or `--run-timeout-min`; by default there is none) and only a STALL bound is ours (`stallTimeoutSeconds`, default 15 min). The commit that WIRES the gate is committable: adoption mode is computed from the base revision — no flag, no config key — so the first adoption commit proves only the obligations it newly claims and the adopted baseline survives the strict-E2E re-grade. The pack configs (`.gateforge/planes.json`, `endpoints.json`, `http-clients.json`, `fastapi.json`) and the generated `.gateforge/hooks/` + `.gateforge/ci/` wiring are owner-pinned, and a run, a `check --staged` and an `enforcement pin` now agree on ONE input identity for the same repository. Upgrading a repository that ships a pack config or the generated wiring: re-pin once.
**0.10.1:** `enforcement pin`, `check --staged` and `enforcement doctor` now agree on ONE policy digest for the same repository — a repository whose `.gateforge/adapters/` and `.gateforge/waivers/` are empty but untracked (exactly what `gateforge init` leaves behind) no longer makes a freshly written pin fail `check --staged` with `ENFORCEMENT_UNTRUSTED`, and re-pinning converges instead of looping. `tests mark --test` and `tests explain --test` accept the documented `<file>#<titlePath joined by '>'` reconciliation key next to the catalog `logicalKey`, so a key copied out of a report resolves instead of being reported as absent from the catalog. The npm tarball now ships this [CHANGELOG.md](CHANGELOG.md), so the release notes are readable from the installed package.
**0.10.0:** evidence exclusions moved INTO `.gateforge.yml` (`evidence.exclude.docs` / `.cache`), and `gateforge migrate` moves an existing 0.9 declaration there; `enforcement pin --pin-file` writes the owner-approved policy digest outside the repository and `enforcement doctor` reports `policy-inputs-vs-HEAD` / `approved-digest`; transport (`http:*`) obligations can now be PROVEN through the Observe channel by an ordinary suite-driven test; `@gate-forge/pack-playwright/fixture` works from CommonJS (`require`), so a default-shaped Playwright suite can route its traffic through the session proxy; `classify delete` records owner-declared delete semantics. Upgrading: [UPGRADE-0.9-to-0.10](guides/UPGRADE-0.9-to-0.10.md).
**0.9.1:** `init --blocking` and `enforce` now insert the `gateforge-check` entry as the FIRST item of an existing `.pre-commit-config.yaml` `repos:` list, so file-mutating hooks cannot run before the gate. See [CHANGELOG.md](../CHANGELOG.md) for the 0.9.1 fixes. **0.9.0 vs. published 0.8.0:** `check --staged` reads the staged bytes, the scan skips untracked gitignored files (receipt identity unchanged), Gateforge's own setup files are policy inputs so the setup commit passes with the policy digest pinned, test-directory models stay out of the graph, per-tenant singletons are tagged only on an exact configured scope, `init` asks one plane question per route folder, `classify plane` takes a folder, `--docs-exclude-file`, `init --behavior`, `explain <path>`, ranked and capped `tests suggest`, `FASTAPI_ROUTER_UNMOUNTED` / `HTTP_METHOD_DYNAMIC` / `ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED` / folded FastAPI prefixes, and no `.pyc` in a published tarball. Upgrading: [UPGRADE-0.8-to-0.9](guides/UPGRADE-0.8-to-0.9.md).

**0.8.0 vs. published 0.7.1:** one-command local proof (`gateforge run`), witnessed single tests (`--test`), test-only re-seal, owner-chosen strictness and quarantine, a strict run preflight in the doctor, CI progress stream and witnessed CI templates, adapter kit and scaffold, an engine-owned queue observer for `task` cases, timing chaos and twin path coverage. Upgrading: [UPGRADE-0.7-to-0.8](guides/UPGRADE-0.7-to-0.8.md).

## Install

Install the CLI, the Playwright pack, and only the detector packs
that fit your app. Keep every direct `@gate-forge/*` package on
the same release:

```sh
npm i -D @gate-forge/cli @gate-forge/pack-playwright
```

You need Node.js 20 or newer. Use the project-local `gateforge`
binary from your npm script, or add `node_modules/.bin` to your
shell `PATH`. The scan recommends the packs your code uses; a
mismatched Gateforge package contract stops the CLI with exit code
2 and `GATEFORGE_PACKAGE_INCOMPATIBLE`. The full walkthrough,
including tarball installs: [Quickstart](guides/QUICKSTART.md).

## Start here

- [Quickstart](guides/QUICKSTART.md)
- [Test environment](guides/TEST-ENVIRONMENT.md)
- [Upgrade from 0.8 to 0.9](guides/UPGRADE-0.8-to-0.9.md)
- [Upgrade from 0.9 to 0.10](guides/UPGRADE-0.9-to-0.10.md)
- [Upgrade from 0.7 to 0.8](guides/UPGRADE-0.7-to-0.8.md)
- [Upgrade from 0.6 to 0.7](guides/UPGRADE-0.6-to-0.7.md)
- [Runners other than Playwright](guides/RUNNER-NEUTRAL-EVIDENCE.md)
- [Connect your project](guides/CONNECT-YOUR-PROJECT.md)
- [Reference](guides/REFERENCE.md) — every command, flag, exit code, and protocol

Also at https://github.com/umiddey/gateforge/tree/main/packages/cli/guides.

Just added a new table or endpoint and the gate is blocking? Run
`gateforge next` (or `gateforge next --json`) — it prints the ONE blocking
next action. New proof tests go in `tests/e2e/gateforge/` (overlay);
never rewrite existing journeys, never `tests mark` as proof.

## First commands

```sh
gateforge init                  # scan the repo and write the standard scaffold
gateforge next                  # the ONE blocking next action — run this after any change
gateforge check                 # the full gate: discover → classify → obligations → verdicts
gateforge test-gates --changed  # supervise the changed tests and seal an authenticated receipt
```

The four commands a repository needs, with their full reference rows:

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `gateforge init [--preset light\|normal\|strict] [--explain-presets] [--languages <comma,list>] [--plugins <comma,list>] [--accept-recommended] [--no-scan] [--proof overlay\|observe] [--blocking] [--no-blocking] [--pre-commit] [--no-pre-commit] [--ci] [--no-ci] [--planes] [--no-planes] [--strict-e2e] [--docs-exclude <folder,...>] [--docs-exclude-file <path>] [--confirm-doc-exclusions]` | Scan the repo (heuristics, no network), print the recommended install (plugins, persistence policy, transport-only HTTP policy for consumed endpoints, overlay proof), and write the standard Gateforge scaffold. Idempotent — never overwrites existing files unless `--confirm-doc-exclusions` approves an exclusion update. It also appends Gateforge's own engine state (`.gateforge/test-gates/`) to `.gitignore`, and on a repository that already has code it names `gateforge adopt` as the way through the debt the first commit will meet. `pack-task` is opt-in only (`--plugins`); `--proof observe` skips the overlay scaffold and prints the observe wiring checklist instead. Default language: `python`. `--preset` applies one goal in one step (`light` -> `mode: warn`, no hooks; `normal` -> `mode: changed` + pre-commit hook + CI job; `strict` -> `mode: strict` + staged gate + pre-push receipt check + CI job) and prints what it wrote plus `undo:` lines for created and in-place-changed files; `--explain-presets` prints that mapping and writes nothing. In a terminal init asks the same question instead; with no terminal and no `--preset` it writes `light` only and says so on one line with the `--preset` flag that changes it. The negative forms (`--no-blocking`, `--no-pre-commit`, `--no-ci`, `--no-planes`) answer the matching question without a prompt. A preset never writes a waiver, an adopted baseline or a plane rule, and an existing `.gateforge.yml` is never rewritten. `--strict-e2e` writes the `enforcement` block and refuses unavailable required proof channels. | 0/1/2 |
| `gateforge next [--changed] [--json]` | Print the ONE blocking next action (`next`/`cause`/`why`/`do`; `--json` adds `remainingBlocking` and route-specific `guidance` when relevant). For an endpoint with no plane, ask which boundary owns its data and show the owner-reviewed choices; internality remains owner-only. Navigation, not the gate: never requires an E2E receipt. Exit 0 clean, 1 next action, 2 config/usage. | 0/1/2 |
| `gateforge check [--changed] [--staged] [--candidate-commit <sha>] [--require-e2e] [--timing] [--no-cache] [--format text\|json\|sarif]` | The full gate: discover → classify → obligations → claims → verdicts → report. `--timing` appends per-step wall-clock timings (detectors, test collection, TS scan, planning, total) — an additive report key in json and one line in text, never an input to any verdict. Detector and pytest-collection results are cached under the excluded run-state dir. Detector keys include plugin config, executable module/script bytes, Python import environment, inputs, interpreter packages, and Gateforge engine version; pytest keys include all Python/config file bytes, collector argv/environment, interpreter identity, and engine version. Unchanged successful pytest collections reuse their node ids; any changed Python byte recollects. Any uncertainty runs fresh. The report carries additive `cache: {hits, misses}` counts. `--no-cache` (or `GATEFORGE_NO_CACHE=1`, or a CI environment) disables cache reads and writes. | 0 clean/waived, 1 unresolved, 2 config/usage error |
| `gateforge test-gates [--changed] [--scope full\|changed] [--progress stderr\|file:<path>\|off] [--result-only] [--suite <cmd>] [--out <dir>] [--format F] [--witness-url <url>] [--run-token <token>]` | The progress stream (additive, `--progress`, or the `run.progress` config key) prints the registered expected-set size, one line per finished test with exact `N/M` counters and the catalog title, an alive line per quiet minute, and the finish line before grading. It is built from witness-side facts only and never from runner output; a failing test's first error line passes a credential guard and is replaced whole when it matches, and the full guarded diagnosis lands in `.gateforge/test-gates/failures.json`. `auto` (the default) is stderr under `CI=true` and off locally. The stream is not evidence and no gate reads it. Supervised `--changed` plans and runs mapped Playwright tests through the trusted adapter, checks planned/executed completeness, and seals an authenticated receipt only after complete success. `--scope changed` limits a sealed slice to obligations affected by changed files; incomplete mappings block, and `check --require-e2e` accepts it only when it covers every currently changed obligation. `--result-only` requires `--changed --scope changed`, reports selected results plus repository debt, and has no gate authority: without an external witness it uses private temporary state; with `--witness-url` it requires `--out` + `--run-token` shared with the external witness in a separate state directory (not the configured authoritative state directory). It never creates or clears a receipt. `--suite` remains legacy and cannot combine with `--changed` or redefine strict expected cases. Verifier keys use `GATEFORGE_WITNESS_VERIFIER_KEY` or the external key ring selected by `GATEFORGE_WITNESS_VERIFIER_KEY_FILE`. | 0/1/2 (suite failure forces 1) |

Every other command — `discover`, `classify`, `explain`,
`obligations`, the `tests` workflow (`discover` → `suggest` →
`sync`/`mark` → run), `tests diagnose`, `broker commit`,
`enforcement doctor`, `baseline`, the key ceremony, and every
flag — is documented in the [Reference](guides/REFERENCE.md).

To re-confirm a handful of hand-picked tests, `--test` names them
and the run is witnessed exactly like a full gate run:
`gateforge test-gates --test <selector> --result-only` (repeatable,
accepted only with `--result-only`, never seals a receipt).

Global flags: `--help`, `--version`. Exit codes per architecture contract 4:
`0` clean/waived, `1` unresolved obligations (or a failed/supervision-blocked
run), `2` config/usage error. `tests diagnose` has its own advisory contract
(0/1/2 above).

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
  at the repository root, then up to two directory levels down (breadth-first,
  alphabetical, hidden/dependency/build/Python directories pruned). Multiple
  configs are disclosed, but only the first is inventoried. A suffixed config such as
  `playwright.config.e2e.js` is not read — rename it to
  `playwright.config.js` if it is the suite to prove.
- If the supervised Playwright child reports missing/malformed/empty outcomes,
  or all-skipped outcomes with a failed exit, `test-gates` prints
  `RUNNER_STARTUP_FAILED`, its exit code and a bounded stderr excerpt even
  with `--result-only`. JSON includes `diagnosticContext.runnerStartup`
  (`cause`, `processExit`, `stderr`). The excerpt contains at most 20 lines
  and 8192 characters; lines echoing `GATEFORGE_*TOKEN*` variables are redacted.
  `GATEFORGE_DEBUG_RUNNER=1` additionally echoes child stdout/stderr live
  to the parent's stderr. These diagnostics never count as execution evidence.
  Successful all-skipped runs retain their ordinary outcome envelope, not a
  startup failure diagnostic.
- Run-state hygiene is enforced, not forgiven: a committed run-state
  directory or include globs that omit the spec directories fail closed —
  gitignore `.gateforge/test-gates/` and include the spec globs.
- Consumer-worktree migration and the server-side GitLab enforcement
  settings are pending owner actions — the complete template and settings
  list ship from `init --blocking`, but a local simulation does not
  complete a server rollout.

Every limitation with its full context: [Limitations](guides/REFERENCE.md#limitations).

## Existing repositories

On a repository that already has code, `gateforge check` reports
today's findings as blocking debt from day one. The sanctioned
one-time bulk-add is `gateforge adopt`: it records today's blocking
findings as forgiven (shrink-only, once per repository) and applies
the blocking wiring. The full adopt contract, and the baseline
commands that shrink the recorded set: [Reference](guides/REFERENCE.md).
Under `strictE2E`, an adopted E2E obligation still blocks
as soon as a change touches it — adoption forgives today's
debt, never new work. A repository that adopted before the 0.13
pages rollout revises its adoption with `gateforge adopt --family
pages --confirm` (preview by default): one atomic receipt write
records a permanent `pages` family marker — every page obligation
discovered, proven pages included — forgiving only the then-missing
page debt; the marker survives every shrink, repeats add nothing,
and the digest change requires the owner's external repin for
strict gates ([Reference — the pages family](guides/REFERENCE.md#the-pages-family-adopting-page-debt-into-an-already-adopted-repo)).

## Development

```bash
npm test              # workspace-wide (vitest projects)
npm run build         # compile to dist/ (dependency order: core → plugin-protocol → cli)
node bin/gateforge.js --help
```
