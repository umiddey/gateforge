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
