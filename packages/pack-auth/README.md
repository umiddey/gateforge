# `@gate-forge/pack-auth`

Authorization contract pack. Pure TypeScript detector (no subprocess) that discovers role-guard patterns across four frameworks and emits `auth.resource` entries with role + tenancy attributes.

## Detected frameworks

| Framework | Detection signal                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------- |
| NestJS    | `@Controller()` class with `@UseGuards(...)` + `@Roles('admin', ...)` + `@Get/Post/Put/Patch/Delete` |
| Express   | `app.METHOD(path, mw, ...)` / `router.METHOD(path, mw, ...)` where `mw` reads `req.user.role`       |
| Fastify   | `fastify.METHOD(path, { preHandler }, handler)` whose `preHandler` reads `request.user.role`        |
| Hono      | `app.METHOD(path, mw, ...)` where `mw` reads `c.var.user.role` or `c.get('user')`                   |

Each guarded endpoint becomes one resource:

```
{
  id: "auth.billing.post-refund",
  kind: "auth.resource",
  source: "src/billing.controller.ts",
  location: { file, line, col },
  detectorVersion: "0.1.0",
  attributes: {
    framework: "nestjs" | "express" | "fastify" | "hono",
    path: "/billing/refund",
    httpMethods: ["POST"],
    roleRequirement: ["admin", "finance"],
    tenancy: true | false
  }
}
```

Resource ids follow the grammar `auth.<area>.<verb>-<endpoint>`; the area is the first path segment, the verb is the lowercased HTTP method.

## Obligation contract vocabulary

Defined in `src/obligations.ts` and re-exported as `AUTH_OBLIGATION_CONTRACTS`. Obligation ids are `<resourceId>:<contract>` per the engine's id grammar.

| Contract                       | Meaning                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `auth:role-allowed`            | Caller with a role in `roleRequirement` receives a 2xx response                                          |
| `auth:role-denied`             | Caller without a matching role receives 401/403                                                         |
| `auth:tenant-isolated`         | Caller with the right role but wrong tenant receives 403 (when `tenancy: true`)                         |
| `auth:denied-no-side-effect`   | Denied requests do not mutate the resource (post-deny GET shows the row unchanged/missing)             |
| `auth:forged-token-rejected`   | Forged JWT (bad signature, expired, malformed, missing) returns 401                                    |

## Findings

| Code                  | Meaning                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `AMBIGUOUS_GUARD`     | A `@Roles()` decorator uses non-literal arguments (e.g. `@Roles(...ALLOWED)`)               |
| `DUPLICATE_RESOURCE_ID` | Two declarations produce the same `auth.<area>.<verb>-<endpoint>` id                       |
| `PARSE_ERROR`         | File could not be read for scanning                                                         |

## Entity adapter schema

The pack ships `src/adapter-schema.ts` (mirror of `@gate-forge/pack-sqlalchemy`'s adapter contract) so billing resources can be witnessed GET-only. The example auth server emits `x-gateforge-env: example-auth-v1` on every response; the adapter's `environmentFingerprint` must equal that value.

```js
// .gateforge/adapters/auth.billing.refund.mjs
export default {
  resourceId: 'auth.billing.refund',
  read: async (ctx, id) => fetch(`${ctx.baseUrl}/billing/refund/${id}`, { headers: ctx.headers ?? {} }),
  normalize: (body) => ({ entityId: body.id, fields: { id: body.id, status: body.status, tenant_id: body.tenant_id } }),
  deletion: 'archive',
  environmentFingerprint: 'example-auth-v1',
};
```

## Example server

`example/auth/server.js` — zero-dependency node:http server on port `3001`:

- `POST /billing/refund` guarded by role (`admin`) AND tenant match; creates an in-memory row.
- `GET  /billing/refund/:id` returns the row (404 if absent; 403 cross-tenant).
- All responses carry `x-gateforge-env: example-auth-v1`.

Run it:

```
node example/auth/server.js
# → gateforge auth example server listening on http://127.0.0.1:3001
```

## Tests

```
cd packages/pack-auth
npx tsc --noEmit   # typecheck
npx vitest run     # unit + e2e
```

The e2e suite boots the server on an OS-assigned free port, exercises all five obligation contracts, and includes two adversarial tests:

1. `fake-green: role-denied with 200` — vitest must reject (server returns 403).
2. `fake-green: no-side-effect without post-deny GET` — companion assertion in the positive suite proves the GET probe is required.

## Use as a CLI plugin

```yaml
# .gateforge.yml
plugins:
  - id: gateforge.pack-auth
    version: 0.1.0
    transport: in-process
    module: '@gate-forge/pack-auth'
```

## Limitations

- Python sources are out of scope (TS-only per brief).
- Dynamic role sets (e.g. `@Roles(...ALLOWED)`) surface as `AMBIGUOUS_GUARD` and never become resources; users must lift them to literals.
- The regex detector does not run a TS compiler; framework-specific syntax must match the documented signal exactly (decorator order, option-block shape, etc.).