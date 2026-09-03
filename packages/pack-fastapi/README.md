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
  routes merge into the defining router. Repeated mounts yield one fact
  per mount. Unresolvable targets/aliases and include cycles emit
  `FASTAPI_PREFIX_UNRESOLVED`.
- Verbs outside the supported set (e.g. `@router.trace`) emit
  `HTTP_METHOD_DYNAMIC` — nothing disappears silently.
- Per fact: handler symbol, `isAsync`, `response_model`, request schema
  symbols (non-primitive, non-path parameter annotations), `tags`,
  `operationId`, and `mountProvenance` (`include-chain` | `standalone`).

## Output model (ADR 0004 D1)

One `http.contract` resource per (effective mounted path, concrete
method). These are **evidence-only**: the engine-owned graph excludes
them from business classification (no route/table collision) and the
endpoint compiler joins them against frontend-call facts
(`@gateforge/http-contract`). The TypeScript wrapper fills the canonical
`normalizedPath` (single canonicalization implementation across
languages) and mints `exposure: route` / `lifecycle.*` signals targeted
at the path-derived business name — parity with pack-http.

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
