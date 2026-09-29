# Changelog

## Unreleased

### Added

- Optional owner-chosen gate strictness: `mode: strict|changed|warn` in `.gateforge.yml`. A missing key is `strict`, which is exactly today's behavior. `changed` blocks only on debt this change touches (the full debt is still reported); `warn` evaluates and reports everything and exits 0 with an additive `wouldBlock`. Exit code 2 (config/usage) is never softened, and the active mode is printed in every report and surfaced by `gateforge enforcement doctor`.
- `gateforge quarantine <testKey> --owner --approver --reason --expires` writes an owner-approved, always-expiring (max 14 days) flaky-test quarantine. A quarantined test leaves the required set, its outcomes and evidence are never used for any claim (an obligation only it covered stays `missing`), and it never blocks. An expired quarantine is ignored and blocks with `QUARANTINE_EXPIRED`. Quarantine files are part of the pinned trusted policy, so an agent-authored quarantine is a policy change that blocks until the owner repins.
- Goal-based `gateforge init`: one question (light / normal / strict) or `--preset light|normal|strict` maps a goal to the exact settings it writes and prints them, plus the `undo:` command. `gateforge init --explain-presets` prints the same mapping and writes nothing. With no terminal and no `--preset` (an AI agent or CI), init writes `light` only (`mode: warn`, no hooks) and prints that a human must choose; it never guesses `normal` or `strict`. A preset never writes a waiver, an adopted baseline or a plane rule, and an existing `.gateforge.yml` is never rewritten.
- The supervised spool drain exposes its own persistence-intent forward progress (`whenIntentsForwarded(count)`): it resolves once the witness has answered that many drained intents, so a caller can wait for the server-side probe to have run instead of guessing a number of poll ticks. It is the drain's own fact — the supervised suite only appends to the spool and can neither observe nor assert it — and it fails closed (rejects) rather than resolving on an unproven assumption.
- `gateforge test-gates --test <selector> --result-only` runs hand-picked tests witnessed, in seconds, instead of a whole suite. `--test` is repeatable and is accepted ONLY with `--result-only`: a hand-picked list never seals a receipt. A selector is a logical key or a unique substring of one, resolved against the planned rows (never raw runner output); an unknown or ambiguous selector exits 2 with the candidate keys listed. The named run uses the additive `named-selection` selection mode, so it can never collide with a full or scoped seal, and adds `selectors: [{ selector, logicalKeys }]` to the report. It works for every runner through the shared adapter contract.

### Changed

- Reports gained additive fields only, and only when they apply: `strictness` (non-strict modes) and `quarantine` (non-empty population). SARIF output stays machine-parseable JSON.

### Fixed

- Witnessed observe evidence no longer goes ambiguous when two tests create the same resource at the same time (parallel test files/workers are the normal case). A create is now attributed to the entity its OWN proxied response named, verified against the witness's after-list, so concurrent observed creates each resolve their own entity. A new entity that no observed response names — a writer outside the observation proxy — still makes the creation ambiguous and the obligation stays blocking; the unobserved-writer case is unchanged and fail-closed.
- A vitest project's second test of a file no longer waits for the runner's main process to report the first one. The end of a test now reaches the drain from the worker that ran it — in the same order as that worker's own begin — which releases that worker's session slot; the runner's own end still seals the session with the observed outcome, and only the runner ever states a verdict. A release credits nothing: submissions and the session proxy stop at the release, an outcome that never arrives leaves the session outcome-less (it grades not-passed), two different outcomes for one test are a lifecycle conflict, and an outcome with no begin still fails closed.

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
