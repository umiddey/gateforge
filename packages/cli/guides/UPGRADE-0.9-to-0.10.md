# Upgrade from 0.9 to 0.10

0.10.0 has one configuration change: the two evidence-exclusion declarations
`.gateforge/docs-exclusions.yml` and `.gateforge/cache-exclusions.yml` are gone,
and their lists now live in `.gateforge.yml` under `evidence.exclude.docs` and
`evidence.exclude.cache`. One owner file instead of three, and no other
behavior moves.

**Nothing is read twice.** While either old file is present, every command
refuses with a message naming the file and `gateforge migrate`. Reading past it
would silently drop your exclusions, and a silently dropped exclusion changes
what evidence identity means — so the cutover is loud.

## Upgrade steps

1. Set every direct `@gate-forge/*` dependency to `0.10.0` (and every
   `overrides`/`resolutions` entry and `npm:@gate-forge/…` alias), then
   `npm install`.

2. Migrate the declarations, if you have any:

   ```sh
   gateforge migrate
   ```

   This is a preview: it prints the exact diff of `.gateforge.yml` and the
   files it would delete, writes nothing, and exits 0. Read it. Then write it:

   ```sh
   gateforge migrate --confirm
   ```

   The command validates both old files with the same rules the loaders used,
   splices one `evidence.exclude` block into your `.gateforge.yml` **as text**
   (your comments, key order and quoting stay byte for byte), deletes the old
   files, and prints the re-pin reminder. It is idempotent: a repository with
   nothing to migrate prints `nothing to migrate` and exits 0, so re-running
   after a partial adoption is free.

   A repository that declares no exclusions needs no migration at all — leave
   `.gateforge.yml` alone.

   If your `.gateforge.yml` already declares `evidence:` in a form the command
   cannot extend safely (an inline `evidence: {...}`, a `docs:` list written in
   flow style), it refuses by name and changes nothing. Add the block by hand:

   ```yaml
   evidence:
     exclude:
       docs:
         - docs
       cache:
         - backend/__pycache__/account.cpython-312.pyc
   ```

   ...or delete your hand-written `evidence:` block and re-run `migrate
   --confirm`, which will write it for you.

3. Re-approve the policy digest. Migration changed `.gateforge.yml`, which is
   a trusted policy input:

   ```sh
   git add -A .gateforge .gateforge.yml
   gateforge enforcement pin --pin-file ~/.config/<repo>.gateforge.env --confirm
   ```

   The command digests the STAGED bytes — the ones the commit gate digests —
   and writes exactly the `GATEFORGE_APPROVED_POLICY_DIGEST=<hex>` line into
   that env file, mode `0600`, leaving every other line alone. Without
   `--confirm` it only prints the line. The env file must stay OUTSIDE the
   repository, exactly like the protected variable it replaces; a path inside
   the repository is refused, and so is a policy input that is not fully
   staged (it names the file). Export the file for your shell or CI as before —
   `GATEFORGE_TRUSTED_CONFIG`, a protected CI variable, or the file itself.
   **Without a matching pin, a repository that uses exclusions still refuses to
   use them** — the guarantee did not weaken.

   To see WHAT moved instead of reading a digest: `gateforge enforcement doctor`
   lists the inputs whose staged bytes differ from HEAD (`policy-inputs-vs-HEAD`)
   and whether your provisioned pin still matches them (`approved-digest`).

4. Commit the setup change on its own:

   ```sh
   git add .gateforge .gateforge.yml && git commit -m "chore: evidence exclusions in .gateforge.yml"
   ```

5. Check the same bytes you did before:

   ```sh
   gateforge check --changed
   gateforge test-gates --changed   # seal one receipt under the new engine
   ```

## What can appear or disappear, and why

- **The exclusion lists themselves do not change.** `loadDocsExclusions` and
  `loadCacheExclusions` return exactly the lists you had before the migration.
  Every refusal is unchanged too: an excluded folder still may not contain a
  configured input, source, manifest, lockfile, `*.config.*` file, CI config or
  symlink, and still may only hold the documented, data and static-raster
  formats; a bytecode exclusion still must be an exact `.pyc`/`.pyo` directly
  under `__pycache__`.
- **The policy digest changes once.** The declarations are no longer separate
  digest entries; their bytes are inside `.gateforge.yml`, which the digest
  already hashed. The bytes your approval pins are the same bytes, so nothing
  is newly unprotected — the value just has to be re-approved once because the
  file that carries it changed.
- **The input snapshot changes once, in the same way.** The two files are no
  longer extra explicit inputs, for the same reason.
- **`init` writes into `.gateforge.yml`.** `--docs-exclude` / `--cache-exclude`
  (and the `--confirm-…` flags) now splice into your config instead of writing
  a separate document, so a second `init` on the same repository is still a
  no-op and an owner-confirmed change still prints `updated:`.

## Owner decisions this release asks for

- **One file to review.** When you review a policy change, the exclusions are
  now in the file you were reading anyway. `evidence.exclude` is deliberately
  not named after `project.paths.exclude`: that key is scan scope (what the
  detector reads), this one is evidence identity (what the gate stops
  binding). Both are yours; they mean different things.
- **The declaration is still an assertion, not proof.** Nothing here proves
  that an excluded file cannot affect application or test behavior. Reports
  keep printing the exact folders/files, the pin status, and the reduced
  guarantee.

## If something breaks

| If you see | Do this |
|---|---|
| `found .gateforge/docs-exclusions.yml: since 0.10 evidence exclusions live in .gateforge.yml under evidence.exclude — run \`gateforge migrate\`` | You have not migrated yet. Run `gateforge migrate`, read the preview, then `gateforge migrate --confirm`. |
| `found .gateforge/cache-exclusions.yml: …` | Same, for the bytecode list. |
| `.gateforge.yml declares docs inline as \`docs: […]\` — this command only writes docs as a list` | Your config writes that list in flow style. Reformat it as a block list (`docs:` then `  - path`), or edit the block by hand. |
| `.gateforge.yml declares evidence inline; this command only appends to an \`evidence:\` block` | Same for an inline `evidence:` or `exclude:` mapping. Make them block mappings, or add the block by hand. |
| `ENFORCEMENT_UNTRUSTED` / `approvalStatus: mismatch` after migrating | Expected once: `.gateforge.yml` is a policy input. Re-approve the digest (step 3). |
| `invalid gateforge config … Unrecognized key: "evidence"` | The CLI is older than the `.gateforge.yml` you migrated. Upgrade every `@gate-forge/*` package to `0.10.0` together. |
