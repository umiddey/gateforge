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
- **Frontend API-client calls**: `fetch('/api/accounts')` and
  `axios.get('/api/accounts')` with literal paths — the frontend-only
  exposure path.

## Resources

One `http-route` resource per artifact: id
`http-route:<file>:<line>:<method>.<name>` (`.N` disambiguator for exact
duplicates on one line), attributes `resourceName` (path identity),
`method`, `path`, and `origin` (`express | fastify | hono | nestjs | fetch |
axios`). Sorted by id; output is a pure function of file bytes.

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

Requires Node >= 20; no network at any point.
