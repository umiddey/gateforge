# @gate-forge/pack-http — Generic HTTP exposure pack

Pure-TypeScript in-process detector that finds **externally reachable HTTP
artifacts** in `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` source — no execution,
no network, no external deps — and emits `http.contract` **evidence facts**
(ADR 0004 D1) for the engine's endpoint-compiler join. It mints **no
classification signals** (dogfood remediation phase 4):

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
  disappear and never default to GET. A modeled Axios instance creation
  with a proven literal `baseURL` joins that base into the emitted call
  path (see *Instance baseURL joining* below).

## Client-scan configuration

Configuration declares resolvable APIs, never coverage exemptions
(`.gateforge/http-clients.json`, or pass `clientScan` to the factory):

```json
{
  "clientScanRoots": ["frontend/**"],
  "serverScanRoots": ["src/**", "services/**"],
  "clientSymbols": [
    "apiClient",
    { "name": "api", "include": ["frontend/src/**"], "exclude": ["frontend/src/generated/**"] }
  ],
  "wrapperFunctions": [{ "name": "apiGet", "method": "GET", "include": ["frontend/**"] }],
  "urlBuilders": [{ "name": "buildApiPath", "base": "/api" }],
  "sameOriginHosts": ["app.example.com"]
}
```

A module-scope function whose body issues client calls IS a client
wrapper: calling it without declaring it blocks with
`FRONTEND_CALL_TARGET_UNRESOLVED` — removing wrapper support can never
make a call silently disappear (red probe).

### Instance baseURL joining (source-proven, fail-closed)

Frontends commonly create one Axios client with a base path and then
write every call base-relative — `axios.create({ baseURL: '/api' })`
plus `apiClient.get('/v1/x')` hits `/api/v1/x` at runtime. Without
joining, those calls compare against backend routes as `/v1/x` and go
unwired for the prefix alone. When an instance symbol's creation is
modeled, its **proven literal `baseURL` joins into the emitted call
path**: `normalizedPath = normalize(baseURL + callPath)`. This is
source-proven, not configured — no new configuration key exists.

**Extraction.** The modeled creation shape is a module-scope
`const x = axios.create({...})`. The base is read from the config
argument in property order, last writer wins (JavaScript object
semantics): a direct `baseURL` property, and spreads of a **declared
constant config object** the creation is assigned from or spreads
(`axios.create(config)`, `axios.create({ ...defaults })`), resolved
through the same bounded value table as path constants — local
module-scope constants and relative imports, cycle-guarded. A
non-literal base (env variable, computed, unmodeled factory) is simply
unproven.

**Where the creation is found (precedence).**

1. The symbol's module-scope creation in the callsite file itself.
2. The creation in the relative-import module providing the binding
   (the existing bounded import machinery, nothing looser).
3. Otherwise a **unique declaration of the symbol across the scanned
   product set** — the configured-symbol channel already treats the
   name as global, and real API clients are singletons, so an
   alias-imported creation (`from '@/lib/apiClient'`) resolves here.
   Fail-closed: every same-named creation must be a modeled
   `axios.create` and all proven bases must agree; disagreement, a
   second distinct base, or any unprovable same-named creation vetoes
   the join. The search stays inside `clientScanRoots` (an out-of-scope
   e2e mock instance cannot poison product calls) and never applies to
   the bare `axios` global, whose base is axiomatically absent unless
   shadowed in the callsite file itself.

**Join semantics.** Exactly one slash seam, axios `combineURLs` style:
trailing base slashes and leading call-path slashes collapse
(`/api/` + `/v1/x` → `/api/v1/x`). Empty and `/` bases join nothing;
an absolute call URL (`https://…`, protocol-relative `//`) ignores the
base and keeps the existing absolute-URL / `sameOriginHosts` rules; a
literal absolute base joins and canonicalizes to its path portion for
configured same-origin hosts. A base template with a resolvable hole
(`/api/${version}`) joins positionally; an unresolvable hole keeps
the base unproven.

**What changes and what never does.** Only the fact's `normalizedPath`
gains the prefix — `rawPath` stays exactly as written, and
normalization itself (query/fragment stripping, `${}`/`{}` slotting,
slash collapsing) is unchanged. A joined path then meets the
endpoint-compiler join's literal-precedence rules like any other path
(that engine is owned by `@gate-forge/http-contract`). Callsites that
join nothing behave byte-identically to before, and joining never
turns a passing callsite into a blocker. Wrapper functions do not join
their internal client's base (documented boundary — declare the
wrapper's paths fully, or use a builder with `base`). The
`urlBuilders[].base` channel is unchanged: it is configuration-declared,
so the builder's base is part of the resolved value itself.

### Response field reads (bounded, file-local)

Every frontend-call fact carries `attributes.responseReads`: the fields
the call site reads off that call's own response, each with the location
of the read. It is the frontend half of the dropped-response-field proof
(a merged frontend read `invoice.dueDate` after the FastAPI model had
dropped it; every test mocked the response and the screen showed
nothing), and it is collected by the same bounded pass that resolves the
call target — no execution, no type checker, no cross-file inference.

The model is deliberately small:

- the call's own awaited result is followed through `await` and
  parentheses; `<result>.data` is the payload (the axios/kit envelope) and
  `<result>` alone is the envelope, so `res.status`/`res.headers` are not
  fields;
- a name bound from either of those (`const r = await call`,
  `const { data: d } = await call`, `const d = (await call).data`) is
  followed by name inside the enclosing function-like — nested
  function-likes included, so a `useEffect` callback still counts;
- `holder.<field>`, `holder.data.<field>`, `holder.data['<field>']` and
  `holder['<field>']` are reads, as is every key of an object
  destructuring of a holder or of `<holder>.data`;
- a `let` holder (reassigned before the read), a computed key
  (`d[key]`), and a JavaScript member (`data.map`, `data.length`,
  `status`) are never reads;
- a branch that opens on the call's OWN envelope (`ok`, `status`) is read
  for its POLARITY, and only the failure arm is dropped: the body a
  failure branch reads (`res.data?.detail`) is the server's ERROR
  envelope, never the success model. `if (res.ok)`, `if (res.ok ===
  true)`, `if (res.status >= 400)`, `> 399`, `!== 200`, `!== 201`, `< 400`,
  `=== 200`, `<= 299` and their `!` negations all decide which arm runs,
  so the success arm keeps its reads — `if (res.ok) setItems(res.data.
  items)` is exactly the shape where a dropped field hides. A compound
  condition (`!res.ok || res.status >= 500`), a comparison this pass
  cannot read (`>= Math.min(400, limit)`) and a `statusText` test are
  undecidable, so NEITHER arm is collected. A ternary is the same guard as
  an `if` — `res.ok ? res.data.items : res.data?.detail` keeps the
  success arm — and a ternary on anything else is not a guard at all: both
  arms are ordinary success-path reads. A read after an early-return guard
  (`if (!res.ok) { throw … }` … then the code) is collected as usual;
- a read that is one operand of a `||` / `??` chain carries that chain's
  index, so the check judges the chain as the ONE decision it is:
  `res.data?.invoice_id || res.data?.invoice?.id` is silent when the
  model declares `invoice_id`, because `invoice` is its defensive
  fallback. A chain in which no operand is declared is reported whole.

`gateforge check` compares these reads against the response model the
joined backend route declares and emits one **non-blocking**
`RESPONSE_FIELD_MISSING_FROM_MODEL` advisory per undeclared field. A call
nobody consumes emits no attribute at all, so it stays byte-identical to
before.

### Scan scoping (optional, strict, back-compatible)

All scoping keys are OPTIONAL; a config without them scans exactly as
before (byte-identical). They exist because test-harness code is a
different contract class: e2e helpers that share a configured symbol's
name were scanned as product frontend consumption (typed blockers plus
phantom consumption), and test-harness mock servers matched the generic
server-route regex, producing false `http.endpoint` resources.

- `clientScanRoots` — repo-root-relative globs. Client-call scanning
  (`fetch`/Axios, configured symbols, wrappers, builders) applies ONLY
  to matching files; files outside produce **no client-call facts and no
  unresolved entries** (they still participate in import resolution, so
  product code importing constants from outside the roots keeps
  resolving).
- `serverScanRoots` — repo-root-relative globs. Generic server-route
  scanning (Express/Fastify/Hono registrations and NestJS controllers)
  applies ONLY to matching files; files outside produce no server-route
  facts. Reported `scannedPaths` coverage is unchanged either way —
  scoping narrows facts, not coverage.

Per-symbol scoping (`include`/`exclude` on a `clientSymbols`,
`wrapperFunctions`, or `urlBuilders` entry; plain-string entries remain
unscoped) composes with — never relaxes — the top-level roots. The
precedence is deterministic:

1. **Top-level roots gate first**: a file outside `clientScanRoots`
   yields no client-call facts at all, regardless of any symbol's
   scoping; the same holds for `serverScanRoots` and server routes.
2. **`include` next**: if an entry declares `include`, the file must
   match at least one glob (absent `include` = every in-root file).
3. **`exclude` wins over `include`**: a file named by both is out of
   scope for that entry.

Consequences, kept deliberate and documented:

- A call to a name the configuration declares, in a file outside that
  name's declared scope (the e2e `api(...)` helper), is **ignored** —
  neither resolved nor blocked. The undeclared-wrapper evidence rule
  still blocks any name the configuration never mentions.
- A configured builder or wrapper scoped away from a file simply stops
  resolving there. If the enclosing call is still in scope (e.g. a bare
  `fetch` whose target used the builder), the call fails closed with a
  typed unresolved entry — it never silently vanishes.
- Server-route disambiguation is scope-aware: where a client symbol is
  NOT active for a file, `api.get('/x', handler)`-shaped code is free to
  be discovered as a router registration.

Malformed documents still fail closed: non-object roots, non-verb
wrapper methods, scoping entries without a `name`, and non-array
`include`/`exclude` values throw. Unknown keys and non-array known keys
are ignored, exactly as before (unchanged parser posture).

## Resources

**None.** Routes are evidence, not business resources: an early design
emitted one `http-route` resource per artifact, but a path-derived resource
name collides with the converged SQLAlchemy table at the same
plane-qualified id, so the resource channel was removed after a red-probe
(`resources: []` always; see ADR 0004 D1 for the successor design —
endpoint identities live in the `@gate-forge/http-contract` join, never in
the path-derived table name).

## Signals

**None.** An earlier design minted a code-positive `exposure` signal per
artifact (assertion `route`/`frontend-call`) plus `lifecycle.<op>` signals
from the HTTP method (POST⇒create, GET/HEAD⇒read, PUT/PATCH⇒update,
DELETE⇒delete; `app.all` asserted nothing), each targeted at the
**path-derived resource name** — the last non-empty, non-parameter path
segment, lower-cased, extension stripped (`/api/accounts/:id` →
`accounts`). That target is a GUESS: in real repos it mostly names no
discovered resource (route `/absences` vs table `employee_absences`), and
every minted signal surfaced as a `STALE_SIGNAL_TARGET` blocker while
adding no information — unknown exposure already defaults `user-facing`
and unknown lifecycle operations already default enabled (ADR 0003 D5),
so removing the guesses changes no classification outcome.

Consequences, kept deliberate:

- **Route→resource linkage is the CLI endpoint compiler's exclusive job**
  (ADR 0004): it derives the same candidate name, links only when exactly
  one discovered business resource matches AND a schema-symbol or
  handler-name fact corroborates it (evidence this pack puts on the
  `http.contract` facts), and emits typed
  `ENDPOINT_RESOURCE_LINK_UNRESOLVED` blocks for ambiguity. Name
  coincidence alone never links.
- Removing signals conserves the defaults: exposure stays `user-facing`,
  every lifecycle operation stays enabled (crud:/persistence: obligation
  generation via `lifecycleAllowsContract` is unchanged), and delete
  semantics remain blocked until the model pack proves them.
- Core's `STALE_SIGNAL_TARGET` detection remains for genuinely stale
  authority signals (declaration markers, adapter bindings, read-only
  declarations) — this pack simply no longer produces false targets.
- The pack emits **no negative proof anywhere** (no regex-only negative
  proof, no "not found means internal") and never writes classifications.

## Setup

```yaml
# .gateforge.yml
plugins:
  - id: gateforge.pack-http
    version: 0.1.0
    transport: in-process
    module: '@gate-forge/pack-http'
```

The pack also emits `http.contract` evidence facts (one per server
artifact and one per frontend callsite) for the endpoint compiler's join
(ADR 0004 D1) — evidence-only, never business resources.

Requires Node >= 20; no network at any point.
