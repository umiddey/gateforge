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


## Let Gateforge drive the whole run: `gateforge run`

The script above is the shape of a managed run. `gateforge run` performs it
for you, in that order, and stops at the first failure:

1. **preflight** (strict) — the managed-run preconditions, see below;
2. **recipe** — `prepare`, `reset`, `seed`, `services_up`, `healthcheck`;
3. **`gateforge test-gates`** — supervised, with the flags you passed
   (`gateforge run -- --changed`);
4. **`gateforge check --require-e2e`** — the strict receipt check;
5. **`services_down`** — always, after success, after a failing gate, and
   after a failing recipe step.

It adds no authority: each step is an existing command with its existing
verdict. What you gain is order, one plain line per step with its duration,
and an exit code that names the first failing step.

### Exit codes

| Step | Code |
| --- | --- |
| usage, config, or recipe error | 2 |
| preflight FAIL | 1 |
| recipe step | the command's own code; 124 when the step exceeded its `timeoutSeconds`, 127 when it could not start |
| `test-gates` | its own code (1 obligations unresolved or the suite failed, 2 config) |
| `check --require-e2e` | its own code (1 no verifying receipt, 2 config) |
| success | 0 |

### The recipe: `.gateforge/runtime.yml`

Optional and additive: with no such document, `gateforge run` starts and
stops nothing and behaves exactly like the commands it sequences. The
document is the same one the witnessed pre-commit staged runtime uses, with
the `gateforge run` lifecycle keys added; a repository can declare either,
or both.

```yaml
schemaVersion: 1
env_files:            # paths only — never an inline value
  - .gateforge/test.env
prepare:
  commands: [['./scripts/install.sh']]   # argv lists, never a shell string
  runTimeoutSeconds: 900
reset:
  commands: [['./scripts/reset-db.sh']]
  timeoutSeconds: 300
seed:
  commands: [['./scripts/seed.sh']]
  retries: 1                            # extra attempts after a failure
services_up:
  commands: [['./scripts/start-stack.sh']]
healthcheck:
  commands: [['./scripts/health.sh']]
  timeoutSeconds: 60
  retries: 5
services_down:
  commands: [['./scripts/stop-stack.sh']]
```

Rules the recipe lives under:

- **paths, never secrets.** `env_files` entries must be existing files; an
  entry carrying `NAME=value` is a schema error. The values are loaded into
  the step environment and are never printed, never logged by Gateforge, and
  never included in a message.
- **no shell strings.** Every command is an argv list, so nothing is
  word-split or re-interpreted. If you need a pipeline, put it in your own
  script.
- **one line per step, output off the console.** Command output is appended
  to `.gateforge/test-gates/run-recipe/<step>-log.txt`; the console only
  receives the step line and, on failure, the log path.
- **unknown keys fail closed.** A typo, a malformed step, or a missing env
  file is a plain error with exit 2 — Gateforge never runs a recipe it did
  not fully understand.

## Run that same proof in CI: the witnessed job template

The same run belongs in CI, and the glue around it (job-scoped names, a
private workspace, base-sha forwarding, verdict extraction, artifacts) is
generic. Generate it instead of hand-writing it a second time:

```sh
gateforge enforce --ci gitlab --witnessed   # .gateforge/ci/gitlab-witnessed.yml
gateforge enforce --ci github --witnessed   # .github/workflows/gateforge-witnessed.yml
```

The generated job is a plain file you review and edit. An existing file is
never overwritten (`exists, leaving untouched: <path>`), and without the
flag every generated file is byte-identical to what it always was. The
static job keeps its own file: the witnessed lane is additive.

What the job does, in order:

1. installs the pinned `@gate-forge/cli` from the repository's lockfile
   (or manifest) and refuses to continue on another version;
2. creates a **private, job-scoped workspace** and exports
   `GATEFORGE_CI_JOB_SCOPE`, `GATEFORGE_CI_STACK_NAME`,
   `GATEFORGE_CI_IMAGE_NAME` and `GATEFORGE_CI_WORKSPACE`, all derived from
   the CI job id — your recipe may use them for a compose stack or a volume,
   and two concurrent jobs of one project can never collide;
3. **forwards the merge-request base sha** into the environment both
   supervised commands run in (GitLab: `CI_MERGE_REQUEST_DIFF_BASE_SHA`;
   GitHub: the fetched base ref plus its merge base). This is the one step
   worth checking in review: without it the `auto` scope provider falls back
   to a local diff, which in CI selects zero changed files and quietly
   narrows what the run grades;
4. runs `gateforge run -- --changed --scope full`, so your recipe owns
   reset/seed/services and the engine still owns every verdict. **Full scope
   is the default**: narrowing the run is your edit, not the template's;
5. reads the verdict out of `report.json` (never out of a parsed log line);
6. uploads `report.json`, `receipt.json`, `execution-result.json` and
   `ci-run.log` as artifacts, `when: always` / `if: always()`.

You fill in two things: the recipe (`.gateforge/runtime.yml`, above) and the
secret variables. On GitLab they are protected, masked CI variables; on
GitHub they are the repository secrets `GATEFORGE_WITNESS_VERIFIER_KEY` and
`GATEFORGE_APPROVED_POLICY_DIGEST`, passed as environment values on the run
step only. The job never echoes a secret variable, and the recipe log
(`.gateforge/test-gates/run-recipe/`) is deliberately **not** an artifact:
your own commands may print your own secrets. Add it only if you know your
recipe logs are clean.

## Read the preconditions before a long run

`gateforge enforcement doctor` prints a `run preconditions` block: one
read-only line per precondition with the exact fix command.

| Line | What it means | Fix it with |
| --- | --- | --- |
| `verifier-key` | an active key resolves outside the repository (a run cannot seal a verifying receipt without one) | `gateforge key create --confirm` |
| `approved-policy` | the owner-approved policy pin is provisioned from a trusted channel and matches this candidate | export `GATEFORGE_APPROVED_POLICY_DIGEST=<digest>` outside the candidate |
| `runner` | the configured runner's binary resolves and reports a version | `npm install --save-dev <runner>` |
| `interpreter` | every configured suite's `argv[0]` exists AND runs | correct `diagnostics.suites.argv[0]` (e.g. `.venv/bin/python`) |
| `bytecode-safety` | the run cannot rewrite `__pycache__` bytes into the candidate tree | `PYTHONDONTWRITEBYTECODE=1 gateforge run`, or pre-compile outside the run |
| `target` | the configured target base URL answers (only probed when one is configured) | start the app, then export `GATEFORGE_TARGET_BASE_URL` |
| `app-healthcheck` | the recipe's own healthcheck passes (only when a recipe declares one) | make the app healthy, or fix the declared healthcheck |
| `host-load` | advisory only: load average and free disk | never fails a run |
| `candidate-tree` | the tree can be hashed; uncommitted changes are reported | commit or stash before the run |

By default the doctor is report-only and still exits 0 — today's behavior is
unchanged. `gateforge enforcement doctor --strict-preflight` exits 1 at the
first failing precondition, which is exactly what `gateforge run` does before
it starts.

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
