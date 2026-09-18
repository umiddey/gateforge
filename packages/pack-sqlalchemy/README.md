# @gate-forge/pack-sqlalchemy

SQLAlchemy CRUD discovery pack: a Python detector that finds SQLAlchemy
tables from Python source **using only the stdlib `ast` module** — no
imports, no execution of application code, no SQLAlchemy dependency —
plus a TypeScript discover entry, the declarative `.gateforge/planes.json`
plane-evidence config (tenant/master/global), and the entity-adapter
schema with a sample adapter for the `example/` accounts app.

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
- **Findings** — `DUPLICATE_TABLE_NAME` (GF-20, **base-qualified**:
  a same-name group is flagged unless every pair provably sits on a
  different declarative Base root — separate `MetaData` at runtime — so
  a test-file fixture Base or an intentional tenant/master model split
  never blocks the gate; roots resolve through local alias chains and
  imports into scanned files, and unprovable evidence — unresolved
  bases, plain `Table()` calls — stays flagged, fail closed),
  `CLASS_NAME_REPEATED_IN_FILE` (GF-01 non-collapse proof),
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
    version: 0.2.0
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
(`0.2.0`) — it is pinned at the GPP/3 handshake.

### In-process transport

```yaml
# .gateforge.yml
plugins:
  - id: gateforge.pack-sqlalchemy
    version: 0.2.0
    transport: in-process
    module: '@gate-forge/pack-sqlalchemy'
```

The pack's default export is the pinned `{ discover(paths) }` contract.
Internally it spawns the exact same python detector through the hardened
`PluginSession` host (GPP/3), with the `PYTHONPATH` computed from the
package's own location — zero environment setup. Requires a build of the
workspace first (`npm run build`) so the package exports resolve to
`dist/`.

Both entries emit byte-identical discovery output for the same repo
state — `test/in-process.test.ts` asserts this.

## Plane evidence config (`.gateforge/planes.json`)

Every business resource must carry plane evidence — `tenant`, `master`,
or `global` — before the classifier will decide anything about it; a
table with no plane is a typed `PLANE_UNRESOLVED` blocker. This pack is
where that evidence comes from: a declarative, **human-reviewed** JSON
config at the repo root. It feeds the same `attributes.plane` mechanism
as the programmatic factory option, so graph ids qualify as
`plane.name` (e.g. `master.accounts`) exactly as before.

```json
{
  "rules": [
    {
      "match": "backend/admin_platform/models/**",
      "plane": "master",
      "reason": "AdminBase control-plane models (master database)"
    },
    {
      "tables": ["master_users", "erp_client_configs"],
      "plane": "master",
      "reason": "platform control-plane tables"
    },
    {
      "match": "backend/models/**",
      "plane": "tenant",
      "reason": "per-tenant database models"
    },
    {
      "match": "backend/api/v1/**",
      "exclude": ["backend/api/v1/public_payment.py", "backend/api/v1/master_admin.py"],
      "plane": "tenant",
      "reason": "contractor-scoped routers except the global-ingress files"
    },
    {
      "match": "backend/api/v1/public_payment.py",
      "plane": "global",
      "reason": "public payment ingress is plane-global"
    }
  ]
}
```

This example is deliberate: `master_users` and `erp_client_configs`
also live under `backend/models/`, so the catch-all glob matches them
too — the explicit `tables` rule wins for them (see evaluation
semantics below), and the glob covers only the tables it alone claims.
Likewise `backend/api/v1/` mixes contractor-scoped routers with
global-ingress files; without `exclude` the per-file `global` rule
would collide with the directory `tenant` glob inside the glob tier
and block as `PLANE_RULE_CONTRADICTION` — the exclusion documents the
exception on the directory rule instead.

### Schema

One document: `{ "rules": [rule, ...] }`. Every rule carries:

| Field | Meaning |
| --- | --- |
| `match` | Repo-root-relative glob over the resource's **source file path** — the same glob semantics as core's classifier (`*` within one segment, `**` across segments, `?` one character; whole-path, case-sensitive). |
| `exclude` | Optional, **only together with `match`**: a non-empty list of repo-root-relative globs (same semantics) pruning whole **source files** from the rule's surface — if the resource's source path matches ANY of them, the rule does not apply at all. Each entry is validated like `match` (absolute / backslash / `..` patterns throw). |
| `tables` | Explicit list matched against the table `resourceName` **or** the class simple name (`ErpClient` matches table `erp_clients`). Matching either is deliberate: table names and class names are both identity evidence for the same resource. |
| `plane` | Strictly `tenant`, `master`, or `global` (validated). |
| `reason` | Required non-empty string — the human review artifact. It rides conflict diagnostics verbatim. |

A rule carries **exactly one** of `match`/`tables` (both or neither is a
read-time error); `exclude` is rejected on a `tables` rule — it prunes
the surface of a source-path glob, so on an enumeration it would be
dead config, and dead config in a review artifact reads as a review
that never happened. Rules apply to business `sqlalchemy.table`
resources only — `gateforge.class` symbols never carry a plane.

### Evaluation semantics (deterministic, fail closed)

Rules resolve in **two tiers with explicit-beats-general precedence**:

- **Explicit tier first** — a table claimed by ANY `tables` rule
  (explicit enumeration) resolves ONLY against `tables` rules;
  `match` (glob) rules are ignored for it. The WHY: an enumerated name
  list is a more specific, human-reviewed claim than a directory glob,
  and a glob's `exclude` prunes source **files**, not table names —
  a glob rule cannot enumerate name-level claims. Cross-tier overlap
  therefore never reads as a contradiction: the explicit names win,
  the glob keeps covering only the tables it alone claims.
- **Glob tier second** — `match` rules apply only to tables no explicit
  rule claims. A `match` rule may carry `exclude`: source files matching
  any exclusion glob are removed from the rule's surface BEFORE tier
  collection, so an excluded file cannot collide with a narrower
  per-file rule. WHY: real directory surfaces mix planes —
  `backend/api/v1/**` holds contractor-scoped routers beside
  global-ingress files (`public_payment.py`, `master_admin.py`) — and
  without documented exceptions the narrow per-file rules collide with
  the directory glob inside this tier and block as
  `PLANE_RULE_CONTRADICTION`. The exclusions live in the reviewed
  config (explicit, `reason`-backed, diff-visible) rather than being
  resolved by silent rule precedence.

Within the deciding tier:

- **ALL matching rules of that tier are collected**, in config order.
- **Agreement** — every matching rule of the tier asserts the same
  plane → it is applied; the graph then qualifies the id as
  `plane.name`.
- **Conflict within the tier** — its rules disagree → a blocking
  `PLANE_RULE_CONTRADICTION` finding names the table, every conflicting
  plane, every reason, and every rule index, and NO plane is applied:
  the table stays plane-unresolved and blocks. Fix the config; never
  guess between planes.
- **No match** — nothing is applied and the resource stays
  plane-unresolved → the classifier blocks it. This is deliberate
  closed-world completeness: the config must cover **every** business
  table, or the gate stays red.

In the example above, `master_users` and `erp_client_configs` are
claimed by the `tables` rule and get `master` even though the
`backend/models/**` glob also matches their files; tables under
`backend/models/` that are not enumerated get `tenant` from the glob;
`public_payment.py` is excluded from the `backend/api/v1/**` tenant
glob and gets `global` from its per-file rule, while the other routers
under `backend/api/v1/` keep `tenant`; a contradiction is reported only
when two rules of the SAME tier disagree for one resource (e.g. two
`tables` rules asserting different planes for one table, or two
`match` rules whose surfaces — after exclusions — still overlap).

### Reading behavior

The document is read once per `discover()` from the working directory
(absence is **normal** → byte-identical `NO_PLANE_MAPPING` behavior; a
malformed document, unknown key, bad plane, missing reason,
non-repo-relative glob (in `match` or `exclude`), or `exclude` on a
`tables` rule **throws**, and the CLI surfaces the error
instead of scanning with partial trust). Precedence: the programmatic
`plane` factory option wins and the config file is not read at all; an
explicit `planesConfig` option overrides the document; the default
document path can be moved with `planesConfigPath`.

## Plane and resource classification

The detector emits normalized facts, plane evidence (from
`.gateforge/planes.json`, above), and classification signals. It does not
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
tests that intentionally disable plane attribution (programmatic or
config-driven).

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
| GF-20 | `dupes` × 2 in one file (same Base → flagged) + `shared_items` across files with DISTINCT local Bases → suppressed + `shared_base_models.py` re-declaring it on the IMPORTED Base → flagged (base-qualified rule, `test/subprocess.test.ts`) |
| GF-21 | declared_attr / f-string / call / name / `table=True` → typed unresolved entries, never absent |
| — | Declarative `.gateforge/planes.json` (phase 5): path/tables rules apply with explicit-beats-general precedence (`tables` enumeration beats an overlapping glob; conflicts fail closed WITHIN a tier), `exclude` carves mixed-plane directory surfaces (excluded files never collide with per-file rules), no-match stays plane-unresolved, config absence is byte-identical (`test/planes.test.ts`) |
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