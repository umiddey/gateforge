# @gate-forge/pack-fastapi — FastAPI server-route detector

Python-AST detector (stdlib only, no app import, no execution, no network)
served over GPP/3 using the pack-sqlalchemy two-tier structure (ADR 0002):
the in-process TypeScript wrapper spawns the SAME hardened python plugin
the subprocess transport runs, so one detector implementation serves both.

## What it finds

- `FastAPI()` app instances and `APIRouter(prefix="…")` routers with
  **literal** prefixes; computed prefixes emit a typed
  `FASTAPI_PREFIX_UNRESOLVED` entry (blocking) — never a guess.
- Route decorators (`@app.get`, `@router.post`, `@router.api_route(
  methods=[...])`, sync and `async` handlers) with **literal** paths;
  computed paths emit `HTTP_PATH_DYNAMIC`.
- Cross-file mount trees: `include_router(...)` with literal prefixes,
  resolved through scanned-file imports (absolute and relative), including
  import-aliased router names (`from .routers import router as r`) whose
  routes merge into the defining router, and module-import attribute
  chains (`from api.v1 import endpoints` + `endpoints.health.router`).
  Repeated mounts yield one fact per mount. Unresolvable or ambiguous
  targets/aliases and include cycles emit `FASTAPI_PREFIX_UNRESOLVED`.
- Package-attribute imports: `from pkg import attr` where `pkg/attr.py`
  does not exist resolves `attr` through the package's `__init__.py`
  module-level bindings — an assignment (`router = APIRouter()`) or an
  import re-export (`from .endpoints import router`), followed up to 8
  hops. Ambiguity stays a typed `FASTAPI_PREFIX_UNRESOLVED` entry.
- **Registry functions** (the central-registrar pattern): a function
  whose body calls `include_router` on one of its own parameters —
  `def register_all_routers(app): app.include_router(r, prefix=...)` —
  has those includes rewired onto whatever the call-site argument names
  (details below).
- Verbs outside the supported set (e.g. `@router.trace`) emit
  `HTTP_METHOD_DYNAMIC` — nothing disappears silently.
- Per fact: handler symbol, `isAsync`, `response_model`, request schema
  symbols (non-primitive, non-path parameter annotations), `tags`,
  `operationId`, and `mountProvenance` (`include-chain` | `standalone`).
- **Registration order** (0.14): every endpoint the detector can place
  statically in an app's flattened registration sequence carries
  `registration: {scope, order}` — `scope` names the app
  (`module:var`), `order` is its 0-based position: include call order
  across routers, decorator source order within one router (Starlette
  matches routes in registration order, so the smallest order IS the
  serving route). A once-called registry function called by a top-level
  statement of the app-owner module expands IN PLACE: its
  function-body top-level includes order exactly like written includes
  (call-site position, statement order inside the function). Fail
  closed: a route appended to its router after an `include_router` call
  in the same file, declared inside a function body, reachable from
  more than one app, or mounted through a registry-function include
  that is not order-certain (a second call site, a call nested in a
  statement, a foreign-module call, a chained helper hop, or an include
  nested in `if`/`for`/`while`/`try`/`with`/`match`) carries NO
  `registration` — order-uncertain blocks are skipped, and the relative
  order of the provable routes stays correct. A typed path
  convertor in the raw path string (`{n:int}`, `{p:path}`) sets
  `typedPathParams: true` — the route matches narrower than its
  canonical slot shape.

## Configuration: `.gateforge/fastapi.json`

Optional, JSON-only, read from the repo root (same precedent as
pack-http's `.gateforge/http-clients.json`): **absence is normal,
malformed documents throw.**

```json
{ "importRoots": ["backend"] }
```

`importRoots` lists repo-root-relative directories that act as Python
import roots for ABSOLUTE imports — the central-router-registry pattern
where one module registers everything
(`from api.v1.endpoints import activities` /
`app.include_router(activities.router, prefix="/api/v1")`). With roots
configured:

- `from api.v1.endpoints import activities` binds the scanned file
  `<importRoot>/api/v1/endpoints/activities.py` (or its package
  `__init__.py`), so registry includes resolve and effective paths carry
  their real prefixes (`/api/v1/activities/{id}`).
- `from api.v1 import activities` + `activities.router` (the imported
  name is the module) and deeper chains
  (`from api.v1 import endpoints` + `endpoints.health.router`) resolve
  through the same roots.
- **Uniqueness is mandatory**: a dotted module matching MORE THAN ONE
  scanned file across the roots is a typed blocking
  `FASTAPI_PREFIX_UNRESOLVED` entry that names the conflicting files —
  never a guess. Imports resolving to nothing scanned stay typed-
  unresolved as usual (closed world: no scan hole is hidden). With roots
  configured the absolute-import suffix heuristic is disabled (explicit
  roots govern); relative imports and everything else are unchanged.
- Without the config file the detector behaves exactly as before.

The in-process wrapper passes the roots to the python scanner as an
explicit `--import-roots <json-array>` argv flag; the subprocess
transport can pass the same flag directly.

## Registry functions: `include_router` through a function parameter

Real backends often register every router inside one function
(`backend/router_registry.py`):

```python
def register_all_routers(app):        # app is a PARAMETER
    app.include_router(activities_router, prefix="/api/v1/activities")
    ...                                # × 79 includes

# server.py
fastapi_app = FastAPI(...)
register_all_routers(fastapi_app)     # module-level call site
```

Without interprocedural support the parameter breaks the mount-graph
walk: the routers are provably included (so suppressed from standalone
emission) yet contribute ZERO endpoints. The detector closes that gap,
bounded and deterministic:

- **Collection**: a top-level function whose body calls
  `include_router` on one of its own parameters collects those include
  edges keyed by the parameter (nested functions count for the
  enclosing top-level function; positional parameters only — call sites
  bind positionally).
- **Materialization**: every call site of such a function whose argument
  resolves to a known `FastAPI()`/`APIRouter()` instance variable — a
  same-file assignment (module-level **or** factory-local:
  `def create_app(): app = FastAPI(); register(app)` works because the
  local instance is walked) or an import binding to another scanned
  file's instance — receives the edges as ordinary includes on that
  instance. Provenance is unchanged: `include-chain` at the include
  call's own source location; repeated call sites duplicate mounts,
  exactly like written includes.
- **Chaining**: a registry function may pass its parameter to another
  helper (`def create_app(app): register_all_routers(app)`) up to
  **8 helper hops** (`MAX_RESOLUTION_DEPTH`). Chains beyond the bound
  yield one typed unresolved entry naming the function that would need
  hop 9 — no silent drop, no guess.
- **Order-certain expansion** (registration order): when ONE call site
  is provable in full — the function is a plain module-level `def`,
  called exactly once across the scanned set, by a top-level expression
  statement of the module that owns the `FastAPI()` argument — the
  expansion joins that module's statement order at the call site, and
  each function-body TOP-LEVEL `include_router` statement orders like a
  written include (statement order inside the function breaks ties).
  Everything else stays fail closed: a second call site anywhere, a
  call nested in a statement or another expression, a call from a
  module other than the app owner's, a chained helper hop, and any
  include nested in `if`/`for`/`while`/`try`/`with`/`match` mount
  without `registration` (facts unchanged). Order-uncertain blocks are
  skipped, so the relative order of the provable routes stays correct.
- **Unresolvable arguments** (a name bound to no known instance, or a
  computed expression): the honest outcome is a typed
  `FASTAPI_PREFIX_UNRESOLVED` entry at the exact call site and **no
  emission** — the routers are provably included somewhere and their
  source carries prefixes, so prefix-less standalone paths would
  fabricate routes. A never-called registry function mounts nothing and
  stays silent (closed world: no scan hole is hidden, and no mount is
  invented). A parameter name shadowing a same-file instance variable
  keeps the module-level reading only (no double emission).


## Prefixes that are provable, and routers nothing mounts

- **Annotated definitions are definitions.** `router: APIRouter =
  APIRouter(prefix="/api/v1")` is indexed exactly like `router =
  APIRouter(prefix="/api/v1")`, prefix included. (It used to be ignored,
  and every route behind it was published at the router's own prefix with
  no typed outcome.)
- **Constant prefixes fold.** A prefix that is a module-level string
  constant — `API = "/api/v1"` with `APIRouter(prefix=API)` **or**
  `app.include_router(router, prefix=API)` — is provable from the source,
  so the route keeps its real path. An f-string, an attribute, or a call
  is genuinely computed: the router yields a typed
  `FASTAPI_PREFIX_UNRESOLVED` entry and no route is emitted.
- **A router object built by an unmodeled expression** (`router =
  build_router()`, a subscript, an attribute) has an unknown prefix, so
  its routes are reported as `FASTAPI_PREFIX_UNRESOLVED` naming the
  variable — never as prefix-less paths that no app serves.
- **`FASTAPI_ROUTER_UNMOUNTED`.** A router that no scanned
  `include_router` targets is served by no scanned app. Its routes keep
  their standalone emission (the declared prefix is all the scan knows),
  and one typed entry names the router, its file and every declared
  route, so "the `/api/v1` prefix was not applied" is never the answer
  when the real one is "nothing mounts this router". Reported only when
  the scanned set shows an application and has no unresolvable include;
  with a partial scan, or an include the scan cannot follow, the pack
  says nothing it cannot prove.

## Output model (ADR 0004 D1)

One `http.contract` resource per (effective mounted path, concrete
method). These are **evidence-only**: the engine-owned graph excludes
them from business classification (no route/table collision) and the
endpoint compiler joins them against frontend-call facts
(`@gate-forge/http-contract`). The TypeScript wrapper fills the canonical
`normalizedPath` (single canonicalization implementation across
languages) and mints **no classification signals** (dogfood remediation
phase 4): the earlier `exposure: route` / `lifecycle.*` signals were
targeted at the path-derived business name — a guess that mostly names
no discovered resource (`/admin-bypasses` vs the real table), producing
`STALE_SIGNAL_TARGET` blockers while adding nothing, since unknown
exposure defaults `user-facing` and unknown lifecycle operations default
enabled (ADR 0003 D5). Route→resource linkage belongs to the CLI
endpoint compiler, which corroborates the candidate name against the
schema symbols (`requestSchemaSymbols`/`responseSchemaSymbols`) and
handler names these very facts carry, and blocks ambiguity with typed
`ENDPOINT_RESOURCE_LINK_UNRESOLVED`. Core's `STALE_SIGNAL_TARGET`
detection remains for genuinely stale authority signals (declaration
markers, adapter bindings, read-only declarations).

## Response-model wire names

Each server-route fact carries `attributes.responseModelFields`: the wire
names its response model answers to, in declaration order — every pydantic
field name plus every `Field(alias=...)` it declares, including the fields
it inherits from a base class the scanned set also proves. The model is
the decorator's `response_model=` when it declares one and the handler's
return annotation otherwise (FastAPI's own default), with the containers
FastAPI unwraps peeled off: `list[InvoiceOut]`, `Optional[MoneyOut]` and
`MoneyOut | None` all report the element model.

`detail` is always among the names: FastAPI answers a failed request with
`{"detail": ...}` (an `HTTPException`) or a `detail` list (request
validation), so a frontend reading `detail` to report an error is never
evidence of a dropped success-model field.

The attribute is **absent** whenever the wire names are not statically
computable, never partial:

- a model configuring alias generation (`model_config = ConfigDict(...)`
  or a pydantic v1 `class Config`) — every name differs;
- a base class outside the scanned set — inherited fields unknown;
- a shape that is not one model: `dict`, a union of two models, a
  computed annotation, no annotation at all.

The existing `responseModel` attribute keeps its exact previous meaning
(the decorator declaration only) and its exact previous bytes; a return
annotation is a new fact, never a change of the old one.

`gateforge check` cross-checks these names against the fields a frontend
actually reads (reported by `@gate-forge/pack-http` as `responseReads`)
and emits one **non-blocking** `RESPONSE_FIELD_MISSING_FROM_MODEL`
advisory per field a joined endpoint's model does not declare — naming the
endpoint, the field, the frontend file and line, and the names the model
does declare. A field counts as present under its own name, under the other
case style (`due_date` ≡ `dueDate`) or under a declared alias. A
repository whose routes declare no provable response model produces no
advisory and a byte-identical report.

## Setup

```yaml
# .gateforge.yml
plugins:
  - id: gateforge.pack-fastapi
    version: 0.1.0
    transport: in-process
    module: '@gate-forge/pack-fastapi'
```

Requires Node >= 20 and `python3` >= 3.11 on PATH; no network at any
point.

Subprocess transport (equivalent):

```yaml
plugins:
  - id: gateforge.pack-fastapi
    version: 0.1.0
    transport: subprocess
    command: ['python3', '-m', 'gateforge_fastapi_detector']
# with PYTHONPATH=<pack>/python:<plugin-protocol>/python
```
