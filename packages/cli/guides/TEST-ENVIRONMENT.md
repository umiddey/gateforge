# Test environment

**Gateforge does not build the test environment.** It does not create databases, seed data, logins, or services. Your team or agent builds and resets them. This guide lists what Gateforge needs from that environment.

## Use an isolated, disposable stack

**Rule:** Use separate test containers, network, and volumes. Never point a witnessed run at staging or production.

**Why:** Tests create and change data. A shared or live target can leak test data or let one run affect another.

**Example:** Give the test stack its own Compose project name, such as `gateforge-test`, and its own database volume.

## Reset and seed before every run

**Rule:** Reset to a known clean state before every run. Restore a clean-state dump or run a seed script from the same checkout being tested.

**Why:** Old data makes outcomes depend on run order or another developer's test.

**Example:** `reset disposable database -> seed from this checkout -> run tests`.

## Create login state against the app

**Rule:** Mint the Playwright login state by connecting directly to the app, not through the witness proxy. Reuse one session file instead of repeatedly logging in. Set `GATEFORGE_SESSION_STATE` to that file for the supervised run.

**Why:** The witness must bind a run context before it observes traffic. Once the proxy has observed traffic, binding a new run is refused. Repeated login attempts can also hit rate limits.

**Example:** Create `.cache/gateforge-session.json` against `http://app.example.test`, then set `GATEFORGE_SESSION_STATE=.cache/gateforge-session.json`.

## Run containers as your user

**Rule:** Give containers your user and group IDs.

**Why:** Root-owned auth or key files can become unreadable to your account. Git may also report dubious ownership.

**Example:**

```sh
docker compose run --user "$(id -u):$(id -g)" app
```

Replace `app` with the service in your Compose file.

## Keep the repository unchanged during a run

**Rule:** Do not mount a different environment file over a tracked file or create temporary symlinks in the repository. Ignored files count too. Precompile first, or set `PYTHONDONTWRITEBYTECODE=1`; warm caches before the run.

**Why:** The candidate must stay the same from test planning through receipt verification. A changed or newly written cache can stale the receipt even when Git does not show it by default.

**Example:** Set `PYTHONDONTWRITEBYTECODE=1` before Python tests. Prewarm `.pytest_cache` before sealing a run, or configure the tool not to write it.

## Make hooks repeatable

**Rule:** Hooks must not rewrite ignored files on each run, such as a linter cache. Run the full hook list twice and compare a stable tree ID before and after.

**Why:** A hook that changes its own inputs makes repeated checks non-reproducible.

**Example:** This Linux example hashes repository files, including ignored files, but excludes Git's internal directory:

```bash
tree_id() {
  tar --sort=name --exclude=./.git --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - . | sha256sum
}
before="$(tree_id)"
# Run the full hook list.
# Run the full hook list again.
test "$before" = "$(tree_id)"
```

The final comparison must pass. If it fails, find and disable or prewarm the writer before the witnessed run.

## Sync a private Git copy

**Rule:** If the runner uses a private copy of `.git`, sync both refs and the index before every run.

**Why:** A copied checkout with stale refs or a stale index can calculate a different changed-file set than the working repository.

**Example:** Before invoking the runner, copy the current branch refs and staged index into its private Git directory.

## Keep the harness in a durable place

**Rule:** Store the harness in this repository or a shared tools repository, not in `/tmp`.

**Why:** Temporary directories can be wiped on reboot and are not reproducible by teammates or CI.

**Example:** Keep reset, seed, and test-run scripts under a tracked `tools/` directory.

## Keep the verifier key outside the repository

**Rule:** Use a current-user-only key ring outside the repository and run-state folder, with mode `0600` or stricter. CI can use a protected secret instead. Never put key material in the state folder.

**Why:** The key signs trusted evidence. A repository file or run artifact is writable by the candidate and cannot be a safe secret store.

**Example:**

```sh
mkdir -p "$HOME/.config/gateforge"
gateforge key create --file "$HOME/.config/gateforge/keys.json" --confirm
export GATEFORGE_WITNESS_VERIFIER_KEY_FILE="$HOME/.config/gateforge/keys.json"
```

The CLI does not print the secret. Keep backups private too.

## Register the same tests in every mode

**Rule:** Register the same test set in discovery and witnessed modes. Only the witnessed test body may depend on `GATEFORGE_*` environment variables.

**Why:** If environment checks hide tests from the planned suite, the witness sees planned tests that did not execute and refuses the receipt.

**Example:** Do not wrap a whole `test()` declaration in `if (process.env.GATEFORGE_WITNESS_URL)`. Keep the test registered and put mode-specific setup inside the body.

## Declare claims before the gate

**Rule:** Put claims in the tracked `.gateforge/test-map.yml` when `check` must know them without listing the suite.

**Why:** Hooks and CI run `check`; they do not enumerate the test suite to discover annotations. A declaration in the map is visible before test execution.

**Example:** Use `gateforge tests mark` to write the entry, then commit `.gateforge/test-map.yml` with the test changes.

## Set the changed-file base in CI

**Rule:** Set `changed.provider` to `auto` or the intended CI provider, and provide that provider's base reference.

**Why:** Without the correct diff base, `--changed` can select no files or the wrong files. `auto` uses `GITHUB_BASE_REF` on GitHub Actions, `CI_MERGE_REQUEST_DIFF_BASE_SHA` on GitLab merge requests, and otherwise the local staged diff.

**Example:**

```yaml
changed:
  provider: auto
```

For a GitHub Actions pull request, set `GITHUB_BASE_REF`. For a GitLab merge request, set `CI_MERGE_REQUEST_DIFF_BASE_SHA`.

## Keep the runner quiet

**Rule:** Keep concurrent work below the machine's CPU count. Prefer a quiet runner for witnessed tests.

**Why:** Heavy parallel jobs compete with the app and browser and can cause timeouts.

**Example:** Run one changed slice at a time on a small CI runner.

## Verify service names and fallbacks

**Rule:** App, database, and worker names or aliases must resolve inside the container network. Read service logs and check for silent fallbacks.

**Why:** A service can appear healthy while the app falls back to a local database, default credentials, or a different endpoint.

**Example:** From the app container, verify the configured database hostname resolves, then inspect the app log for its selected database URL.

## Start with a small changed slice

**Rule:** Start with `--changed`; a full run can take much longer. Use `--result-only` to inspect selected test results when unrelated existing debt blocks the full gate.

**Why:** A small slice shortens feedback. Result-only reports results but cannot authorize a gate receipt.

**Example:**

```sh
gateforge test-gates --changed --scope changed --result-only
```

For an authoritative slice, run `gateforge test-gates --changed --scope changed` without `--result-only`. `gateforge test-gates --changed` alone runs the full relevant mapped suite. Then run `gateforge check --changed --require-e2e` on the same inputs.

A changed file can affect obligations that have no test at all. Those
still block the slice, one blocker each, with the reason:

```text
changed-scope planning: obligation 'tenant.orders:persistence:read' is affected by the changed files but no declared mapping (sidecar entry or native annotation) resolves to a test the current catalog still enumerates — narrower selection is never guessed; map a test or run full scope
```

When the repository adopted its existing debt with `gateforge adopt`,
those obligations are forgiven exactly as the full run forgives them, so
they do not block the slice — the run says so in one line instead, and
they stay inside the sealed covered set, so `check --require-e2e` still
demands what the full path grades. An obligation the baseline never
adopted still blocks, and strict E2E forgives nothing at all.

```text
1 affected obligation(s) have no declared mapping and are forgiven by the adopted baseline; they stay uncovered by this slice
```

## Write witnessed tests for observable behavior

**Rule:** Read a response body only when the app itself reads it. Use a random token in unique names. Anchor only fields the configured adapter exposes. Use one update anchor per entity. Wait for the page's own requests to finish before typing into a form that refetches data.

**Why:** Extra response reads can leave Playwright waiting. Reused names collide with seeded data. Unavailable or duplicate anchors cannot be independently checked. Typing before a refetch finishes can target stale UI.

**Example:** Use a unique name such as `profile-${randomToken}`, wait for the form's data request, then enter only adapter-supported fields.

## Maintain test data with features

Keep shared seed data small: logins, one base tenant, and required roles. Store its seed script in the repository and configure it as `harness.seed`, which runs after migrations. Avoid large SQL dumps that must be rewritten for every schema change.

Tests own the rest of their data. Each test creates only the rows it needs and uses a unique token in names or keys; do not depend on shared rows left by another test.

Carry each feature, its tests, and any base-seed change together in the same merge request. This keeps seed maintenance alongside the schema and behavior it supports.

Local runs and CI should invoke the same configured `harness` commands and seed script. Because configured harness scripts are part of the input snapshot, changing one invalidates prior evidence.

## Run cheap checks before the suite

Put fast checks such as formatting, lint, and import checks in `prepare.preflight`. They run before preparation and the suite. Prefer checks that do not write to the workspace; any input drift still prevents a reliable receipt.

Run suite containers as the invoking user, avoid swapping mounted `.env` files or creating temporary workspace symlinks during the run, and warm or disable caches before sealing evidence.

## Re-check one failing test without a full run

When two tests fail and you only need to know whether your fix worked,
do not spend a whole suite on it. Name the tests instead:

```bash
# One test: a logical key, or any unique substring of one.
gateforge test-gates --test 'backend/tests/test_outbox.py::test_commits' --result-only

# Two or more: --test repeats.
gateforge test-gates --test UC-53 --test UC-51 --result-only
```

The run is still fully witnessed — same supervisor, same run token,
same server-side evidence — it just executes the named tests instead of
the whole suite, so it finishes in seconds.

Two rules keep this safe to run any time:

- It is only accepted with `--result-only`. A hand-picked list never
  seals a receipt, so it can never stand in for the gate.
- It never reads, writes, or clears `.gateforge/test-gates/receipt.json`.
  Your existing receipt is byte-identical afterwards, and
  `gateforge check --require-e2e` still reports exactly what it did
  before.

If a selector matches nothing, or more than one planned test, the
command exits 2 and lists the candidate logical keys instead of
guessing:

```bash
gateforge test-gates --test 'session proxy' --result-only || true
```

To find the exact keys, read them off the additive `selectors` field of
any named run, or from `.gateforge/test-gates/test-catalog.json`
(`gateforge tests discover`).

Because selection works from the plan rather than from changed files,
this is also the way to re-check a fix that touched a `.env`, a helper,
or a fixture: no test links to those files, so a changed-file slice
cannot select them.

### What a named run grades (and how it exits)

A named run grades **only the tests it named** — the obligations those
tests declare. Debt elsewhere in the repository is still printed (under
`repositoryDebt`, and as `not graded in a named run: N obligation(s)`),
but it does not block: this run never observed it, and it never becomes
a verdict. Only the run's own honesty still blocks: a red named test, an
obligation the selection declares but cannot prove, an incomplete run, or
a workspace that changed underneath it.

| Exit | Meaning |
| --- | --- |
| `0` | the whole selection is green and every claim it declares is satisfied |
| `1` | a red selected test, an unproven claim, or a run that was not complete/honest |
| `2` | the selector matched no planned test, or more than one (nothing ran) |

So a green named run is a statement about your selection, never about the
repository: it says nothing about the other 500 obligations your branch
still owes. Use `gateforge test-gates --changed` (or `--changed --scope
changed`) for those.

Playwright, pytest and vitest are handed the exact location of each named
test, so only those tests execute. Cypress has no trustworthy way to
filter below a spec, so the whole spec runs and the report tells you so:
`also ran N other test(s) in the same file — not graded`. Those extra
tests' results are dropped before grading — they are never evidence.

## Fix one test without a full run

When a whole-suite run fails on one test, fixing that test changes the
candidate, so the run you just paid for no longer describes it — and the
default answer is another whole suite. If the only thing you changed is
test code, you can re-run just the tests the change can affect and carry
the rest forward, if you ask for it.

**Rule:** turn the path on once, then use `--changed --scope changed`.

```yaml
# .gateforge.yml
enforcement:
  reseal: true
```

```sh
# Fix one failing test, then:
gateforge test-gates --changed --scope changed
```

```text
only test files changed: re-ran 1 test(s), kept 562 from the previous receipt
```

The path is **off by default in every gate mode**, and
`enforcement.reseal: true` turns it on in any mode, `strict` included.
Without the key, every run behaves exactly as before.

**What may be re-run.** Gateforge never takes the change set on trust. It
diffs the two sealed trees itself, classifies every changed path from the
runner's own catalog and the repository import graph, and re-runs the
affected tests witnessed, like any other run. Eligible:

- **test files** — paths the runner's own enumeration lists as tests;
- **test helpers** — files under the test roots that test files import.
  The importers re-run too: a changed spec can export a shared fixture or
  a `test.extend`, so every spec that imports a changed file re-runs,
  transitively.

Everything else — app code, runner config, `package.json`, lockfiles,
seed data, `.env`, `.gateforge/**`, generated files, docs — takes the full
run, as does a setup or dependency-stage test file (it changes every
dependent test without an import edge) and any import the graph cannot
resolve. A refused re-seal prints **one plain reason line** and the run
proceeds through the unchanged path; the lines are verbatim:

```text
app file changed: backend/app/invoices.py → full run
app file changed: e2e/support/fixtures.ts is imported by no test file, so it is not a test helper → full run
app file changed: e2e/support/fixtures.ts imports the changed test helper e2e/support/api.ts → full run
app file deleted: e2e/journeys/legacy.spec.ts → full run
setup test changed: e2e/global-setup.spec.ts → full run
setup test changed: e2e/accounts.spec.ts (the runner config declares a dependency project whose tests cannot be resolved) → full run
unresolvable import: e2e/accounts.spec.ts → ./load-fixture → full run
unresolvable import: e2e/support/api.ts loads a module through a computed specifier → full run
the sealed trees could not be diffed (a1b2c3d → e4f5a6b) → full run
the sealed trees are identical, so there is nothing to classify → full run
the re-seal path is off (`enforcement.reseal` is not true) → full run
the run state already retains 5 consecutive re-seals, the bound this path may chain to → full run
```

**The run that failed.** A complete whole-suite supervised run seals a
receipt only when it is clean, so the case you care about — 563 tests,
562 passed, one failure caused by a race *in the test* — has no receipt
to carry from. That run leaves `.gateforge/test-gates/run-record.json`
instead: a MAC'd, digest-bound record of the execution result, the
attestation, the candidate tree, the inputs, the policy, the engine
bundle, the execution boundary and the per-test outcomes, with no
verdict. It is never accepted as a receipt by `check` or the broker. Fix
only the failing test and run the same command; the record is the parent
and the report says `kept 562 from the previous run`. Two rules keep that
honest: every test that did **not** pass in the recorded run must be
inside the affected set (the change must have touched it) and must pass
now. Otherwise:

```text
the previous run's test playwright:chromium:e2e/checkout.spec.ts:checks out failed outside the affected set → full run
the previous run's test playwright:chromium:e2e/legacy.spec.ts:old journey no longer exists and no changed file explains it → full run
the previous receipt sealed a slice, not a whole-suite run → full run
the previous receipt graded 561 obligation(s) while this candidate declares 563 → full run
```

**At most five in a row.** Each re-seal carries its parent, so the
evidence can be walked back at most five hops before it has drifted too
far to recompute honestly. The sixth consecutive re-seal takes the full
run and says so; `check --require-e2e` rejects a longer chain the same
way.

**CI and the broker recompute all of it.** A re-sealed receipt is never
believed. `check --require-e2e` and `broker commit` walk the retained
chain with their **own** keyring and object store and redo the work: the
parent authenticates, the two sealed trees are re-diffed, the claimed
changed paths are compared with the real diff, the change set is
re-classified from the retained catalog, the affected set is recomputed
and matched against the fresh outcomes, and the parent must carry
exactly the rest. Any mismatch is a typed `EVIDENCE_STALE` with the
exact reason, for example:

```text
the re-sealed receipt names parent 9f2c… but the run state retains no parent receipt (fail closed)
re-seal hop 1 claims a receipt parent but the run state retains a run-record (fail closed)
re-seal hop 1's parent receipt does not authenticate with this keyring: … (fail closed)
the re-sealed receipt carries 6 consecutive re-seals, past the bound of 5 — run the full suite
this consumer has no verifier keyring or object store, so the re-seal cannot be recomputed (fail closed)
```

**Residual risk.** Tests that pass or fail depending on what ran beside
them are the honest limit of any partial re-run: a test that shares data
or ordering with another can pass in a partial run and fail in the full
one, or the reverse. The re-seal never claims more than the diff proves,
but a partial run is not a substitute for a periodic full run — keep
running the whole suite on the merge request, and use this to shorten
the fix loop.

## Reusable run script

Replace the reset and seed comments with durable commands for your disposable stack. The seed must come from this checkout. `test-gates` starts and supervises the witness for the run.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Reset the disposable database from a clean-state dump or reset script.
# <your reset command>

# Seed it from this checkout.
# <your seed command>

# Start the supervised witnessed run and seal a receipt on complete success.
gateforge test-gates --changed

# Check the same changed inputs against that receipt.
gateforge check --changed --require-e2e
```
