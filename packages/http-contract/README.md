# @gate-forge/http-contract

Framework-neutral canonical HTTP contract for Gateforge (ADR 0004): the
strict `HttpContractFact` schema, typed outcome codes, canonical
path/method normalization, and the deterministic frontend-call ↔
server-route join engine.

This package owns **no framework parsing** (detector packs own that) and
**no classification** (`@gate-forge/core` owns that). Every export is a pure
function; identical inputs produce byte-identical outputs under any input
permutation.

## Contract facts

A fact is one discovered HTTP surface, serialized by detector packs as
GPP/3 resources of kind `http.contract` (evidence-only; never classified
directly, never a business resource):

```ts
interface HttpContractFact {
  schemaVersion: 1;
  role: 'server-route' | 'frontend-call';
  method: 'GET'|'HEAD'|'POST'|'PUT'|'PATCH'|'DELETE'|'OPTIONS'|'ANY';
  normalizedPath: string;   // canonical positional form
  rawPath: string;          // exactly as written in source
  framework: string;        // 'fastapi' | 'fetch' | 'axios' | ...
  handlerSymbol?: string;   // server routes
  requestSchemaSymbols?: string[];
  responseSchemaSymbols?: string[];
  callsites?: string[];     // frontend calls
  source: { file: string; line: number; col: number };
}
```

## Canonical normalization (ADR 0004 D2)

`normalizeHttpPath` strips query/fragment, collapses slashes, converts
`${expr}` and FastAPI `{name}` / `{name:type}` to `{}`, `{name:path}`
converters and `*` catch-alls to `{*}`, and canonicalizes absolute URLs
only for configured same-origin hosts. Parameter names are **never** part
of an identity. Unresolvable shapes return `HTTP_PATH_DYNAMIC` — never a
guess.

`normalizeHttpMethod` uppercases concrete verbs and returns `null` for
dynamic methods (callers must emit `HTTP_METHOD_DYNAMIC`; defaulting to
`GET` is forbidden).

## Join engine (ADR 0004 D3, phase 3 literal precedence)

`joinFrontendCalls(routes, calls)` implements exactly-one cardinality:
equal method, equal segment count, position-wise match where a frontend
`{}` matches any single route segment and a route `{*}` matches one or
more trailing segments.

Candidates are then partitioned by match quality before the exactly-one
check (**literal precedence**): a match is *literal* when it consumed no
slot generality — every position is exact segment equality, counting a
route `{}` mirrored by the call's own `{}` — and *parameter* otherwise
(route `{}` absorbing a call literal, a call `{}` relaxed onto a route
literal, or any `{*}` absorption; a wildcard match is never literal). If
any literal matches exist they are THE candidates; parameter-only matches
are considered only when zero literal matches exist.

Why: routers resolve literal path segments before parameterized ones at
runtime (FastAPI included), so `/messages/search` never reaches
`/messages/{}` with `id="search"`. The static join mirrors that runtime
truth: a template call `/messages/${id}` joins `/messages/{}` despite
literal siblings, and a literal call joins the literal route.

Zero matches → `FRONTEND_ROUTE_UNWIRED`; more than one distinct surviving
candidate (in either tier) → `FRONTEND_ROUTE_AMBIGUOUS`. There is no
scoring and no first-match-wins beyond the documented partition. Duplicate
identical routes collapse into one endpoint carrying every source.
