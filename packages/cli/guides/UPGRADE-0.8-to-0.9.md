# Upgrade from 0.8 to 0.9

0.9.0 needs no configuration change and adds no option that is on by default. What it changes is what the engine SEES on an existing repository, so the honest first step after upgrading is a fresh `discover` — your counts and your obligations can move in BOTH directions, and that is the point of the release rather than a regression.

## Upgrade steps

1. Set every direct `@gate-forge/*` dependency to `0.9.0` and update any wrapper script, CI image, or install command that pins an older CLI version:

   ```sh
   npm i -D \
     @gate-forge/cli@0.9.0 \
     @gate-forge/pack-playwright@0.9.0 \
     @gate-forge/pack-http@0.9.0 \
     @gate-forge/pack-fastapi@0.9.0 \
     @gate-forge/pack-sqlalchemy@0.9.0
   ```

   Keep the packs you already use; the list above is an example. Installing from tarballs instead of the registry: install every `.tgz` of the release in one command (`npm i -D ./gate-forge-*.tgz`).

   **If your `package.json` pins Gateforge anywhere else**, change those entries by hand first: every `@gate-forge/*` version in an `overrides` (npm) or `resolutions` (yarn) block, and every alias such as `"@gateforge/pack-playwright": "npm:@gate-forge/pack-playwright@0.8.0"`, must say `0.9.0`. Then run `npm install`. With an override still at `0.8.0`, the `npm i -D` command above stops with `EOVERRIDE` and changes nothing.

2. Add Gateforge's own engine state to `.gitignore` (one-time, if an earlier `init` predates this release):

   ```sh
   echo '.gateforge/test-gates/' >> .gitignore
   ```

   `init` now does this itself, appended to your existing file with your lines preserved. Without it the first `git add -A` stages the run catalog and the plugin cache the engine regenerates on every run, and the gate then blocks on its own files.

3. Re-run discovery and read the new picture:

   ```sh
   gateforge discover
   ```

4. Re-approve the policy digest if any Gateforge-owned setup file changed:

   ```sh
   gateforge enforcement doctor   # names the current pin and the value to set
   ```

   Setup files are policy inputs since 0.9.0 (see below). They are inside the approved policy digest exactly as before, so if your repository pins `GATEFORGE_APPROVED_POLICY_DIGEST`, re-approve it once after upgrading. A mismatching pin still blocks — nothing was weakened.

5. Check the same candidate bytes:

   ```sh
   gateforge check --changed
   ```

   Seal one new witnessed run before trusting `check --require-e2e`. A receipt records the engine that sealed it, and 0.9.0 is a different engine from 0.8.x, so a receipt sealed by 0.8.x is refused with `EVIDENCE_STALE` — the same fail-closed rule as every previous upgrade:

   ```sh
   gateforge test-gates --changed
   ```

   The owner-approved policy digest does not change with the upgrade, so a protected `GATEFORGE_APPROVED_POLICY_DIGEST` stays valid (re-approve it only if you changed a Gateforge-owned setup file — step 4).

6. If your repository declares documentation folders whose exclusion was refused for holding data files, re-declare it (this release accepts `.json`, `.yaml`, `.yml`, `.csv`, `.html` inside an excluded folder):

   ```sh
   gateforge init --docs-exclude docs --confirm-doc-exclusions
   ```

## What can appear or disappear, and why

- **Untracked-and-gitignored files leave the scan.** Generated output in a working copy — a Playwright report bundle, a local cache — was walked like committed code, so every call inside it became detector evidence (in the session that motivated this release: 414 `FRONTEND_CALL_TARGET_UNRESOLVED` entries that a clean clone of the same commit never produced). After upgrading, the scan skips exactly what Git reports as untracked AND ignored. If your counts DROP, this is why: a dirty working copy and a clean clone now describe the same repository. A TRACKED file matching an ignore pattern is still scanned, a nested `.gitignore` counts, the operator's global excludes file does not (results must not depend on the machine), and outside a Git work tree nothing is skipped.
- **The receipt identity did not move with the scan.** The input snapshot still hashes a deliberate SUPERSET of what the scan reads, so a gitignored configured input still moves the receipt digest — the conservative direction, and the one `check --out` relies on when it refuses an output path that would hide a declared input. The skip rule only removes bytes from the SCAN, never from the identity, so a digest difference between two runs is never the skip rule hiding something.
- **Test-directory models leave the resource graph.** A table declared in a pytest module to build rows (next to the application's real model) used to enter as a second business resource; the real table then collided with its own fixture and stayed plane-unresolved. Those files are still parsed and still appear in `scannedPaths`, so coverage evidence is unchanged, but they contribute no resource, unresolved entry, signal or duplicate finding. If your blocking count drops here, the duplicate fixture resources are what disappeared.
- **Fewer `PLANE_UNRESOLVED` endpoints, more route-folder questions.** `init --planes` now proposes one question per ROUTE FOLDER as well as per model folder, so the endpoint plane questions that used to require hand-editing `.gateforge/planes.json` are asked once per folder. A linked model's plane may appear as a HINT and is never applied — an `accounts` route can serve master data — and `gateforge classify plane` now accepts a folder or glob, so you can also answer it in one command.
- **`singletonPerTenant` disappears from tables that were never singletons.** The tag is minted only when a declared UNIQUE constraint or UNIQUE INDEX is written over tenancy-scope columns and nothing else. A table tagged in 0.8.x only because its constraint CONTAINED a tenant column (a domain `tenant_id`, say) loses the tag, and its `RESOURCE_SINGLETON_PER_TENANT` advisory goes with it. If your repository's scope column is not one of the recognized defaults, declare `tenancy.scopeColumns` so a genuine singleton is still recognized.
- **Routes appear, or change path.** A constant or annotated FastAPI prefix is now folded (`router: APIRouter = APIRouter(prefix="/api/v1")` used to be ignored), so routes behind it appear at their real path instead of the router's own prefix. A prefix that is genuinely computed (an f-string, an attribute, a call) now blocks with `FASTAPI_PREFIX_UNRESOLVED` instead of publishing a prefix-less path no app serves.
- **New blocking codes for factory-built routers.** `FASTAPI_ROUTER_UNMOUNTED` names a router no scanned app mounts (its routes keep their standalone emission and the entry names the router, its file and every declared route). `HTTP_METHOD_DYNAMIC` replaces a fabricated `GET` when a `fetch` method cannot be resolved from its options object. Both can only ADD blocking findings, and both are the honest answer where 0.8.x either guessed or stayed silent.
- **`api.<verb>()` stops minting routes in client and test files.** A call like `api.get('/orders')` counted as a server route wherever it appeared, including in an axios module, a Playwright request context and test call sites. It counts only in a file that imports a server framework (express/fastify/hono), so routes that were phantom entries disappear.
- **Endpoint locations are the server route.** An endpoint reported at a frontend call site that merely mentions the path is now reported at the route that serves it.
- **An unmatched by-id route is now named instead of staying silent — and it does not block unless you say so.** `ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED` is a new entry. A route that reads ONE entity, whose path-derived resource name matches no discovered business resource (`GET /api/v1/reports/logs/{}` while the tables are `report_logs`, `access_logs`), used to produce NO finding at all — which read as "this route does not exist". It now names the endpoint, the derived name and up to three discovered resources whose last `_`-segment could be the same thing. Those names are CANDIDATES and are never linked: a link still requires an exact name plus a schema or handler-name corroboration. **After upgrading, these are ADVISORIES**: `check` and `next` print a banner at the top with the count, the first three examples and the exact key, and nothing blocks on them — a repository that never chose must not start failing commits over a finding it did not ask for. To gate on them, set `endpoints:\n  unmatchedRoutes: block` in `.gateforge.yml` (or run `gateforge init --unmatched-routes block` on a new setup); `unmatchedRoutes: warn` keeps the banner and states that you chose it.
- **Gateforge's own setup files are policy inputs.** The config, policy, classification, behavior and runtime documents, the exclusion declarations, the mapping sidecar, the adapter/waiver/baseline/quarantine records, the generated gate wiring and your CI/pre-commit config *while they still carry Gateforge's managed block* are never an unmapped `CHANGE_UNMAPPED` change, and a change set containing only those files cannot change product behavior. Your `init` → `adopt` → first commit therefore passes without `--no-verify`, and a setup commit no longer drags every adopted E2E obligation into a strict re-grade — provided the owner has pinned the policy revision that governs those files. **Removing** the gate job from your CI config, or the entry from `.pre-commit-config.yaml`, is not a policy input and goes back to blocking, exactly as before.
- **Adopted debt survives a setup commit under `strictE2E`.** The adopted baseline is a recorded, shrink-only statement of pre-existing debt, not a risk acceptance, so it is not re-graded as blocking while the change set is provably product-behavior-neutral. With no policy pin in force, reporting is unchanged and adopted debt is re-graded as blocking.
- **Suggestions are ranked and capped.** `tests suggest` used to list candidates alphabetically; the obvious test could sit at #159 of 311. Candidates are now scored by the evidence their own catalog row carries and every weight is printed as a `why:` line, so a changed ranking is the ranking being honest — not a lost candidate. The text surface prints the top five; `gateforge tests suggest --json` carries every candidate.
- **`tests suggest --json` reports FEWER overlaps — a deliberate JSON contract narrowing.** `candidates[].overlaps` used to list every obligation that merely had the test among its candidates (237,936 entries on the repository that motivated this release). It now lists only the obligations that DECLARE the test, which is what an overlap means. **If you consume `candidates[].overlaps`, re-check it against 0.9.0**: the field is narrower, not merely re-ordered.
- **`check` shows declared mappings.** An obligation whose test ids are declared but whose records were not consulted now reports `mapped to: <test> (not yet witnessed)`, and in the TEXT report its next action names the command that collects the evidence instead of the generic "write a test" advice. `--format json` keeps the cause's own generic next action and carries `declaredTests` and `mappingState` instead.
- **Test rows are attributed to the runner that owns them.** The static scan found test-shaped calls anywhere in the repository and catalogued them as the configured runner's tests. Each runner's own file selection is now read as data (Playwright project `testDir`/`testMatch`/`testIgnore`, Vitest `test.include`/`test.exclude`/`test.globals`), so rows can MOVE between runners or disappear. Ownership is never invented: a file no runner's selection claims keeps the configured runner and stays a blocking row.
- **A collection read no longer stops proving at 16 KB.** A `persistence:read` whose observe binding declares `collection` used to parse the first 16,384 bytes of the response the proxy forwarded, so a list that outgrew that cap named no complete row: the claim stayed `EVIDENCE_NOT_COLLECTED`, no receipt sealed, and the failure grew every run as the app's own data grew (in the session that motivated this release, a users list at 18,526 bytes / 107 rows). Such a read is now parsed from its own bounded copy — up to 1 MiB and up to 10,000 rows — so an ordinary growing list proves again. Nothing else moved: the 16 KB tap that feeds the response digest and create attribution is byte-identical, the record payload is unchanged (no body byte ever rode in it), and every existing record and receipt re-verifies. A body or page past the new bounds is still refused, not partially read, and the note names the bound and the size.

## Owner decisions this release asks for

- **One plane answer per route folder.** `init` asks; nothing is inferred. Answer for the ROUTES, not for the models they happen to link to. `gateforge classify plane <folder> <plane> --reason "<why>" --confirm` does the same thing outside a terminal.
- **Documentation folders are an owner assertion.** Accepting `.json`/`.yaml`/`.yml`/`.csv`/`.html` inside an excluded folder still cannot prove that such a file cannot affect application or test behavior; manifests, lockfiles, `*.config.*` files, CI configs and every source or executable format stay refused, and MDX/WASM/SVG fail closed. Declare a folder only when you mean it.
- **The policy pin is what makes a setup commit pass.** If you pin `GATEFORGE_APPROVED_POLICY_DIGEST`, re-approve it once after upgrading so your own setup files are the ones your pin describes.

## If something breaks

| If you see | Do this |
|---|---|
| `GATEFORGE_PACKAGE_INCOMPATIBLE` | Align every direct Gateforge package to `0.9.0`, update wrapper pins, then run `npm install`. |
| `EVIDENCE_STALE` after upgrading | Run `gateforge test-gates --changed`, then check again. A receipt names the engine that sealed it, and 0.9.0 is a new engine. |
| `npm error code EOVERRIDE` (`Override for @gate-forge/… conflicts with direct dependency`) | Set every `@gate-forge/*` entry in `overrides`/`resolutions` and every `npm:@gate-forge/…` alias to `0.9.0` by hand, then run `npm install` (step 1). |
| Blocking count dropped a lot right after upgrading | That is the gitignore and test-directory rules working. Compare against a CLEAN CLONE of the same commit before investigating: the two now agree. |
| `FASTAPI_PREFIX_UNRESOLVED` | Make the prefix a literal at the mount site. An f-string, an attribute or a call cannot be proven statically, and Gateforge will not guess a path. |
| `FASTAPI_ROUTER_UNMOUNTED` | Mount the router (`app.include_router(...)`) or delete it. Nothing in the scanned set serves those routes today. |
| `HTTP_METHOD_DYNAMIC` | The method comes from a wrapped request-options object Gateforge cannot resolve statically. Resolve the constant in the file or accept the finding; the previous `GET` default was never evidence. |
| `ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED` | The route exists; Gateforge could not tie it to a business resource by name, and it says so instead of staying silent. The listed names are candidates, never links: give the route a response or handler name that carries the resource (or declare the mapping) if one of them is right. With no `endpoints.unmatchedRoutes` key it is an advisory; add `block` to that key to make it gate commits. |
| `CHANGE_UNMAPPED` on a file you believe is yours | Run `gateforge explain <path>`: it prints what the file is and what governs it (Gateforge policy input, declared gate input, owner-declared documentation folder, known source of a resource, or an unclassified change) and the steps that attribute it. |
| `ENFORCEMENT_UNTRUSTED` on a setup-only commit | Pin (re-approve) the policy digest so the change set is provably product-behavior-neutral. Never reach for `--no-verify`. |
| A `persistence:read` noted "above the 1048576-byte witness collection-read bound" or "above the 10000-row witness collection-read bound" | The list route serves more than the engine will read in one response. Declare paging on the adapter and prefer a by-id observe read for the claim; a bigger bound would only postpone this. |

## 0.9.1: what a 0.9.0 user notices

Three behavior changes, all refusals that replace a silent or misleading outcome:

- `gateforge init` exits 2 on a preset/flag contradiction (the preset used to be silently dropped) and on a requested setting that differs from an existing `.gateforge.yml` value — `init` never rewrites an existing config, so set the key yourself.
- `gateforge adopt` exits 2 while any blocking entry is plane-unresolved, naming the folders and the exact `gateforge classify plane <folder> <tenant|master|global> --confirm` answer: a plane answer changes resource identity, so debt adopted before the answer would not match the repository after it.
- `gateforge enforcement doctor` prints the full 64-hex trusted policy digest instead of a 12-hex prefix, and when the approved digest is absent or mismatched it adds an `owner: pin this revision with GATEFORGE_APPROVED_POLICY_DIGEST=...` action line.