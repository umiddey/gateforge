# Quickstart

> Connecting a second project, or the whole flow including evidence adapters, the test map, and the first green commit? Read [Connect your project](CONNECT-YOUR-PROJECT.md) first; this guide stays the shortest path.

This guide takes a project from install to a blocking gate. Gateforge does not create your app, database, seed data, logins, or test services. Your team or agent provides those first. See [Test environment](TEST-ENVIRONMENT.md).

You need Node.js 20 or newer and an existing Playwright suite that can run against a disposable app.

## The setup order

`gateforge init` → answer the plane questions → `gateforge adopt` (only when the repository already has code) → adapters and runtime → pin the owner-approved policy digest → commit.

- Install the CLI and packs, then commit the install (package.json + lockfile) on its own before `gateforge init` — no gate is wired yet. The setup commit must contain only Gateforge's own files (plus the `.gitignore` block init writes) to count as product-behavior-neutral; mixing in dependency or product changes makes it a normal gated change, which under strictE2E re-grades the adopted E2E debt as blocking. Commit product changes (for example a Playwright config rename) separately, after the setup commit.
- Answer the plane questions with `gateforge classify plane <folder> <tenant|master|global> --reason "<why>" --confirm` (run `gateforge init --planes` once first to create the owner-reviewed `planes:` section of `.gateforge/classification-policy.yml`).
- Adopt comes after the plane answers because a plane answer changes a resource's identity, so the debt set `adopt` records would not match the repository if it were captured before the answer.
- Declare the dependency directories the staged commit gate may link (`prepare: { reuse: [node_modules] }` in `.gateforge/runtime.yml`): the gate runs on a checkout of the staged files only.
- Pin the owner-approved policy digest LAST, right before the first strict commit: `git add -A .gateforge .gateforge.yml && gateforge enforcement pin --pin-file ~/.config/<repo>.gateforge.env --confirm`. The flag is `--pin-file`, not `--env-file`: node itself consumes `--env-file <path>` anywhere in argv and would read the file instead of running the command. Without `--confirm` the command only prints the line it would write. The pin file must live OUTSIDE the repository — a file the candidate controls cannot approve its own policy revision — and the command refuses any path inside the repo, plus a policy input that is not fully staged (it names the file). The digest changes whenever a policy input changes — `.gateforge.yml`, the policies, the classification policy, `.gateforge/test-map.yml`, `planes.json`, adapters, `runtime.yml`, waivers, hooks — so re-pin after every such edit. `gateforge enforcement doctor` names the inputs that changed since HEAD (`policy-inputs-vs-HEAD`) and whether the provisioned pin still matches the staged bytes (`approved-digest`).

## 1. Install the CLI and the packs you use

Install the CLI, Playwright pack, and only the detector packs that fit your app. Keep every direct `@gate-forge/*` package on the same release.

Example for a React frontend, FastAPI backend, and SQLAlchemy data layer:

```sh
npm i -D \
  @gate-forge/cli@0.13.5 \
  @gate-forge/pack-playwright@0.13.5 \
  @gate-forge/pack-http@0.13.5 \
  @gate-forge/pack-fastapi@0.13.5 \
  @gate-forge/pack-sqlalchemy@0.13.5
```

Use the project-local `gateforge` binary from your npm script or add `node_modules/.bin` to your shell `PATH`. If the scan recommends other packs, add only the ones your code uses, at the same version. A mismatched Gateforge package contract can stop the CLI with exit code 2 and `GATEFORGE_PACKAGE_INCOMPATIBLE`.

`gateforge init` prints that same command for you: after it writes the
config it names — in ONE line — every detector pack it enabled that your
`package.json` does not already declare, at the CLI's own version. Run
that line (init never runs npm for you), and commit the install on its own
before committing the setup files.

**Installing from tarballs** (a release that is not on the registry yet): install every `.tgz` of that release in ONE command. The CLI depends on shared packages and packs that are not in the list above, and npm resolves them from the files only when they are all in the same install; a partial set makes npm look for the rest on the registry and fail with `E404`.

```sh
npm i -D ./gate-forge-*.tgz
```

This installs every pack of the release; the scan still recommends the ones your code uses, and `.gateforge.yml` loads only those.

**You should see:** npm installs the packages without a Gateforge compatibility error.

**If not:** align every direct `@gate-forge/*` package to `0.13.5`, then install again. Do not work around the compatibility error.

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
and says so on ONE line, together with the edit that changes it:
`no terminal: writing the light preset (report everything, block nothing) — a
human must choose the goal: edit `mode:` in .gateforge.yml (light: `mode: warn`,
normal: `mode: changed`, strict: `mode: strict`)`. The closing summary then
reports what was written without naming the goal again. Gateforge will not guess
`normal` or `strict` for someone who is not there.

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

It also creates `.gateforge/adapters/` and `.gateforge/waivers/`, and adds
`.gateforge/test-gates/` (Gateforge's own run state: catalog, caches,
receipts, history) to `.gitignore` so `git add -A` never stages it. It
preserves existing files. A chosen documentation exclusion is added to
`.gateforge.yml` under `evidence.exclude.docs`.

**You should see:** a scan summary, recommended packages, the goal summary
with its `undo:` lines, and a `skeleton ready` message.

**If not:** read the first error. Fix invalid or missing project configuration, install a recommended pack, then run `gateforge init` again. Existing files are not replaced by a normal rerun.

### Already have code? Adopt what is there

If the repository already has an application, the next commit is not
green: `gateforge check` reports everything discovery finds as existing
debt, and debt blocks. Do not reach for `--no-verify` — there is a
command for exactly this situation, and `init` names it in its own output
whenever the repository already had code:

```sh
gateforge adopt
```

Then commit the installation **through the hook**:

```sh
git add -A && git commit -m "adopt the gate"
```

The generated pre-commit hook runs `gateforge check --staged --require-e2e`. The first adoption commit passes it **without a bypass**: the repository has no gate at HEAD, so the check judges that commit in adoption mode — it demands a sealed receipt for the obligations this commit newly claims (a `--scope changed` run over the same staged candidate is accepted) and leaves pre-existing debt as `adopt` baselined it. There is nothing to configure: adoption mode is computed from HEAD, and once the gate exists every later commit is judged in full.

```sh
gateforge test-gates --changed --scope changed   # seal the receipt the hook will read
git add -A && git commit -m "adopt the gate"    # the hook runs check --staged; no --no-verify
```

It records today's blocking findings as forgiven debt, in
`.gateforge/baselines/obligations.json` plus a dated receipt in
`.gateforge/baselines/adoption.json`, and then wires the blocking gate.

- The recorded set is **shrink-only**. It never forgives new work: new
  unproven changes keep blocking. Resolve debt and shrink the set with
  `gateforge baseline update`.
- Run it **once**. A second `adopt` is a no-op success; there is exactly
  one sanctioned bulk-add per repository.
- Under `--preset strict` / `strictE2E`, an adopted E2E obligation is not
  proof. It blocks with `ENFORCEMENT_UNTRUSTED` again as soon as a change
  touches it — adoption forgives today's state, not the next edit.
- After the adoption commit itself, a commit that carries NO product
  behaviour — tests, the mapping sidecar, runner configuration — still keeps
  the adopted debt forgiven: that is `enforcement.adoptedDebt: lenient`, the
  default. Declare `strict` in `.gateforge.yml` to re-grade it on every
  commit, as 0.10.3 did.
- `gateforge adopt --help` prints this contract, and
  `gateforge baseline diff <before> <after>` compares two adopted sets by
  obligation ID.

Adopting forgives; it does not prove. The work of proving obligations
starts in step 4 and is unchanged.

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

**You should see:** discovered test keys and suggestions with obligation IDs and any mapping problems. Candidates are ranked by the evidence their own row carries, so the strongest match is `#1`; each candidate prints the `why:` lines that produced its rank, the text surface shows the top five, and `gateforge tests suggest --json` returns the full ranked list. With a candidate in hand, the next action is to declare that existing test `observed-e2e` and run it under the witness — the overlay-test instruction appears only when no existing test fits (`new test needed: yes`). After a declaration, `gateforge check` prints `mapped to: <test> (not yet witnessed)` for obligations whose mapping exists but whose evidence has not been collected yet.

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

`--obligation` is repeatable — one mark can declare several claims for one
test (`--obligation '<id-a>' --obligation '<id-b>'`). A second `tests mark` for
the same test ADDS its claims to the existing declaration (it never replaces
them) and prints the full resulting claim list. A repeat that declares a
DIFFERENT `--kind` or a different `--category` set is refused, naming both —
edit the entry's `kind:`/`categories:` in `.gateforge/test-map.yml` yourself to
change a declaration's meaning.

**You should see:** the sidecar diff, or a current annotation in the test. A repeated identical `tests mark` reports no changes.

**If not:** rerun discovery, copy the exact test key and obligation ID, and resolve any mapping contradiction. Do not use a declaration to silence a blocker.

### Frontend page promises

With the React Router reader configured, every detected page adds `page:loads`
and `page:data-ok` promises. Existing tests can prove a route by using
Gateforge's Playwright fixture; after the suite, the referee visits only pages
without a clean test record. Add seeded IDs for dynamic pages and keep the
sweep enabled:

```yaml
pages:
  router: react-router
  audiences:
    - name: tenant
      loginRoute: /login
      guard: ProtectedRoute
  params:
    '/orders/:id': { id: 'seeded-order-id' }
  sweep: true
```

An unbound parameter produces `PAGE_PARAM_UNBOUND` and stays unproven; no
identifier is guessed. `pages.sweep: false` leaves pages no test opens as
unproven. See [Pages in the reference](REFERENCE.md#pages) and
[Connect your project](CONNECT-YOUR-PROJECT.md) for fixture migration and
tamper restrictions.

### Write your rules down

Product statements the owner wants proved — "an invoice can only be
cancelled while it is unpaid" — live in the `rules:` section of
`.gateforge/classification-policy.yml` (`gateforge init --rules` adds a
commented example). Each rule names the test type that must prove it
(`e2e` by default), and each case is mapped like a claim above, with
`gateforge tests mark --rule <ruleId>/<caseId> …`. A mapping alone is a
declaration: the case is satisfied only when its mapped test ran in a
sealed supervised run, passed, and delivered the type's proof. See
[Business rules](REFERENCE.md#business-rules-the-rules-section) in the
REFERENCE for the type table and the honest scope of the proof.

## 6. Prepare a verifier key and the app

Keep the key outside the repository and run-state folder:

```sh
gateforge key create --confirm
```

That is the whole ceremony: with no `--file` the CLI creates the key ring at
`"${XDG_CONFIG_HOME:-$HOME/.config}/gateforge/verifier-keyring.json"` (parent
directory included, owner-only, mode `0600`) and reads that same path on every
later command, so nothing has to be exported. Keep a key ring somewhere else
only on purpose: pass `--file <path>` to the ceremony AND export
`GATEFORGE_WITNESS_VERIFIER_KEY_FILE=<path>` for the runs that must read it —
one source, never both.

The command prints a key ID, not the secret. Set the app URL and any session state the suite needs. The application and test environment must already be running; see [Test environment](TEST-ENVIRONMENT.md).

If the suite reads its own environment variables (a base URL, a test mail
box, a seeded password), the supervised runner forwards ONLY the names
declared in `.gateforge/runtime.yml`'s `envAllowlist` — and that file
counts only when `.gateforge.yml` also declares
`runtime: .gateforge/runtime.yml`. Both blocks together are the recipe in
[Test environment → Declare test-service environment variables](TEST-ENVIRONMENT.md#declare-test-service-environment-variables); a suite whose variables never reach the test process silently falls
back to its own defaults.

**You should see:** `verifier key ring created` and an active key ID.

**If a ring already exists:** the command says so — it names the ring, the active
key ID and `gateforge key rotate --confirm` — and exits `2` without changing
anything. That is not a failure to fix: there is nothing to do while that key is
active.

**If not:** check file permissions, and keep the key file outside `.gateforge/test-gates/` and the repository. `gateforge enforcement doctor` names the ring it resolves (`verifier-key-location`) or the command that creates one.

## 7. Run the supervised tests

```sh
gateforge test-gates --changed
```

Gateforge supervises the full relevant mapped suite and writes an authenticated receipt only after a complete successful run. To run only the tests affected by your change, add `--scope changed` (see [How much runs?](#how-much-runs)).

**Once per machine, install the browsers the runner pins:**

```sh
cd <the directory holding your Playwright config>
npx playwright install chromium
```

On a Linux machine without the browser's system libraries — a container, a CI
image, WSL — use `npx playwright install --with-deps chromium` instead (it
installs them too, and needs root or sudo). `gateforge enforcement doctor`
names whichever case you are in: a missing build names `npx playwright install`,
and a build that is installed but cannot start names the loader's own line and
`npx playwright install-deps chromium`.

**You should see:** the selected tests pass and the run seals a receipt.

**If not:** use the first typed blocker. Check the changed-file base, mapping, app readiness, seed data, and verifier key. A test that fails on an environment variable the raw runner saw — `ECONNREFUSED` on a stale default host, an empty token — is the env recipe: list the name in `.gateforge/runtime.yml` `envAllowlist` AND declare `runtime: .gateforge/runtime.yml` in `.gateforge.yml` (the file without the `.gateforge.yml` block is silently ignored) — [Test environment → Declare test-service environment variables](TEST-ENVIRONMENT.md#declare-test-service-environment-variables). A test declaration or a plain passing test run is not a receipt.

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

The first real `next` on a FastAPI repository asks which data plane owns a
route's records. The three planes:

- **tenant** — the data of one customer or organisation, e.g. a per-customer database or rows scoped by a customer id.
- **master** — the platform's own administrative data, shared by the operator, e.g. the admin platform's database of customers and plans.
- **global** — reference data that is the same for everyone, e.g. currencies.

An infrastructure route that serves no business data (health, readiness, metrics): Gateforge already classifies health and readiness probes as `global` itself. Do not cover a file that holds such probes with a `tenant` or `master` rule — the two answers contradict (`PLANE_CONTRADICTION`). If no route in the folder serves business data (`gateforge explain <endpoint>` shows `linkedResource: <none>`), answer `global` for it; if business routes share one router file with the probes, move the probes to their own router file. A file that is not part of the product: exclude it with `project.paths.exclude` in `.gateforge.yml`.

That is an owner decision, so Gateforge explains the
question before asking it and prints one runnable command per answer. For
`DELETE /items/{}` on tenant-scoped records, the answer is `tenant`:

```sh
gateforge init --planes                                        # once: create the owner-reviewed planes file
gateforge classify plane 'app/main.py' tenant \
  --reason 'Owner review confirms the tenant plane for DELETE /items/{}.' --confirm
```

`classify plane` takes one file, one FOLDER, or one glob — a folder answer
is written as `match: 'app/routes/**'`, so a repository with hundreds of
routers needs one reviewed rule per router directory rather than one per
file:

```sh
gateforge classify plane 'app/routes' tenant \
  --reason 'Every router in this folder serves tenant-scoped records.' --confirm
```

Then run `gateforge next` again: the same block must not reappear. A route
that is genuinely internal is the other answer, and it stays owner-only (an
`internalRules` entry in `.gateforge/classification-policy.yml`).

The second owner question is what removal MEANS. Delete semantics are
proven, never guessed: a model that declares nothing keeps its resource
`unclassified` and blocks with `DELETE_SEMANTICS_UNRESOLVED` (nothing on
it accrues, and `gateforge explain <resource>` names it). You answer with
`hard` (the row is removed) or `archive` (the row stays, with your own
archived state):

```sh
gateforge classify delete 'backend/models' hard \
  --reason 'Rows in this model tree are removed permanently.' --confirm
```

Like `classify plane` it previews without `--confirm`, and it takes one
file, one FOLDER (written as `match: 'backend/models/**'`), or one glob —
one reviewed rule per model tree, not per model. `archive` refuses to run
without the archived field values the run grades removal against:

```sh
gateforge classify delete 'backend/models/invoice' archive \
  --archive-field status=archived --archive-field archived_by=system \
  --reason 'Invoices are archived, never removed.' --confirm
```

Your declaration is an evidence contract, not an override: if a detector
reads the model and disagrees with your rule, the run blocks and names
both instead of picking one. Then run `gateforge next` again.

To verify a specific commit tree (for example, the tip of a pushed ref)
instead of the current worktree or index:

```sh
gateforge check --candidate-commit <full-commit-sha> --require-e2e
```

Add `--changed` to evaluate only that commit's first-parent diff. The command
uses an isolated checkout of the immutable commit tree.

## 8a. Enable behavior cases

Behavior cases are the strongest evidence Gateforge can grade: the ENGINE
drives the request, the app's own state is read back, and the record is
sealed. They are opt-in, and the setup is printed rather than guessed.

`gateforge init` reads the repository and names the behavior packs it
finds — the code that decides a webhook signature, an authorization
outcome, a state transition, or a request schema. A non-interactive run
(an agent, a CI job) enables **nothing** and prints the exact flag for
each pack it found; in a terminal it asks per pack. Either way:

```sh
gateforge init --behavior-packs webhook
```

That writes `.gateforge/behavior.yml` — a scaffold, not approval: one
commented example case per enabled pack — and prints the exact
`behaviorPolicy: .gateforge/behavior.yml` line to add to an existing
`.gateforge.yml`. `--behavior` enables every pack the scan found,
`--behavior-packs webhook,auth` names them yourself, and `--no-behavior`
keeps the run silent. A repository with no behavior pack is byte-identical
to before.

`gateforge next` then prints the whole remaining setup for a route it
found but cannot prove, and every block is finished work rather than a
template:

* the `endpoints:` entry for that exact route, with the case ids, the
  adapter-backed entity the case is graded against, and the recipe the
  repository declares under `fixtures/`;
* the proof test that asks the ENGINE to drive each case;
* the `.gateforge/test-map.yml` entries that map every case to its test;
* the command that runs the gate.

Paste the blocks as printed, run the gate command, and run
`gateforge next` again. `example/webhook` is exactly this flow: a fresh
copy, `gateforge init --behavior-packs webhook`, the printed steps, and a
green `test-gates --changed` + `check --require-e2e`.

When a declaration needs a fact the repository has not declared (an
entity with no reviewed adapter, a recipe that does not say what a
delivery records), `next` prints that fact instead of a block that could
not pass: the case is never printed as if it were provable.

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

The generated GitHub workflow installs the published `@gate-forge/cli` from
the registry. To gate a release that is not on the registry yet (a local
`.tgz` or a directory), declare where CI must install it from and
regenerate:

```sh
GATEFORGE_CI_ENGINE_SOURCE=vendor/gate-forge-cli-0.13.5.tgz \
  gateforge enforce --ci github
```

The workflow then installs that one specifier instead of the registry
release, so the file it must reach has to be committed with the repository.
Unset the variable and rerun the generator for the registry install. The
GitLab template needs no variable: it installs the repository's own declared
`@gate-forge/cli` dependency.

If your repository already had a `.pre-commit-config.yaml`, the wiring
inserts the `gateforge-check` entry as the FIRST item of the `repos:`
list and says so on one line, with the exact way back
(`undo: git restore -- .pre-commit-config.yaml`). Check that line before
you commit — hooks that rewrite files must not run before the gate, or
they invalidate its receipt; `enforcement doctor` reports such hooks as
`hook-mutation` and names those files. (A config with no block-style
`repos:` list — e.g. `repos: []` — is appended as before, with a note
to move the entry to the top yourself.)

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
