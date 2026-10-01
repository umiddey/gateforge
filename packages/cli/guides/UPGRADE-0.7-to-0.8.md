# Upgrade from 0.7 to 0.8

0.8.0 needs no configuration change. Every new option is off until you write it (the one exception, CI progress lines on stderr, is listed below), and a repository with no new keys gates with the same rules. The one step every repository must take is a new witnessed run: a receipt sealed by 0.7.x is not accepted by 0.8.0.

## Upgrade steps

1. Set every direct `@gate-forge/*` dependency to `0.8.0` and update any wrapper script, CI image, or install command that pins an older CLI version:

   ```sh
   npm i -D \
     @gate-forge/cli@0.8.0 \
     @gate-forge/pack-playwright@0.8.0 \
     @gate-forge/pack-http@0.8.0 \
     @gate-forge/pack-fastapi@0.8.0 \
     @gate-forge/pack-sqlalchemy@0.8.0
   ```

   Keep the packs you already use; the list above is an example. The CLI now also installs two new packages as its own dependencies: `@gate-forge/witness` and `@gate-forge/pack-alembic`. Installing from tarballs instead of the registry: install every `.tgz` of the release in one command (`npm i -D ./gate-forge-*.tgz`).

   **If your `package.json` pins Gateforge anywhere else**, change those entries by hand first: every `@gate-forge/*` version in an `overrides` (npm) or `resolutions` (yarn) block, and every alias such as `"@gateforge/pack-playwright": "npm:@gate-forge/pack-playwright@0.7.0"`, must say `0.8.0`. Then run `npm install`. With an override still at `0.7.0`, the `npm i -D` command above stops with `EOVERRIDE` and changes nothing. Example:

   ```json
   "devDependencies": {
     "@gate-forge/cli": "0.8.0",
     "@gateforge/pack-playwright": "npm:@gate-forge/pack-playwright@0.8.0"
   },
   "overrides": {
     "@gate-forge/core": "0.8.0",
     "@gate-forge/pack-playwright": "0.8.0"
   }
   ```

   You do not need to add the two new packages to `overrides`; the CLI brings them at `0.8.0`.

2. Check the setup:

   ```sh
   gateforge enforcement doctor
   ```

   The doctor has a new `run` section (verifier key, the owner-approved policy pin, the runner and its browser builds, interpreter paths, target reachability, host load). It still exits 0; each FAIL line names its fix. `gateforge enforcement doctor --strict-preflight` exits 1 at the first failing precondition.

3. Seal a new run with 0.8.0:

   ```sh
   gateforge test-gates --changed
   ```

   A receipt sealed by 0.7.x is refused by `check --require-e2e` with `EVIDENCE_STALE`: the new engine derives the gate inputs again, so the old run is not this run. This is expected and fail-closed; nothing else needs to change. The owner-approved policy digest does not change with the upgrade, so a protected `GATEFORGE_APPROVED_POLICY_DIGEST` stays valid.

4. Check the same candidate bytes:

   ```sh
   gateforge check --changed --require-e2e
   ```

## What changes for an existing repository

- **CI progress on stderr:** under `CI=true`, `test-gates` now prints a secret-screened progress stream on stderr (start line, one line per finished test, an alive line each quiet minute). Set `run.progress: off` in `.gateforge.yml` to disable that stream. Passing local runs are unchanged; when a local run fails with the stream off, its text report now names up to three failed tests with their first error line and tells you how to stream any remaining failures.
- **Merge-request CI without a base commit:** `--scope changed` and `check --changed` in a merge-request pipeline that provides no base commit now refuse in seconds with exit 2 and the fix, instead of silently using the local staged diff. Pipelines that are not merge requests, a present base commit, an explicit provider and every local run are unchanged.
- **Selection reports:** the in-runner reporter of a changed- or named-scope run prints `GATEFORGE GATE: SELECTION (…; repository verdict not graded here)` instead of a repository verdict it did not grade. Debt the run did not observe is named on its own line, never as `new blocking`.
- **Browser readiness:** the doctor and the run preflight check the browser builds your own `@playwright/test` pins. Missing builds name `npx playwright install <browser>` and the directory to run it in. On Linux, installed Chromium-family executables are also probed with `--version`; a launch failure names its first stderr line and `npx playwright install-deps <browser>` (requires root or sudo). On a fresh Linux container, install both in one step with `npx playwright install --with-deps chromium`.
- **Engine-owned browser readiness:** the doctor and the run preflight also carry a new `engine-browser` line, separate from `runner`. `runner` reports the browser YOUR tests launch; `engine-browser` reports the one the ENGINE drives for every `evidence.ui.action` / `visible.confirm` / `persistence.verify` receipt and every `engine-browser` behavior case — the Chromium `@gate-forge/pack-playwright` pins, which is usually a different release from yours. A FAIL names that release's pinned builds and the exact command to install them: the engine's own `cli.js` by absolute path (not `npx playwright install`, which resolves YOUR release and installs the revision your cache already holds), with `PLAYWRIGHT_SKIP_BROWSER_GC=1` so the install cannot delete your own builds from a shared cache. The line demands a browser only from a repository that opens one — a Playwright runner, or a behavior policy declaring an `engine-browser` case; a pytest or API-only repository reads `engine browser not required`. No config key is added and no existing check id or wording changes.
- **Reports** gain additive fields only (`strictness`, `quarantine`, `run`, `engine` provenance in text reports). Existing JSON keys, cause codes and exit codes are unchanged.
- **Queue observation** needs `bullmq` and `ioredis` only when you configure `queueObserver`; they are optional peers of `@gate-forge/witness`.
- **Declared test-service environment:** names your runtime document already lists in `envAllowlist` now reach the supervised tests and the wired test enumeration; no other variable does, and the values come only from your environment. Engine `GATEFORGE_*` names and process-loader controls (`NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`, `PYTHONPATH`, `PYTHONHOME`, `BASH_ENV`, `ENV`) are refused even when listed, naming the entry. The document is part of the trusted policy digest, so adding a name is an owner approval. No list forwards nothing new, and you do not need to add the key: see `TEST-ENVIRONMENT.md`, "Declare test-service environment variables".
- **A Playwright project that declares `use.storageState` now gets that session.** A supervised run uses a synthesized config, never yours, so until now a `setup` project's saved state was silently omitted and every authenticated journey ran logged out. The declared path is handed to that project alone and must stay inside the repository: containment is checked on the real filesystem from the nearest existing ancestor, so a file your setup test creates during the run is fine, while a path that escapes directly or through a symlink, a dangling link, a URL and an empty value stop the run and name the project, the value and the fix. A relative path resolves against the runner's working directory; the setup project keeps no state of its own; an operator-set `GATEFORGE_SESSION_STATE` still outranks every project declaration, and the declarations it outranks are not read. If you already set that variable, nothing changes for you: see `TEST-ENVIRONMENT.md`, "Or let a setup project save its own state".
- **Reads from a rendered list:** a `read` may name its entities in the response rows instead of the path, with the new `collection: { rowsKey?, idKey }` shape in the new-options table below. The shape is declared, never inferred, and it is opt-in: without it a read binds `{id}` from the path exactly as in 0.7.x. See `CONNECT-YOUR-PROJECT.md`.
- **Declared volatile fields are honored:** an adapter that already declared `volatileFields` had the list accepted and then dropped before the run, so a field the server rewrites failed the exact-value echo as `EVIDENCE_VALUE_MISMATCH`. The declaration now survives admission, so those keys are skipped by the echo and named in the report. An undeclared key still blocks, a malformed list is refused at load, and an adapter that declares nothing is unchanged.

## New options (all off by default)

| Option | Where | Default |
|---|---|---|
| `mode: strict \| changed \| warn` | `.gateforge.yml` | absent = `strict` (0.7 behavior) |
| `gateforge quarantine <testKey> …` | owner command | no quarantine |
| `enforcement.reseal: true`, `enforcement.resealRuntimeFiles` | `.gateforge.yml` | off: a test-only change runs the changed scope as before |
| `enforcement.twinPaths: advisory \| block`, `enforcement.twinQueryKeys` | `.gateforge.yml` | off |
| `http.endpoint.requireObservation` | `.gateforge/policies.yml` | off |
| `run.progress` / `--progress stderr\|file:<path>\|off` | `.gateforge.yml` / flag | `auto`: stderr under `CI=true`, off locally |
| `tenancy.scopeColumns` | `.gateforge.yml` | none |
| `queueObserver` | `.gateforge.yml` | none; `task:*` cases stay fail-closed |
| `.gateforge/runtime.yml` recipe for `gateforge run` | file | none; `gateforge run` works without it |
| `test-gates --test <selector> --result-only`, `--chaos <seed>` | flags | not used |
| `enforce --ci gitlab\|github --witnessed` | command | static CI job only |
| `collection: { rowsKey?, idKey }` on an adapter `read` | evidence adapter | absent: a read binds `{id}` from the path |

## Existing keys that changed meaning

No repository has to write any of them. A key you have not declared behaves
exactly as in 0.7.x; a key you already declared gets the effect below.

| Key | Where | Absent (unchanged) |
|---|---|---|
| `envAllowlist` | `.gateforge/runtime.yml` | no extra variable reaches tests or enumeration |
| `volatileFields` | evidence adapter | no key is exempt from the exact-value echo |

## If something breaks

| If you see | Do this |
|---|---|
| `EVIDENCE_STALE` after upgrading | Run `gateforge test-gates --changed`, then check again. |
| `GATEFORGE_PACKAGE_INCOMPATIBLE` | Align every direct Gateforge package to `0.8.0`, update wrapper pins, then run `npm install`. |
| `npm error code EOVERRIDE` (`Override for @gate-forge/… conflicts with direct dependency`) | Set every `@gate-forge/*` entry in `overrides`/`resolutions` and every `npm:@gate-forge/…` alias to `0.8.0` by hand, then run `npm install` (step 1). |
| `E404` for `@gate-forge/witness` or `@gate-forge/pack-alembic` during a tarball install | Install every tarball of the release in one command. |
| A doctor `runner` FAIL naming browser builds | Run the printed `npx playwright install …` in the printed directory. |
| A doctor `runner` FAIL saying an installed browser cannot start | Run the printed `npx playwright install-deps …` command with root or sudo available, then run the doctor again. |
| A doctor `engine-browser` FAIL naming the engine's pinned builds | Run the printed command verbatim. Do not substitute `npx playwright install` — it installs YOUR Playwright release, not the engine's, and leaves the engine browser just as broken. Keep `PLAYWRIGHT_SKIP_BROWSER_GC=1` in the command so your own cached builds are not garbage-collected. |
| A run stops naming a project, its `storageState` value and the fix | The declared path must stay inside the repository; the file itself need not exist yet, your setup test may create it during the run. Fix the path, not the timing — never point it outside the repository or inline the cookies. |
| Exit 2 on `--scope changed` in a merge-request pipeline | Provide the base commit (for example a deeper clone) or configure the change provider explicitly, as the message says. |
| `runtime envAllowlist cannot grant '…' to test code` | Remove that entry. Engine `GATEFORGE_*` names and process-loader controls are never forwarded to test code, listed or not; the run refuses before any test starts. |
| `observe.read.collection requires method 'GET'`, or `must not be declared on a path carrying '{id}'` | The collection shape belongs on a `read` + `GET` whose path carries no `{id}`. A by-id read keeps its own shape; move the declaration to the read that actually renders the list. |
| `EVIDENCE_VALUE_MISMATCH` on a field the server rewrites on its own | Declare that field in the adapter's `volatileFields`. The declaration is now honored end to end; it is never inferred from the response. |
