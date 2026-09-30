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

### Per-session login identity (why a test may hand the witness its own tenant)

**Rule:** A test that creates a new tenant — or any row that only exists
inside a tenant it just made — registers THAT tenant's login with the
witness for ITS OWN session, through the session-authenticated
`evidence.registerSessionIdentity({ seat, values })` call (the witness
endpoint is `POST /sessions/identity`). The values are keyed by the same
witness environment variable names the adapter's seat already declares;
the seat name is the one the adapter reads through.

**Why — the trust argument.** A registration is a statement about
*who the engine reads as*, for one session. That is the whole of its
authority:

- **The engine still performs every read.** Nothing about a
  registration lets the suite answer for itself. The adapter's GET, the
  persistence echo and the record are the engine's own work; the
  registered credential only chooses the account those GETs are made
  with. A test that supplies data instead of a credential produces no
  record at all, exactly as before.
- **A wrong tenant makes the row unfound.** The credential can only
  change which rows the app is willing to return. If the registered
  login belongs to another tenant, the app answers 403/404 (or returns
  that tenant's rows), and the engine records what the app said: the
  created entity reads as **absent** and the create is graded
  **failed**, not passed. The failure mode of a wrong identity is a
  closed door, never an open verdict.
- **It can never affect another session.** The endpoint authenticates
  the caller as the session it names (`sessionId` + `sessionToken`), so
  a test cannot register an identity for a foreign session; the identity
  is keyed by that session id alone, is dropped when the session closes
  or is released, and never outlives it.
- **It can never affect a record it did not cause.** A record is issued
  by the engine for its own read, stamped with the session's
  supervisor-registered test identity. A registration neither issues,
  edits, nor transfers a record, and the run manifest, state directory
  and report contain no credential value at all — the credential lives
  in witness memory for the length of the session and nowhere else.

Without a registration the engine reads as the process-global seat
credentials in the environment, byte-identically to today's behavior.

**Example:** A per-tenant singleton table (`unique (contractor_id,
ledger_id, kind)` — see the `RESOURCE_SINGLETON_PER_TENANT` advisory)
cannot be proven by a read that uses the fixed seat: that seat's tenant
already has its row. The test creates the tenant first, registers that
tenant's login, then performs the read:

```js
test('creates the first ledger entry for a fresh contractor', async ({ evidence }) => {
  await createContractorAndLogin({ evidence });   // your own fixture step
  await evidence.registerSessionIdentity({
    seat: 'contractor',
    values: {
      GATEFORGE_ADAPTER_CONTRACTOR_USER: contractorUser,
      GATEFORGE_ADAPTER_CONTRACTOR_PASSWORD: contractorPassword,
    },
  });
  const receipt = await evidence.ui.create({ fields: { ledger: 'opening', kind: 'debit' } });
  await evidence.persistence.verify(receipt);
  await evidence.finalize();
});
```

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

**Missing base in a merge-request pipeline?** `test-gates --scope changed` and `check --changed` now stop in seconds with exit 2 and say so. Before that, `auto` fell back to the local staged diff, which in a CI job is empty: the slice graded nothing and the job failed an hour later on debt nobody changed.

## Let the CI job show progress

**Rule:** Leave the progress stream on (`--progress stderr`, or `file:<path>` when the job console is not writable) and do not re-print the runner log to make the screen move.

**Why:** The runner log carries the app env, the request bodies and the seed credentials, so it must stay private. Gateforge's own stream is built from witness-side facts — how many tests were registered, which test is open, its catalog title, its outcome — and never from runner output, so it can be shown without screening. A filter over secret text is not secret-free; not reading the log at all is.

**Example:**

```bash
gateforge test-gates --changed --progress stderr
# or, with a job console that cannot be written to:
gateforge test-gates --changed --progress file:.gateforge/test-gates/progress.log
```

Under `CI=true` the default is already `stderr`; locally it is off, and a local run's output is byte-identical either way. When a test fails, its error message and a short `file:line` stack land in `.gateforge/test-gates/failures.json` behind the same credential guard — publish THAT artifact, not the runner log.

**Reading the numbers:** `repository debt: N known (baselined), M new blocking` names the two numbers separately, and only the gate prints them. `N` is the debt the adopted baseline forgave; `M` is what this run's exit code blocks on — a full run's whole surface, a `--changed` or `--test` run's own slice, never a subtraction that can reach zero while blockers remain. Debt outside a slice run is real and still reported, in its own words: `not graded by this changed-scope run: 96 blocking obligation(s) — this run never observed them; a full run grades them`. The in-runner reporter prints `repository debt: graded by gateforge after the run`: it grades claims only, so it has no waivers, scope or baseline to split debt with, and one run can never show two different counts.

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
seed data, `.env`, `.gateforge/**`, generated files, docs — is not
eligible, and neither is a setup or dependency-stage test file (it
changes every dependent test without an import edge) or any import the
graph cannot resolve. A **literal** dynamic import is an ordinary
import edge, not a computed one: `import('./x.mjs')`, `import("./x.mjs")`,
`` import(`./x.mjs`) ``, `require('./x')`, `importlib.import_module('x')`
and `__import__('x')` all resolve like a static import, so the file that
loads the module is an ordinary importer. Imports are read from the
syntax tree, so an import call named in a comment or a string is never
one. A **computed** specifier — a variable, a concatenation, a template
with `${…}` — refuses the re-seal, wherever it sits in the repository:
Gateforge cannot tell which file it loads, so it cannot prove the
change reaches no other test or app code. Imports never cross the
language boundary, so a computed Python import only matters when a
Python file changed, and a computed JS/TS import only when a non-Python
file changed. To re-seal in a repository that has one, write each
module it can load as a literal import, for example a map
`{ accounts: () => import('./tenant.accounts.mjs'), … }` instead of
`` import(`./tenant.${table}.mjs`) ``.

### Declaring runtime state the run itself rewrites

Some repositories write into the workspace **during** the run: a
witnessed login stage saves its storage state, a runner writes a cache.
Those files are normally gitignored, and a sealed candidate tree covers
the workspace's untracked and ignored bytes too — so the parent tree and
this run's tree differ in them on **every** run. The re-seal sees those
differences as unknown app files and refuses, however test-only your
change is:

```text
app file changed: e2e/.auth/contractor.json → changed-scope run
```

Gateforge cannot guess which ignored files are disposable: an ignored
`.env.test` can flip an outcome, and hiding it silently would be a hole
in the check, not a fix. So the owner declares them:

```yaml
# .gateforge.yml
enforcement:
  reseal: true
  resealRuntimeFiles:
    - 'e2e/.auth/*.json'
```

Entries are repo-root-relative POSIX globs. An absolute path, a
backslash, or a `..` segment fails the config load rather than quietly
matching nothing. Without the key nothing changes, byte for byte.

**The tracked-files rule.** A matching path is disregarded **only when
neither sealed commit tracks it** — when it exists purely as untracked
or ignored workspace bytes. The moment the same path is committed, it is
source: a declaration can never hide a source change, whatever the glob
reads. The rule is the owner's assertion about the repository, exactly
like the documentation exclusions, and the config digest binds it.

**What it prints, and what the receipt records.** One plain line, so the
ignored bytes are visible rather than inferred:

```text
test-gates: re-seal disregards 2 declared runtime file(s): e2e/.auth/contractor.json, e2e/.auth/employee.json
```

The re-sealed receipt keeps `changedPaths` as the **real** tree
difference and adds `resealDisregarded` with exactly the paths the
declaration removed from the classification. `check --require-e2e` and
the broker recompute the list from the same globs and the two commit
trees; a receipt that names a different list is `EVIDENCE_STALE`.

**When to declare it.** Only for files the run itself rewrites, every
run, with no bearing on any test's outcome — storage state, a scratch
cache, a coverage report. Not for anything a test reads to decide what
to assert, and not as a way around an `app file changed` line about
code.

A file that does not parse refuses too (`… does not parse as a
script`): an unread file cannot be shown to declare nothing computed.


A refused re-seal prints **one plain reason line** naming the path and
the step that actually follows: the run takes the ordinary
**changed-scope** path (the only scope in which a re-seal is attempted),
so every line ends in `→ changed-scope run`. The lines are verbatim:

```text
app file changed: backend/app/invoices.py → changed-scope run
app file changed: e2e/support/fixtures.ts is imported by no test file, so it is not a test helper → changed-scope run
app file changed: e2e/support/fixtures.ts imports the changed test helper e2e/support/api.ts → changed-scope run
app file deleted: e2e/journeys/legacy.spec.ts → changed-scope run
setup test changed: e2e/global-setup.spec.ts → changed-scope run
setup test changed: e2e/accounts.spec.ts (the runner config declares a dependency project whose tests cannot be resolved) → changed-scope run
unresolvable import: e2e/accounts.spec.ts → ./load-fixture → changed-scope run
unresolvable import: e2e/support/api.ts loads a module through a computed specifier → changed-scope run
the sealed trees could not be diffed (a1b2c3d → e4f5a6b) → changed-scope run
the sealed trees are identical, so there is nothing to classify → changed-scope run
the re-seal path is off (`enforcement.reseal` is not true) → changed-scope run
the run state already retains 5 consecutive re-seals, the bound this path may chain to → changed-scope run
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
the previous run's test playwright:chromium:e2e/checkout.spec.ts:checks out failed outside the affected set → changed-scope run
the previous run's test playwright:chromium:e2e/legacy.spec.ts:old journey no longer exists and no changed file explains it → changed-scope run
the previous receipt sealed a slice, not a whole-suite run → changed-scope run
the previous receipt graded 561 obligation(s) while this candidate declares 563 → changed-scope run
```


**When the previous run cannot be the parent.** A parent is only usable
when it is bound to this run: the commit **its own document names**, the
same approved policy, engine bundle and execution boundary, an intact
signature, and a sealed tree that really is the tree of that commit. No
CI variable is consulted — see **Consecutive re-seals** below. When the
run state holds such a document and no parent qualifies, the run says so
in **one plain line** naming the first binding that failed, instead of
falling through to the changed-scope path in silence (which looks exactly
like a run that never had a parent):

```text
test-gates: the previous run cannot be re-sealed from: its sealed tree is not the tree of commit 9c8a3b7 (uncommitted changes were tested) → changed-scope run
```

So commit everything the run tests: a run over uncommitted changes can
never be a re-seal parent. Sign every run with the same verifier key
(`gateforge key create` once, or one `GATEFORGE_WITNESS_VERIFIER_KEY`
secret in CI): a run signed with a one-off key reads `it was signed with
a different verifier key` and can never be a parent either. The other bindings read the same way — `it
was sealed at commit 1a2b3c4, which is not an ancestor of HEAD`, `the
approved policy changed`, `the engine changed`, `the execution boundary
changed`, `its execution result was replaced by a later run`, `its
signature does not verify with this keyring`, `the test inventory
is incomplete`, `a named/result-only run never re-seals` — and each is
followed by `→ changed-scope run`. With the path off, or when the run
state holds no parent document at all, nothing is printed and the run is
byte-identical to before.

**Consecutive re-seals.** A re-seal is itself a whole-suite proof: it
names the parent it carried from and seals a
`coveredObligationFingerprints` list covering the whole repository, so the
**next** re-seal carries from exactly the same coverage. Fix one test,
commit, run; fix the next, commit, run — each re-seal's parent is the
previous re-seal, and each printed line counts what the whole chain
carries:

```text
only test files changed: re-ran 1 test(s), kept 562 from the previous receipt
```

The chain is retained hop by hop in `.gateforge/test-gates/reseal-chain/`,
each hop holding its parent receipt, that parent's execution result, the
catalog the classification used, and the witness evidence every
contributing run issued. A test carries when **no** hop re-ran it, so a
spec untouched across the whole chain keeps its original evidence, and
the receipt of record states the chain's total in `carriedTests`.

**At most five in a row.** Each re-seal carries its parent, so the
evidence can be walked back at most five hops before it has drifted too
far to recompute honestly. The sixth consecutive re-seal prints

```text
test-gates: the run state already retains 5 consecutive re-seals, the bound this path may chain to → changed-scope run
```

and takes its own changed-scope run; `check --require-e2e` rejects a
longer chain the same way.

**The parent is the previous run in the state dir.** No CI variable is
involved: the parent must be a document in
`.gateforge/test-gates/` — `receipt.json` from a clean run, or
`run-record.json` from a failed one — whose own `gitSha` names a commit
that **exists in this checkout and is an ancestor of HEAD**, and whose
sealed tree really is the tree of that commit. A merge-base variable is
the wrong thing to bind to (no CI sets it to the commit the previous
pipeline tested), so the re-seal path ignores
`CI_MERGE_REQUEST_DIFF_BASE_SHA` and `GITHUB_BASE_REF` entirely. What
that means for a pipeline is simple: **the state directory must persist
from one pipeline to the next** — cache or restore it, keyed by branch.
With a cold cache the state dir holds no parent, the run is the ordinary
run, and nothing is printed.

**What a carried test brings with it.** A carried test brings its
**outcomes and the evidence those outcomes were witnessed with**: the
parent run's `records.json` and `claims.json`, **retained by the parent
run itself the moment it sealed** — into
`.gateforge/test-gates/reseal-parent/`, so the runs a pipeline does in
between (a materialization pre-step that rewrites `manifest.json`, a
hand-picked `--result-only` selection) cannot take the witness envelope
away from the re-seal — and bound to the parent run's
attestation — the envelope must carry the parent document's own run id
and input digest, hash to the `evidenceAttestationDigest` that document
seals, and verify with your keyring, or the re-seal is refused like any
other parent binding. In a **chain** there is more than one contributing
run, so there is more than one envelope: every retained hop's records are
authorized only by the envelope **that run** issued, and nobody's
envelope vouches for anybody else's records. A hop whose envelope does
not verify takes the whole re-seal with it.

Attribution is by the witness-issued test id, and only the records and
claims whose test **no hop of the chain** re-ran are carried: a re-run
test's parent record never survives, so a test that stopped proving
anything after the fix leaves its obligation unproven. The graded
evidence is the **union** of the carried half and the re-run's own, it is
what the report and the receipt's `verdictSummary` grade, and it is what
stands in the run state afterwards — so the next
`check --changed --require-e2e` grades the same evidence this run did.
The receipt binds the union in `carriedEvidenceDigest`, MAC-covered like
the other re-seal fields.

**CI and the broker recompute all of it.** A re-sealed receipt is never
believed. `check --require-e2e` and `broker commit` walk the retained
chain **hop by hop, outward** with their **own** keyring and object store
and redo the work: each parent authenticates, the two sealed trees are
re-diffed, the claimed changed paths are compared with the real diff, the
change set is re-classified from that hop's retained catalog, the
affected set is recomputed and matched against the fresh outcomes, and
the parent must carry exactly the rest — reduced by what an inner hop
already re-ran, so the chain's carried total is checked once, against the
receipt of record, after every hop has been seen. Each hop's retained
evidence is authenticated against **every** contributing run's envelope
with that same keyring, and the state evidence must equal the recomputed
union. Any mismatch is a typed `EVIDENCE_STALE` with the exact reason, for
example:

```text
the re-sealed receipt names parent 9f2c… but the run state retains no parent receipt (fail closed)
re-seal hop 1 claims a receipt parent but the run state retains a run-record (fail closed)
re-seal hop 1's parent receipt does not authenticate with this keyring: … (fail closed)
re-seal hop 2's parent receipt does not authenticate with this keyring: … (fail closed)
re-seal hop 1's retained evidence does not recompute: its evidence attestation does not verify with this keyring (fail closed)
re-sealed receipt claims 561 carried test(s) but its chain holds 560 carried outcome(s)
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

## Let Gateforge drive the whole run: `gateforge run`

The script above is the shape of a managed run. `gateforge run` performs it
for you, in that order, and stops at the first failure:

1. **preflight** (strict) — the managed-run preconditions, see below;
2. **recipe** — `prepare`, `reset`, `seed`, `services_up`, `healthcheck`;
3. **`gateforge test-gates`** — supervised, with the flags you passed
   (`gateforge run -- --changed`);
4. **`gateforge check --require-e2e`** — the strict receipt check; a scoped
   run (`gateforge run -- --changed --scope changed`) seals a receipt for the
   changed slice only, so it is checked at that scope with
   `check --changed --require-e2e`;
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
   is the default**: narrowing the run is your edit, not the template's. The
   run prints straight into the job log, so the progress stream shows each
   test as it finishes;
5. reads the verdict out of `report.json` (never out of a parsed log line);
6. uploads `report.json`, `receipt.json`, `execution-result.json` and
   `failures.json` as artifacts, `when: always` / `if: always()`. The
   suite's raw output is never written to a file or uploaded: it passes
   through the run and can carry your app's secrets.

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
| `target` | the configured target base URL answers (only probed when one is configured; never with `--witness-url`, because a probe through an external witness's proxy counts as an exchange before the run binds it) | start the app, then export `GATEFORGE_TARGET_BASE_URL` |
| `app-healthcheck` | the recipe's own healthcheck passes (only when a recipe declares one) | make the app healthy, or fix the declared healthcheck |
| `host-load` | advisory only: load average and free disk | never fails a run |
| `candidate-tree` | the tree can be hashed; uncommitted changes are reported | commit or stash before the run |

By default the doctor is report-only and still exits 0 — today's behavior is
unchanged. `gateforge enforcement doctor --strict-preflight` exits 1 at the
first failing precondition, which is exactly what `gateforge run` does before
it starts.

## Find timing bugs on purpose

**Rule:** When a test passes but the product has shipped a stale-response
race, do not wait for a loaded machine to find it again. Re-run the
test with `--chaos <seed> --result-only` and keep the seed.

**Why:** A race — an older list response landing after a newer one, so
the UI shows the wrong tab's rows — only shows up when the older request
happens to be slower. On a fast network it never appears, and on a busy
one it appears at random, which makes it impossible to reproduce, hand
over, or prove fixed. The witness already sits on the request path of
every witnessed test, so it can make the timing uneven deliberately
instead of waiting for luck. Only timing moves: the bytes, the status,
the headers and the evidence semantics are exactly what the app sent.

**Example:**

```bash
# One named test, with its response timing perturbed from a seed.
gateforge test-gates --test 'specs/tabs.spec.js#tab B rows win' \
  --result-only --chaos 4 --progress stderr

# The run names the seed it used, and the seed replays the schedule:
# timing chaos: seed 4 (max delay 400 ms, reorder on) - replay with --chaos 4
```

The same seed always produces the same schedule, so the run that failed
is the run you can re-run. The report and the sealed execution result
carry it: `chaos: { seed, maxDelayMs, reorder, schedule }`, where every
entry names the route key (method + pathname, query stripped — never a
credential), the request index, how long the response was held, and
whether it went out before its predecessor. A second run with the same
seed records the same schedule; that is what makes the finding a finding
instead of a ghost.

Two rules keep it safe to run at any time:

- It is only accepted with `--result-only`, exactly like `--test`. A run
  whose timing was perturbed on purpose finds races; it never proves a
  commit, never seals a receipt and never writes the run record.
- Bounds are yours to tune in `.gateforge.yml` and never switch it on:

  ```yaml
  run:
    chaos:
      maxDelayMs: 400   # default; the ceiling for every applied delay
      reorder: true     # default; may a later response go out first
  ```

  Without `--chaos`, that configuration changes nothing: a repository
  that declares `run.chaos` and never passes the flag runs, reports and
  seals byte-identically. A seed that is not a non-negative integer is
  refused with exit 2 and one plain line, before a witness or a browser
  is started.

Keep a race-free twin next to the racy test — the same requests against
a page that renders by request id. It must stay green under the same
seed; when it does not, the timing is not the finding.

## Keep raw and witnessed twins honest

**Rule:** When a raw test and a witnessed test are meant to cover the
same thing, link them and switch twin coverage on, so the run compares
the requests each side actually made.

**Why:** The reported bug was GREEN. A raw test and its witnessed twin
shared a helper whose parameter defaults sent them down different paths
— the list call carried `?tab=all` in one and `?tab=open` in the other —
so "green three times" proved nothing about the path the witnessed twin
covered, and nothing in the run said so. Both tests were correct; they
were not testing the same thing. Twin coverage records the REQUEST SHAPE
each twin exercised (a method, a route template, and the values of the
query keys YOU allowlist) and reports `TWIN_PATH_DIVERGENT` when the two
sides disagree, naming both tests and the exact differing value.

**Example:**

```yaml
# .gateforge.yml
enforcement:
  twinPaths: advisory        # or: block (then the finding fails the run)
  twinQueryKeys: [tab]       # values of THESE keys may appear in a finding
```

Link the pair in one of two ways, both read only when `twinPaths` is set:

- the test map, when the link should survive a rename of either test —
  `twinOf: <the raw twin's logical key>` on the witnessed test's entry
  in `.gateforge/test-map.yml`;
- the title convention: `X [witnessed]` next to `X raw`, else next to the one
  `X raw: <description>` (so `UC-7 [witnessed]: …` pairs with `UC-7 raw: …`),
  else next to a bare `X`. Two described raw tests under one label link
  nothing: name the pair with `twinOf`.

```bash
# A run with the pair linked reports the divergence and keeps its verdict:
gateforge test-gates --changed --format json
#   advisories: [ { cause: "TWIN_PATH_DIVERGENT",
#     detail: "GET /api/items?tab=open is exercised by '…:lists open items
#              [witnessed]' and never by '…:lists open items raw'" } ]
```

Four rules keep it honest:

- The raw twin proves nothing, and the engine enforces it: its session
  is marked OBSERVATION-ONLY from the registered test identity, and
  every submission from it is refused with 403. What it contributes is
  its request shapes.
- A shape never carries a URL, a body or a value you did not
  allowlist. With no `twinQueryKeys` a shape says a parameter was sent
  and never what it said, so a report is safe to paste into a bug.
- With `twinPaths` absent — or set, with no pair linked — nothing is
  wired, nothing is recorded, no state file is written, and the report
  is byte-identical to a run that never heard of twins.
- The comparison is by the runner's REGISTERED IDENTITY (project, file,
  title path), never by a runner-assigned test id, because a supervised
  run drives its own trusted config and the ids it runs tests under are
  not the ids the repository's config enumerates.

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
