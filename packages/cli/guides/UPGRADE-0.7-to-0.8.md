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

- **CI progress on stderr:** under `CI=true`, `test-gates` now prints a secret-free progress stream on stderr (start line, one line per finished test, an alive line each quiet minute). Local runs are unchanged. Set `run.progress: off` in `.gateforge.yml` to keep the 0.7 CI output.
- **Merge-request CI without a base commit:** `--scope changed` and `check --changed` in a merge-request pipeline that provides no base commit now refuse in seconds with exit 2 and the fix, instead of silently using the local staged diff. Pipelines that are not merge requests, a present base commit, an explicit provider and every local run are unchanged.
- **Selection reports:** the in-runner reporter of a changed- or named-scope run prints `GATEFORGE GATE: SELECTION (…; repository verdict not graded here)` instead of a repository verdict it did not grade. Debt the run did not observe is named on its own line, never as `new blocking`.
- **Browser builds:** the doctor and the run preflight check the browser builds your own `@playwright/test` pins. A FAIL there names `npx playwright install <browser>` and the directory to run it in.
- **Reports** gain additive fields only (`strictness`, `quarantine`, `run`, `engine` provenance in text reports). Existing JSON keys, cause codes and exit codes are unchanged.
- **Queue observation** needs `bullmq` and `ioredis` only when you configure `queueObserver`; they are optional peers of `@gate-forge/witness`.

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

## If something breaks

| If you see | Do this |
|---|---|
| `EVIDENCE_STALE` after upgrading | Run `gateforge test-gates --changed`, then check again. |
| `GATEFORGE_PACKAGE_INCOMPATIBLE` | Align every direct Gateforge package to `0.8.0`, update wrapper pins, then run `npm install`. |
| `npm error code EOVERRIDE` (`Override for @gate-forge/… conflicts with direct dependency`) | Set every `@gate-forge/*` entry in `overrides`/`resolutions` and every `npm:@gate-forge/…` alias to `0.8.0` by hand, then run `npm install` (step 1). |
| `E404` for `@gate-forge/witness` or `@gate-forge/pack-alembic` during a tarball install | Install every tarball of the release in one command. |
| A doctor `runner` FAIL naming browser builds | Run the printed `npx playwright install …` in the printed directory. |
| Exit 2 on `--scope changed` in a merge-request pipeline | Provide the base commit (for example a deeper clone) or configure the change provider explicitly, as the message says. |
