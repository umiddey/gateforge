# Changelog

## Unreleased

### Added

- Optional owner-chosen gate strictness: `mode: strict|changed|warn` in `.gateforge.yml`. A missing key is `strict`, which is exactly today's behavior. `changed` blocks only on debt this change touches (the full debt is still reported); `warn` evaluates and reports everything and exits 0 with an additive `wouldBlock`. Exit code 2 (config/usage) is never softened, and the active mode is printed in every report and surfaced by `gateforge enforcement doctor`.
- `gateforge quarantine <testKey> --owner --approver --reason --expires` writes an owner-approved, always-expiring (max 14 days) flaky-test quarantine. A quarantined test leaves the required set, its outcomes and evidence are never used for any claim (an obligation only it covered stays `missing`), and it never blocks. An expired quarantine is ignored and blocks with `QUARANTINE_EXPIRED`. Quarantine files are part of the pinned trusted policy, so an agent-authored quarantine is a policy change that blocks until the owner repins.
- Goal-based `gateforge init`: one question (light / normal / strict) or `--preset light|normal|strict` maps a goal to the exact settings it writes and prints them, plus the `undo:` command. `gateforge init --explain-presets` prints the same mapping and writes nothing. With no terminal and no `--preset` (an AI agent or CI), init writes `light` only (`mode: warn`, no hooks) and prints that a human must choose; it never guesses `normal` or `strict`. A preset never writes a waiver, an adopted baseline or a plane rule, and an existing `.gateforge.yml` is never rewritten.

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
