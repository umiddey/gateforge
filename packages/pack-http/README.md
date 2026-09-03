# @gateforge/pack-http — Generic HTTP exposure pack

Pure-TypeScript in-process detector that finds **externally reachable HTTP
artifacts** in `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` source — no execution,
no network, no external deps — and emits the classification **signals**
(plan phase 4, ADR 0003 D1/D2) that let the core classifier mark resources
`user-facing` and enable observed lifecycle operations:

- **Server routes**: Express `app.get('/accounts', …)` / `router.post(…)`,
  Fastify and Hono registrations (import-disambiguated, the pack-auth
  convention), and NestJS `@Controller('accounts')` + `@Get/@Post/@Put/
  @Patch/@Delete/@All('…')` decorators.
- **Frontend API-client calls** (bounded static dataflow, plan phase 3):
  direct literal `fetch`/Axios, `fetch(url, { method })`, Axios config
  objects and instances, configured client symbols (`apiClient.get`),
  pure URL builders (`buildApiPath` with a declared base), module
  constants (local and imported within the scanned set), template
  literals with positional `${}` slots, and simple single-return wrapper
  functions. Computed methods, arbitrary concatenation,
  environment-dependent hosts, undeclared wrappers, and wrapper flows
  outside the model emit **typed unresolved entries** — they never
  disappear and never default to GET.

## Client-scan configuration

Configuration declares resolvable APIs, never coverage exemptions
(`.gateforge/http-clients.json`, or pass `clientScan` to the factory):

```json
{
  "clientSymbols": ["apiClient"],
  "wrapperFunctions": [{ "name": "apiGet", "method": "GET" }],
  "urlBuilders": [{ "name": "buildApiPath", "base": "/api" }],
  "sameOriginHosts": ["app.example.com"]
}
```

A module-scope function whose body issues client calls IS a client
wrapper: calling it without declaring it blocks with
`FRONTEND_CALL_TARGET_UNRESOLVED` — removing wrapper support can never
make a call silently disappear (red probe).

## Resources

**None.** Routes are evidence, not business resources: an early design
emitted one `http-route` resource per artifact, but a path-derived resource
name collides with the converged SQLAlchemy table at the same
plane-qualified id, so the resource channel was removed after a red-probe
(`resources: []` always; see ADR 0004 D1 for the successor design —
endpoint identities live in the `@gateforge/http-contract` join, never in
the path-derived table name).

## Signals

| Dimension | When | Assertion | Target |
| --- | --- | --- | --- |
| `exposure` | every artifact | `route` (server) / `frontend-call` (client) | path-derived resource name |
| `lifecycle.create` | POST | `true` | path-derived resource name |
| `lifecycle.read` | GET/HEAD | `true` | path-derived resource name |
| `lifecycle.update` | PUT/PATCH | `true` | path-derived resource name |
| `lifecycle.delete` | DELETE | `true` | path-derived resource name |

**Path-derived resource name** = the last non-empty, non-parameter path
segment (`:id`, `{id}`, `*` skipped), lower-cased, extension stripped:
`/api/accounts/:id` → `accounts`. The core classifier converges routes and
tables by that name deterministically. Rules:

- A route whose name cannot be derived (`/`, all-parameter) emits **no
  signal** — nothing is claimed about an unnamed target.
- A signal whose target names no discovered resource surfaces as a typed
  `STALE_SIGNAL_TARGET` block: a link the engine cannot resolve blocks
  rather than guesses.
- `app.all` asserts exposure but no lifecycle operation.
- The pack emits **no negative proof anywhere** (no regex-only negative
  proof, no "not found means internal") and never writes classifications.

## Setup

```yaml
# .gateforge.yml
plugins:
  - id: gateforge.pack-http
    version: 0.1.0
    transport: in-process
    module: '@gateforge/pack-http'
```

The pack also emits `http.contract` evidence facts (one per server
artifact and one per frontend callsite) for the endpoint compiler's join
(ADR 0004 D1) — evidence-only, never business resources.

Requires Node >= 20; no network at any point.
