# @gateforge/pack-fastapi — FastAPI server-route detector

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
- **Unresolvable arguments** (a name bound to no known instance, or a
  computed expression): the honest outcome is a typed
  `FASTAPI_PREFIX_UNRESOLVED` entry at the exact call site and **no
  emission** — the routers are provably included somewhere and their
  source carries prefixes, so prefix-less standalone paths would
  fabricate routes. A never-called registry function mounts nothing and
  stays silent (closed world: no scan hole is hidden, and no mount is
  invented). A parameter name shadowing a same-file instance variable
  keeps the module-level reading only (no double emission).

## Output model (ADR 0004 D1)

One `http.contract` resource per (effective mounted path, concrete
method). These are **evidence-only**: the engine-owned graph excludes
them from business classification (no route/table collision) and the
endpoint compiler joins them against frontend-call facts
(`@gateforge/http-contract`). The TypeScript wrapper fills the canonical
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

## Setup

```yaml
# .gateforge.yml
plugins:
  - id: gateforge.pack-fastapi
    version: 0.1.0
    transport: in-process
    module: '@gateforge/pack-fastapi'
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
