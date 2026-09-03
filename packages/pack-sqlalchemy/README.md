# @gateforge/pack-sqlalchemy

SQLAlchemy CRUD discovery pack: a Python detector that finds SQLAlchemy
tables from Python source **using only the stdlib `ast` module** — no
imports, no execution of application code, no SQLAlchemy dependency —
plus a TypeScript discover entry, configurable tenant/master plane
mapping, and the entity-adapter schema with a sample adapter for the
`example/` accounts app.

The detector speaks the resource graph's frozen vocabulary: business
`sqlalchemy.table` resources, `gateforge.class` symbol resources for
cross-module inheritance resolution, typed `unresolved` entries for
computed names (never a guess, never a silent drop — ADR 0001 D1), and
`DUPLICATE_TABLE_NAME` / `CLASS_NAME_REPEATED_IN_FILE` / `PARSE_ERROR`
findings (GF-20/GF-01/GF-19).

## How discovery works

`python/gateforge_sqlalchemy_detector/` parses each repo-relative path
with `ast.parse` and reports:

| Source construct | Emitted as |
| --- | --- |
| Declarative class with literal `__tablename__` (legacy `declarative_base()` and 2.0 `DeclarativeBase` styles) | `sqlalchemy.table` resource + class symbol |
| Direct `Table("name", ...)` call | `sqlalchemy.table` resource (provenance `table-call-first-arg`) |
| Abstract base (`__abstract__ = True`) or `DeclarativeBase` subclass with no table facts | class symbol only (`abstract: true` / base); never a business resource |
| Class whose tablename is a decorated function, f-string, call, name ref, or SQLModel `table=True` | class symbol with `tablenameUnresolved: true` + typed `unresolved` entry |
| Class with bases but no literal tablename anywhere | class symbol + `no_tablename_source` unresolved entry (the graph resolves through its repo-wide symbol table when a base carries a literal — same-file AND cross-file) |
| Plain classes (mixins, no bases, no table facts) | nothing |
| Malformed Python file | `PARSE_ERROR` finding with a line number; the file contributes no resources (GF-19) |

### Detector vocabulary

- **Business table resource** — `kind: "sqlalchemy.table"`, identity in
  `attributes.resourceName`, plus `classQname`, `scope`, `tableName`,
  `tablenameProvenance` (`literal` | `table-call-first-arg`),
  `hasTableArgs`/`tableArgsSchema` (literal `schema` from
  `__table_args__`), `tableKeywordTrue`, `abstract`, `baseNames`.
- **Class-symbol resource** — `kind: "gateforge.class"` with the graph's
  canonical `qname` (dotted scope-qualified — function-local shadowing
  never collapses), `resourceKind`, `baseNames`, `tableName`, `abstract`,
  `tablenameUnresolved`.
- **Unresolved entries** — `{code, detail, location}` at the class
  statement; codes: `computed_tablename` (decorator count + return
  expression kind retained in full, GF-02), `table_name_derived_runtime`
  (`table=True`), `no_tablename_source`. The graph retires an entry it
  resolves and synthesizes `inherited_tablename_unresolved` when it
  cannot.
- **Findings** — `DUPLICATE_TABLE_NAME` (2-file and 1-file variants,
  GF-20), `CLASS_NAME_REPEATED_IN_FILE` (GF-01 non-collapse proof),
  `PARSE_ERROR` (GF-19).

## Setup

Requires Python ≥ 3.11 (the detector and the GPP/3 client are
stdlib-only; no pip install is required in the monorepo — the client
bootstraps itself from `packages/plugin-protocol/python`).

Both transports run the **same** detector; pick one per project:

### Subprocess transport (GPP/3)

```yaml
# .gateforge.yml
plugins:
  - id: gateforge.pack-sqlalchemy
    version: 0.1.0
    transport: subprocess
    command: ['python3', '-m', 'gateforge_sqlalchemy_detector']
```

The command must resolve as a Python module, so the pack's `python/`
directory (and the plugin-protocol client) need to be on `PYTHONPATH`,
e.g. in your shell/environment:

```sh
export PYTHONPATH="$PWD/packages/pack-sqlalchemy/python:$PWD/packages/plugin-protocol/python"
```

(When only the pack's `python/` dir is on the path, `__main__.py`
bootstraps the sibling client from the monorepo layout automatically.)
The CLI spawns the plugin with the repo root as its working directory
and passes repo-root-relative paths; the `version` must match the pack
(`0.1.0`) — it is pinned at the GPP/3 handshake.

### In-process transport

```yaml
# .gateforge.yml
plugins:
  - id: gateforge.pack-sqlalchemy
    version: 0.1.0
    transport: in-process
    module: '@gateforge/pack-sqlalchemy'
```

The pack's default export is the pinned `{ discover(paths) }` contract.
Internally it spawns the exact same python detector through the hardened
`PluginSession` host (GPP/3), with the `PYTHONPATH` computed from the
package's own location — zero environment setup. Requires a build of the
workspace first (`npm run build`) so the package exports resolve to
`dist/`.

Both entries emit byte-identical discovery output for the same repo
state — `test/in-process.test.ts` asserts this.

## Plane and resource classification

The detector emits normalized facts and classification signals. It does not
read a per-resource classification file or attach project-configured business
meaning. The core classifier combines plane, identity, lifecycle, delete
semantics, exposure, and adapter signals with `.gateforge/classification-policy.yml`.

```yaml
# .gateforge/classification-policy.yml
schemaVersion: 1
scanRoots: ['backend/**/*.py']
trustedInternalEntryPoints: []
internalRules: []
declarations:
  internality: gateforge:internal
volatileFields: []
```

Use `gateforge discover`, then `gateforge classify` and
`gateforge explain tenant.accounts` to inspect the effective decision and its
fingerprint. Unknown plane or identity is a typed blocking result; uncertainty
never silently suppresses obligations. `NO_PLANE_MAPPING` remains available for
tests that intentionally disable programmatic plane attribution.

## Classification workflow (example app)

1. **Discover** — the detector finds `accounts` and emits normalized
   resource facts plus classification signals.
2. **Classify** — the core classifier applies the repository-wide policy,
   conservative defaults, and closed-world proofs. No resource entry is
   hand-authored.
3. **Gate** — matching `user-facing` resources receive lifecycle-gated
   `persistence:*` obligations. Missing identity, plane, delete semantics, or
   adapter evidence produces a typed blocking result.
4. **Observe** — `gateforge discover --json`, `gateforge classify`,
   `gateforge obligations --json`, and `gateforge check` trace detector →
   classification → obligation → report. UI-semantic `crud:*` contracts
   remain fail-closed until trusted UI observation exists.

## Entity adapter schema + sample

The evidence-witness adapter contract (interface pin #8): an adapter is
a reviewed, engine-side module at `.gateforge/adapters/<resourceId>.mjs`
whose default export is:

```ts
{
  resourceId: string,              // registry identity (matches the file name)
  read(ctx: { baseUrl, headers? }, id): Promise<unknown>,  // GET-only
  normalize(body): { entityId, fields },
  deletion: 'hard' | 'archive',
  environmentFingerprint: string,  // target marker the witness probes (GF-13)
}
```

The pack exports `EntityAdapterSchema` + `validateEntityAdapter`
(`src/adapter-schema.ts`) for fail-closed validation. Adapters execute
**engine-side** (witness service), their responses never reach the test
process, and a fingerprint mismatch rejects the record — never
`satisfied`.

**Sample** — `examples/example.accounts.adapter.mjs` implements the
`example.accounts` resource against the example app's read API:
`read` does `GET {baseUrl}/api/accounts/:id` (404 → `null`),
`normalize` projects `{entityId, fields:{id, status}}`, `deletion` is
`'archive'` (the app archives, never hard-deletes), and
`environmentFingerprint` is the `x-gateforge-env` marker the witness
expects on probe/read responses. Copy it to
`.gateforge/adapters/example.accounts.mjs` in a project that runs the
example app, and set the classifier's `evidenceAdapter: example.accounts`.
(Note: the graph's final resource id is the plane-qualified
`master.accounts`; the adapter's registry identity is the
company-resource name `example.accounts` per the witness registry
convention.)

## Adversarial coverage (GF fixtures)

| Case | Behaviour asserted in `test/` |
| --- | --- |
| GF-01 | Function-local `Row` × 4 → 4 distinct stable IDs, `CLASS_NAME_REPEATED_IN_FILE` finding, no collapse |
| GF-02 | 3 stacked decorators + default-valued calls → full reason (`3 decorator(s)`, return-expression kind), no truncation |
| GF-19 | Malformed file → `PARSE_ERROR` finding with line 6, no resources, no crash |
| GF-20 | `dupes` × 2 in one file + `shared_items` across two files → both `DUPLICATE_TABLE_NAME` variants, 3 distinct resources |
| GF-21 | declared_attr / f-string / call / name / `table=True` → typed unresolved entries, never absent |
| — | Cross-module inheritance resolved through the graph symbol table; genuinely computed chains stay typed-unresolved |

## Determinism

Same input paths + same file bytes → byte-identical discovery output
(plan invariant 7): stdlib-only, no clock/network/randomness, every
array sorted, every name a literal from the AST, fixed key order on the
wire. `test/subprocess.test.ts` asserts byte-identity across fresh
GPP/3 sessions. The default in-process entry reads the project config at
discover time, so identical repo state yields identical output.

## Development

```sh
npm test                    # from this dir (vitest; spawns python3)
npm run typecheck
npm run build               # tsc → dist/
python3 -m gateforge_sqlalchemy_detector <root>   # ad-hoc serve (needs PYTHONPATH)
```

Layout: `python/gateforge_sqlalchemy_detector/` (detector + serve entry),
`src/` (TS discover entry, plane mapping, adapter schema), `test/`
(fixtures + vitest suites), `examples/` (sample adapter),
`pyproject.toml` (pip-installable detector package).