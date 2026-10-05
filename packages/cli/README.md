# @gate-forge/cli

The gateforge command-line interface: initialize a project, discover
resources and classification signals, inspect automatic decisions, reuse a
repository's existing tests, evaluate obligations, run the supervised E2E
gate, enforce the exact staged candidate, and maintain baselines.
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
  at the repository root; a suffixed config such as
  `playwright.config.e2e.js` is not read — rename it to
  `playwright.config.js` if it is the suite to prove.
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
debt, never new work.

## Development

```bash
npm test              # workspace-wide (vitest projects)
npm run build         # compile to dist/ (dependency order: core → plugin-protocol → cli)
node bin/gateforge.js --help
```
