# Changelog

## Unreleased

### Added

- Adapter kit `@gate-forge/witness/adapter-kit`: `defineHttpAdapter(config)` builds a contract-valid evidence adapter from a reviewed config (read/list paths, wrapper keys, projected fields, paging, a witness-side login seat). Paging is bounded and fails closed with `result truncated` instead of returning a partial list; a redirect-only read path fails closed naming its `Location`; credentials come only from named witness environment variables. Adapters without `volatileFields` behave exactly as before.
- An adapter may DECLARE the fields the server computes itself (`volatileFields`). The witness stamps the declaration onto the persistence record, the exact-value echo skips exactly those keys, and the run reports every skip as a non-blocking `ADAPTER_VOLATILE_FIELD_SKIPPED` advisory. An undeclared key still fails the echo as before.
- `gateforge adapters scaffold [--dry-run]` writes one reviewable starting-point adapter per business resource that has none, from the compiled graph and the route inventory. It never overwrites, marks every guess in the file's own header, and prints a "needs you" list with the reason for everything it refuses to guess. `gateforge adapters check [--probe --base-url URL] [--probe-id ID]` loads and validates every adapter with the same contract validator the witness uses, reports the resources that still have none, and with `--probe` issues one read-only GET per adapter (ok / absent / auth / fingerprint mismatch / failed). `gateforge enforcement doctor` carries the same audit as one summary line.
- `CONNECT-YOUR-PROJECT.md`: the full zero-to-first-green-commit guide (stacks, `init`, test environment, runner, adapters, test map, first run, hooks/CI, single-test re-check, and the top ten problems the first integration hit), linked from the README and the quickstart.
- Optional owner-chosen gate strictness: `mode: strict|changed|warn` in `.gateforge.yml`. A missing key is `strict`, which is exactly today's behavior. `changed` blocks only on debt this change touches (the full debt is still reported); `warn` evaluates and reports everything and exits 0 with an additive `wouldBlock`. Exit code 2 (config/usage) is never softened, and the active mode is printed in every report and surfaced by `gateforge enforcement doctor`.
- `gateforge quarantine <testKey> --owner --approver --reason --expires` writes an owner-approved, always-expiring (max 14 days) flaky-test quarantine. A quarantined test leaves the required set, its outcomes and evidence are never used for any claim (an obligation only it covered stays `missing`), and it never blocks. An expired quarantine is ignored and blocks with `QUARANTINE_EXPIRED`. Quarantine files are part of the pinned trusted policy, so an agent-authored quarantine is a policy change that blocks until the owner repins.
- Goal-based `gateforge init`: one question (light / normal / strict) or `--preset light|normal|strict` maps a goal to the exact settings it writes and prints them, plus the `undo:` command. `gateforge init --explain-presets` prints the same mapping and writes nothing. With no terminal and no `--preset` (an AI agent or CI), init writes `light` only (`mode: warn`, no hooks) and prints that a human must choose; it never guesses `normal` or `strict`. A preset never writes a waiver, an adopted baseline or a plane rule, and an existing `.gateforge.yml` is never rewritten.
- The supervised spool drain exposes its own persistence-intent forward progress (`whenIntentsForwarded(count)`): it resolves once the witness has answered that many drained intents, so a caller can wait for the server-side probe to have run instead of guessing a number of poll ticks. It is the drain's own fact — the supervised suite only appends to the spool and can neither observe nor assert it — and it fails closed (rejects) rather than resolving on an unproven assumption.
- `gateforge test-gates --test <selector> --result-only` runs hand-picked tests witnessed, in seconds, instead of a whole suite. `--test` is repeatable and is accepted ONLY with `--result-only`: a hand-picked list never seals a receipt. A selector is a logical key or a unique substring of one, resolved against the planned rows (never raw runner output); an unknown or ambiguous selector exits 2 with the candidate keys listed. The named run uses the additive `named-selection` selection mode, so it can never collide with a full or scoped seal, and adds `selectors: [{ selector, logicalKeys }]` to the report. It works for every runner through the shared adapter contract.

### Changed

- Reports gained additive fields only, and only when they apply: `strictness` (non-strict modes) and `quarantine` (non-empty population). SARIF output stays machine-parseable JSON.

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
