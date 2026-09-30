# Upgrade from 0.6 to 0.7

## Upgrade steps

1. Set every direct `@gate-forge/*` dependency to `0.7.1`. Update any wrapper script, CI image, or install command that pins an older CLI version. The CLI checks the supervised Playwright contract; an incompatible package set exits 2 with `GATEFORGE_PACKAGE_INCOMPATIBLE`.

   Example package set:

   ```sh
   npm i -D \
     @gate-forge/cli@0.7.1 \
     @gate-forge/pack-playwright@0.7.1 \
     @gate-forge/pack-http@0.7.1 \
     @gate-forge/pack-fastapi@0.7.1 \
     @gate-forge/pack-sqlalchemy@0.7.1
   ```

2. Install the updated lockfile:

   ```sh
   npm install
   ```

3. Keep the verifier key in a protected environment variable or an external key ring. For example, create a current-user-owned key ring outside the repository and state directory:

   ```sh
   gateforge key create --confirm
   ```

   With no `--file` the CLI creates the ring at `"${XDG_CONFIG_HOME:-$HOME/.config}/gateforge/verifier-keyring.json"` (owner-only, mode `0600`) and reads that path on every later command; keep `--file <path>` plus a `GATEFORGE_WITNESS_VERIFIER_KEY_FILE` export only when the ring really lives elsewhere.

4. Run the suite under Gateforge after upgrading:

   ```sh
   gateforge test-gates --changed
   ```

   This supervised run records the current claim inventory in its authenticated receipt. A leftover `claims.json` is not a declaration source. Keep annotation-only claims in `.gateforge/test-map.yml` when hooks or CI must see them before a suite runs.

5. Check the same candidate bytes:

   ```sh
   gateforge check --changed --require-e2e
   ```

   If you edit an input after the witnessed run, run the suite again before checking.

## Behavior changes in 0.7.0

- **Claim inventory:** `check` no longer trusts a leftover `claims.json`. Annotations are collected for the current supervised run and authenticated in its receipt. A tracked `.gateforge/test-map.yml` makes claims available to a static check without running or listing the suite.
- **External key ring:** `gateforge key create`, `import-env`, `rotate`, and `retire` manage keys outside the repository. The key file must be a regular file owned by the current user, mode `0600` or stricter, and outside run state. CI may instead provide the protected key environment variable.
- **Documentation exclusions:** Input hashing includes files by default. An explicit docs-only exclusion is written to `.gateforge/docs-exclusions.yml` and stays inactive until its policy digest is approved in protected CI settings. For example, `gateforge init --docs-exclude docs,handbook` selects folders; review the generated policy before enabling it.
- **Result-only runs:** `gateforge test-gates --changed --scope changed --result-only` reports a changed slice and repository debt but has no gate authority and does not create, replace, or clear a receipt.
- **External-witness result-only:** The same result-only mode accepts `--witness-url`, `--out`, and `--run-token`. Use a dedicated state directory separate from `.gateforge/test-gates`; an external-witness result does not become an authoritative receipt.
- **Surface diagnostic:** `gateforge tests surface-doctor` lists Playwright tests that need a UI surface descriptor.
- **Runner context:** The supervised Playwright runner passes the configured app base URL and `GATEFORGE_SESSION_STATE` as trusted `baseURL` and `storageState` settings.

## If something breaks

| If you see | Do this |
|---|---|
| `GATEFORGE_PACKAGE_INCOMPATIBLE` | Align direct Gateforge packages to `0.7.1`, update wrapper pins, then run `npm install`. |
| `EVIDENCE_STALE` or `RUN_INCOMPLETE` | Run `gateforge test-gates --changed` on the exact candidate, then check again. |
| A missing or stale test mapping | Run `gateforge tests discover`, then inspect `gateforge tests suggest`; declare a valid existing test in `.gateforge/test-map.yml`. |
| Tests are missing a UI surface | Run `gateforge tests surface-doctor` and add the required descriptor. |
