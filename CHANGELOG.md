# Changelog

## Unreleased

### Added
- Declared signature profiles for `engine-http` behavior cases (plan 2026-09-25 Phase 1). `signatureProfile` now takes an algorithm plus bounded `;key=value` parameters — `header`, `timestampHeader`, `toleranceMs`, `attemptHeader`, `attempt`, `forgery` — parsed by ONE grammar (`parseBehaviorSignatureProfile` in core) that the config schema and the witness request driver both use, so a typo is a config error and an unknown parameter never becomes a silent default. The secret still comes only from the trusted lease, the signature still covers the exact bytes on the wire, and a `forgery` is performed by the engine (one flipped digest nibble), never by the suite. A lease subject `signatureTimestampMs` lets a case declare a stale stamp, which the driver refuses when it falls outside the declared `toleranceMs`; over-limit bodies still never leave the driver. A bare `hmac-sha256` is byte-for-byte the previous behavior. Proven against the pack's own `example/webhook` receiver: a valid signature is accepted and the delivery log gains exactly one row, a forged signature is rejected 401 with the log unchanged, and a replay still leaves one row.
- `example/webhook/server.js` exports its `start` function for harnesses that own their own delivery-log state, and applies the side effect to THAT state (it previously wrote to the process-global log, so a harness-owned state never saw its own rows). It also serves a read-only `GET /delivery-log` listing.
- An engine-level end-to-end suite for the `webhook` namespace (`packages/cli/test/webhook-behavior-e2e.test.ts`): the real CLI over a fresh fixture repository, the pack's own `example/webhook` receiver behind the loopback attestation proxy, the witness `test-gates` spawns itself, and post-suite verdict evaluation. It compiles three owner-declared required cases (valid signature, forged signature, replay) and pins the CURRENT state honestly: the grader reaches all three webhook obligations and each one is `missing` with `BEHAVIOR_CASE_MISSING`, because no supervisor path binds the compiled behavior catalog to the witness, so the run's own failure artifact reads `no behavior catalog is bound to this run`. The example receiver gains a read-only `GET /delivery-log` listing so a reviewed adapter can witness the delivery log as a scope.
- The Status text in `README.md` and the capability table in `packages/cli/README.md` now match the code: `auth:*`, `validation:*`, `task:*`, `webhook:*` and `workflow:*` are registered semantic verifiers that grade across the approved required cases through the witness-issued `behavior.case` channel (they were still documented as fail-closed namespaces with no verifier). A repository that declares no case for such an obligation still blocks `missing` — the grader never falls back to transport evidence — so only the stale documentation changed, no verdict, cause code or exit code.

- Optional owner-chosen gate strictness: `mode: strict|changed|warn` in `.gateforge.yml`. A missing key is `strict`, which is exactly today's behavior. `changed` blocks only on debt this change touches (the full debt is still reported); `warn` evaluates and reports everything and exits 0 with an additive `wouldBlock`. Exit code 2 (config/usage) is never softened, and the active mode is printed in every report and surfaced by `gateforge enforcement doctor`.
- `gateforge quarantine <testKey> --owner --approver --reason --expires` writes an owner-approved, always-expiring (max 14 days) flaky-test quarantine. A quarantined test leaves the required set, its outcomes and evidence are never used for any claim (an obligation only it covered stays `missing`), and it never blocks. An expired quarantine is ignored and blocks with `QUARANTINE_EXPIRED`. Quarantine files are part of the pinned trusted policy, so an agent-authored quarantine is a policy change that blocks until the owner repins.
- Goal-based `gateforge init`: one question (light / normal / strict) or `--preset light|normal|strict` maps a goal to the exact settings it writes and prints them, plus the `undo:` command. `gateforge init --explain-presets` prints the same mapping and writes nothing. With no terminal and no `--preset` (an AI agent or CI), init writes `light` only (`mode: warn`, no hooks) and prints that a human must choose; it never guesses `normal` or `strict`. A preset never writes a waiver, an adopted baseline or a plane rule, and an existing `.gateforge.yml` is never rewritten.
- The supervised spool drain exposes its own persistence-intent forward progress (`whenIntentsForwarded(count)`): it resolves once the witness has answered that many drained intents, so a caller can wait for the server-side probe to have run instead of guessing a number of poll ticks. It is the drain's own fact — the supervised suite only appends to the spool and can neither observe nor assert it — and it fails closed (rejects) rather than resolving on an unproven assumption.
- `gateforge test-gates --test <selector> --result-only` runs hand-picked tests witnessed, in seconds, instead of a whole suite. `--test` is repeatable and is accepted ONLY with `--result-only`: a hand-picked list never seals a receipt. A selector is a logical key or a unique substring of one, resolved against the planned rows (never raw runner output); an unknown or ambiguous selector exits 2 with the candidate keys listed. The named run uses the additive `named-selection` selection mode, so it can never collide with a full or scoped seal, and adds `selectors: [{ selector, logicalKeys }]` to the report. It works for every runner through the shared adapter contract.
- Opt-in `enforcement.reseal: true` lets `test-gates --changed --scope changed` re-seal after a test-only change: Gateforge diffs the two sealed trees itself, classifies every changed path from the runner's catalog and the repository import graph, re-runs only the tests the change can affect (importers of a changed file included) and carries the parent's outcomes. Eligible paths are test files and test helpers only; app code, a deleted file, a setup or dependency-stage test, or an unresolvable import takes the full run with one plain reason line. A complete whole-suite run that failed a test seals no receipt and leaves `.gateforge/test-gates/run-record.json` instead — a MAC'd, verdict-free run record the same path re-seals from when every test that did not pass is inside the affected set and passes now. The chain is bounded at 5 consecutive re-seals, and `check --require-e2e` and `broker commit` recompute every hop (parent authentication, tree diff, classification, affected set, carried rest) with their own keyring. Off by default in every mode; `enforcement.reseal: true` enables it in any mode, `strict` included.

- A secret-free CI progress stream (`gateforge test-gates --progress stderr|file:<path>|off`, and the additive `run.progress` config key). It prints the start line with the registered expected-set size, one line per finished test with exact `N/M` counters and the test's catalog title, an alive line every genuinely quiet minute, and the finish line before grading. It is built from witness-side facts only — counters, identities, catalog titles, outcomes — and NEVER from runner output, so it is secret-free by construction; a failing test's first error line is matched against credential shapes and replaced whole. `auto` is stderr under `CI=true` and off everywhere else, so a local run's bytes are unchanged, and the stream is written only when it is on. It decides nothing: it is not evidence, no gate reads it, and a write failure warns once and is then ignored.
- A failing witnessed test ships a Gateforge-owned diagnosis instead of a browser snapshot: `.gateforge/test-gates/failures.json` carries each failure's logical key, its guarded error message and up to five `file:line` stack frames. No request or response body is ever included, and a planted credential in an error message reaches neither the stream nor the artifact.
- `execution.repositoryDebt` gained `baselined` and `newlyBlocking` beside the frozen `blocking` total (which stays exactly as computed, legacy in the sense that it includes baselined debt), and the text summary now reads `repository debt: N known (baselined), M new blocking / …` — the same wording in the core report and in the Playwright reporter. The same split is written to the run state as `debt-baseline.json` so the in-runner reporter reports the same numbers.
- `gateforge test-gates --help` documents `--progress`, and the run's scope is published to the in-runner reporter as `run-scope.json` (derived run state, read by nothing the gate trusts).

### Changed

- A named or changed-scope run's in-runner reporter no longer prints a repository verdict it cannot own: it says `GATEFORGE GATE: SELECTION (N satisfied, 0 blocking; repository verdict not graded here)` instead of `NOT PASSED` over debt the run never observed, which contradicted the CLI exit code printed seconds later. A selection whose own claim is unsatisfied still prints `FAIL`; a whole-repository run is unchanged.
- Reports gained additive fields only, and only when they apply: `strictness` (non-strict modes) and `quarantine` (non-empty population). SARIF output stays machine-parseable JSON.

### Fixed

- `--scope changed` in a merge-request CI pipeline with no base commit no longer falls back to the local staged diff (zero changed files, and a failure an hour later on debt nobody changed). `test-gates --scope changed` and `check --changed` refuse in seconds with exit 2 and the fix; an explicitly configured provider, a pipeline that is not a merge request, a present base commit, and every local run are unchanged.

### Fixed

- Witnessed observe evidence no longer goes ambiguous when two tests create the same resource at the same time (parallel test files/workers are the normal case). A create is now attributed to the entity its OWN proxied response named, verified against the witness's after-list, so concurrent observed creates each resolve their own entity. A new entity that no observed response names — a writer outside the observation proxy — still makes the creation ambiguous and the obligation stays blocking; the unobserved-writer case is unchanged and fail-closed.
- A vitest project's second test of a file no longer waits for the runner's main process to report the first one. The end of a test now reaches the drain from the worker that ran it — in the same order as that worker's own begin — which releases that worker's session slot; the runner's own end still seals the session with the observed outcome, and only the runner ever states a verdict. A release credits nothing: submissions and the session proxy stop at the release, an outcome that never arrives leaves the session outcome-less (it grades not-passed), two different outcomes for one test are a lifecycle conflict, and an outcome with no begin still fails closed.
- A `--scope changed` run no longer blocks on affected obligations the run's own grading forgives through the adopted baseline: they are reported in one line (`N affected obligation(s) have no declared mapping and are forgiven by the adopted baseline; they stay uncovered by this slice`) and stay inside the sealed covered set, so `check --require-e2e` still demands what the full path grades. An obligation the baseline never adopted still blocks (shrink-only, fail closed), and strict E2E forgives nothing, so its behavior is unchanged. Before this, a repository that had adopted its unmapped obligations could not run a changed slice at all: the same debt the full run forgave blocked the narrow one with `EVIDENCE_SCOPE_INCOMPLETE`.

## 0.7.1

### Added

- Docs: quickstart, test-environment and upgrade guides ship inside @gate-forge/cli.
- Build: workspaces build in dependency order, so a clean clone builds and publishes.

## 0.7.0

### Added

- Added existing-test discovery, suggestions, declarations, and the `gateforge tests surface-doctor` diagnostic.
- Added `gateforge key create|import-env|rotate|retire` for external verifier-key rings.
- Added `gateforge test-gates --changed --scope changed --result-only`; external-witness runs require a separate non-authoritative `--out` and never touch receipts.

### Changed

- `check` combines `.gateforge/test-map.yml` with optional `claimInventory` from a receipt authenticated for current inputs; `claims.json` alone does not declare claims.
- Docs exclusions use exact repo-relative folders via `gateforge init --docs-exclude`; a matching external `GATEFORGE_APPROVED_POLICY_DIGEST` is required, and recognized manifest/lockfile basenames remain protected.
- Trusted Playwright configuration maps `appBaseUrl` to `use.baseURL` and `storageState` to `use.storageState`.
- The Playwright package guard checks the supervised protocol contract and returns exit 2 with `GATEFORGE_PACKAGE_INCOMPATIBLE` on mismatch.
- `init --blocking` installs and verifies an active pre-commit hook and writes CI gate wiring.

### Fixed

- Witness startup waits for the reported proxy URL before proceeding.
- Fixed a shared-distribution witness spool race between concurrent runs.

## 0.6.3 and older

Earlier release history is available in the repository's git tags.
