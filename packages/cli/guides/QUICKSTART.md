# Quickstart

> Connecting a second project, or the whole flow including evidence adapters, the test map, and the first green commit? Read [Connect your project](CONNECT-YOUR-PROJECT.md) first; this guide stays the shortest path.

This guide takes a project from install to a blocking gate. Gateforge does not create your app, database, seed data, logins, or test services. Your team or agent provides those first. See [Test environment](TEST-ENVIRONMENT.md).

You need Node.js 20 or newer and an existing Playwright suite that can run against a disposable app.

## 1. Install the CLI and the packs you use

Install the CLI, Playwright pack, and only the detector packs that fit your app. Keep every direct `@gate-forge/*` package on the same release.

Example for a React frontend, FastAPI backend, and SQLAlchemy data layer:

```sh
npm i -D \
  @gate-forge/cli@0.7.1 \
  @gate-forge/pack-playwright@0.7.1 \
  @gate-forge/pack-http@0.7.1 \
  @gate-forge/pack-fastapi@0.7.1 \
  @gate-forge/pack-sqlalchemy@0.7.1
```

Use the project-local `gateforge` binary from your npm script or add `node_modules/.bin` to your shell `PATH`. If the scan recommends other packs, add only the ones your code uses, at the same version. A mismatched Gateforge package contract can stop the CLI with exit code 2 and `GATEFORGE_PACKAGE_INCOMPATIBLE`.

**You should see:** npm installs the packages without a Gateforge compatibility error.

**If not:** align every direct `@gate-forge/*` package to `0.7.1`, then install again. Do not work around the compatibility error.

## 2. Pick a goal

Decide what Gateforge should do for you, then say so once:

```sh
gateforge init --explain-presets   # read what each goal writes
gateforge init --preset normal     # or: light, or strict
```

Or run `gateforge init` in a terminal and answer the one question it asks.

| Goal | What you get | What it writes |
| --- | --- | --- |
| `light` | untested code is listed, nothing blocks | `mode: warn` |
| `normal` | a commit that adds untested endpoints or models is refused (about a second, no test run) | `mode: changed`, pre-commit hook, CI job |
| `strict` | every push needs a real test run Gateforge watches (the *witness*) plus a *receipt*, the signed record of that run | `mode: strict`, staged gate, pre-push receipt check, CI job |

An *obligation* is one thing your policies say must be proven (for example
"this endpoint really stores what it receives"). A preset only chooses how
hard the gate blocks; it never waives an obligation and never hides code
from the scan.

An AI agent or CI run with no terminal and no `--preset` writes `light` only
and says so on ONE line, together with the flag that changes it:
`no terminal: writing the light preset (report everything, block nothing) — a
human must choose the goal: re-run with --preset <light|normal|strict>`. The
closing summary then reports what was written without naming the goal again.
Gateforge will not guess `normal` or `strict` for someone who is not there.

**You should see:** the goal you asked for, followed by a summary of what was
written and an `undo:` command.

**If not:** run `gateforge init --explain-presets`. To change the goal later,
edit the `mode:` key in `.gateforge.yml` (see
[Choose how strict the gate is](#choose-how-strict-the-gate-is)); re-running
`init` never rewrites an existing config.

## 3. Initialize the repository

```sh
gateforge init
```

Gateforge scans the repository and prints recommended packs, then applies the
goal you chose in step 2 (`--preset`, or the answer to the goal question).
It writes:

- `.gateforge.yml`
- `.gateforge/policies.yml`
- `.gateforge/classification-policy.yml`
- `.gateforge/baselines/obligations.json`
- `GATEFORGE.md`
- `tests/e2e/gateforge/README.md` for the default overlay proof path

It also creates `.gateforge/adapters/` and `.gateforge/waivers/`. It preserves existing files. A chosen documentation exclusion adds `.gateforge/docs-exclusions.yml`.

**You should see:** a scan summary, recommended packages, the goal summary
with its `undo:` line, and a `skeleton ready` message.

**If not:** read the first error. Fix invalid or missing project configuration, install a recommended pack, then run `gateforge init` again. Existing files are not replaced by a normal rerun.

## 4. Find existing tests and suggestions

First inventory the test suite:

```sh
gateforge tests discover
```

Then ask Gateforge which existing tests may cover the obligations:

```sh
gateforge tests suggest
```

Discovery writes a derived catalog under `.gateforge/test-gates/`. Suggestions are for inspection; they do not create declarations or prove a test.

**You should see:** discovered test keys and suggestions with obligation IDs and any mapping problems.

**If not:** fix Playwright installation, configuration, or test enumeration first. Do not treat an empty or failed inventory as proof that no tests exist. If a test does not fit, the suggestion report explains what is missing.

## 5. Declare which existing tests cover claims

Use either a Playwright annotation or the tracked map file. Declarations tell the gate which test is relevant; they are not proof by themselves.

An annotation uses the exact obligation ID:

```ts
test('updates a profile', {
  annotation: { type: 'gateforge', description: '<obligation-id-from-suggest>' },
}, async ({ page }) => {
  // Existing test body.
});
```

Or declare an existing catalog entry with `tests mark`:

```sh
gateforge tests mark \
  --test '<exact-test-key-from-discover>' \
  --kind browser-e2e \
  --category persistence.update \
  --obligation '<exact-obligation-id-from-suggest>' \
  --reason 'Existing test updates a profile.'
```

`tests mark` writes `.gateforge/test-map.yml`. Commit that file so `check`, hooks, and CI can read the declaration without listing the suite. Replace the example values with exact values from your catalog and suggestion output. Never mark a test that does not perform the claimed behavior.

**You should see:** the sidecar diff, or a current annotation in the test. A repeated identical `tests mark` reports no changes.

**If not:** rerun discovery, copy the exact test key and obligation ID, and resolve any mapping contradiction. Do not use a declaration to silence a blocker.

## 6. Prepare a verifier key and the app

Keep the key outside the repository and run-state folder:

```sh
mkdir -p "$HOME/.config/gateforge"
gateforge key create --file "$HOME/.config/gateforge/keys.json" --confirm
export GATEFORGE_WITNESS_VERIFIER_KEY_FILE="$HOME/.config/gateforge/keys.json"
```

The command prints a key ID, not the secret. Set the app URL and any session state the suite needs. The application and test environment must already be running; see [Test environment](TEST-ENVIRONMENT.md).

**You should see:** `verifier key ring created` and an active key ID.

**If not:** create the parent directory, check file permissions, and keep the key file outside `.gateforge/test-gates/` and the repository.

## 7. Run the supervised tests

```sh
gateforge test-gates --changed
```

Gateforge supervises the full relevant mapped suite and writes an authenticated receipt only after a complete successful run. To run only the tests affected by your change, add `--scope changed` (see [How much runs?](#how-much-runs)).

**You should see:** the selected tests pass and the run seals a receipt.

**If not:** use the first typed blocker. Check the changed-file base, mapping, app readiness, seed data, and verifier key. A test declaration or a plain passing test run is not a receipt.

## 8. Check the changed code

```sh
gateforge check --changed --require-e2e
```

This checks the changed scope and requires a current receipt for the exact inputs. Do not edit files between the witnessed run and this check; changed bytes make the receipt stale.

New receipt JSON includes an authenticated `engine` identity. If present,
`check --require-e2e` blocks when the installed CLI version differs; older
receipts without this additive key retain their existing behavior.

**You should see:** a clean report for the changed scope.

**If not:** ask Gateforge for one next action:

```sh
gateforge next
```

Follow its `do:` line, then run the check again. See [Test environment](TEST-ENVIRONMENT.md) if the block is caused by setup or test state.

To verify a specific commit tree (for example, the tip of a pushed ref)
instead of the current worktree or index:

```sh
gateforge check --candidate-commit <full-commit-sha> --require-e2e
```

Add `--changed` to evaluate only that commit's first-parent diff. The command
uses an isolated checkout of the immutable commit tree.

## 9. Install the blocking hook and CI wiring

```sh
gateforge init --blocking
```

`gateforge init --preset strict` does the same wiring plus the strict E2E
enforcement block, and `--preset normal` writes the fast static pre-commit
lane plus the CI job without the receipt lane. The explicit flags below keep
working exactly as before and always win over a preset.

This installs a static pre-commit lane and (for a new config) a pre-push
receipt lane, then adds strict CI wiring. Review the output and generated files:

- `.git/hooks/pre-commit` (or the configured Git hooks path)
- `.git/hooks/pre-push` (verifies each pushed commit tip)
- `.gateforge/hooks/gateforge-staged.sh`
- `.gateforge/ci/gitlab-gateforge.yml` and `.gitlab-ci.yml` by default

The pre-commit lane checks staged bytes without requiring a receipt. The
pre-push lane runs `check --candidate-commit <sha> --require-e2e`; a missing
or stale receipt blocks the push. Existing configs without
`enforcement.receiptStage` retain their previous hook behavior.

`init --blocking` prints GitHub and GitLab branch-protection commands for an
owner to review and run; Gateforge never changes server settings itself.
For GitHub Actions, use `gateforge enforce --ci github` in an initialized
repository. It writes `.github/workflows/gateforge.yml`, which runs
`test-gates --changed` and verifies the exact commit with
`check --changed --candidate-commit "$GITHUB_SHA" --require-e2e`. Configure
the verifier key and policy pin as protected secrets. A local hook alone is
not server enforcement.

**You should see:** `installed:`, `updated:`, `verified:`, or a framework-managed hook message, followed by `blocking gate wired`.

**If not:** follow the exact `required action` printed for an incomplete installation. Resolve hook-manager conflicts, then rerun `gateforge init --blocking` and verify the active hook.

## How much runs?

| Command | Runs |
| --- | --- |
| `gateforge test-gates --changed` | every mapped test relevant to the repository (full scope) |
| `gateforge test-gates --changed --scope changed` | only tests mapped to obligations affected by the changed files |

"Changed files" come from `changed.provider`: the staged index locally, or the pull/merge request diff against its base in CI. No earlier receipt or full run is needed first, and commits already on the base branch are not re-tested.

A changed slice that affects no obligation (for example, only a log constant changed) does not seal a receipt, because "nothing affected" is not proof. Run full scope in that case. Documentation-only edits avoid this when their folders are approved with `gateforge init --docs-exclude`.

`check --changed --require-e2e` accepts a slice receipt only when it covers every currently changed obligation.

## Choose how strict the gate is

`.gateforge.yml` takes one optional key:

```yaml
mode: warn      # evaluate and report everything, exit 0 (wouldBlock says what was found)
mode: changed   # block only on debt this change touches; the full debt is still reported
mode: strict    # today's behavior — also the default when the key is absent
```

The key changes the GATE, never the evidence: verdicts, counts and cause
codes are identical in every mode, the active mode is printed in every
report, and `gateforge enforcement doctor` reports a non-strict mode as
`WARN`. A config/usage error still exits 2 in every mode. The key lives
inside the pinned trusted policy, so changing it is an owner decision.

## Quarantine a flaky test

```bash
gateforge quarantine 'playwright:chromium:tests/e2e/orders.spec.js:Orders>lists orders' \
  --owner team-orders --approver lead@example.invalid \
  --reason 'flaky in CI: seeded clock race' --expires 2026-04-30
```

The test key is the catalog's logical key (`gateforge tests discover`
prints them). The quarantine removes that test from the required set for
at most 14 days. It proves nothing (an obligation only it covered stays
`missing`) and never blocks. An expired quarantine is ignored and BLOCKS
until it is renewed or deleted. Only the owner can write one, and the
file is part of the pinned trusted policy.

## Coming next

- `gateforge tests sync` will generate test-map entries from annotations.
- Unprovable contracts will be off by default.
- Multiple updates on one row will be evaluated per step.
