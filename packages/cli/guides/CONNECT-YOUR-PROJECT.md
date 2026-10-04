# Connect your project

From an empty repository to a green gate, in the order that actually
unblocks you. Every command here is yours to run; every step is work on
YOUR side of the boundary. Gateforge never edits your app, your tests, or
your policies to make a gate pass.

Read this end to end once. After that, `gateforge next` always prints the
ONE next action.

---

## The setup order

`gateforge init` → answer the plane questions → `gateforge adopt` (only when the repository already has code) → adapters and runtime → pin the owner-approved policy digest → commit. Each step assumes the previous one ran.
- Install the CLI and packs, then commit the install (package.json + lockfile) on its own before `gateforge init` — no gate is wired yet. The setup commit must contain only Gateforge's own files (plus the `.gitignore` block init writes) to count as product-behavior-neutral; mixing in dependency or product changes makes it a normal gated change, which under strictE2E re-grades the adopted E2E debt as blocking. Commit product changes (for example a Playwright config rename) separately, after the setup commit.

- **Answer the plane questions** with `gateforge classify plane <folder> <tenant|master|global> --reason "<why>" --confirm` (run `gateforge init --planes` once first to create the owner-reviewed `.gateforge/planes.json`). The three planes:
  - **tenant** — the data of one customer or organisation, e.g. a per-customer database or rows scoped by a customer id.
  - **master** — the platform's own administrative data, shared by the operator, e.g. the admin platform's database of customers and plans.
  - **global** — reference data that is the same for everyone, e.g. currencies.

  An infrastructure route that serves no business data (health, metrics): answer the plane of the database it runs against, or — when the file is not part of the product — exclude it with `project.paths.exclude` in `.gateforge.yml`.
- **`gateforge adopt` comes after the plane answers** because a plane answer changes a resource's identity, so the debt set `adopt` records would not match the repository if it were captured before the answer.
- **Declare the dependency directories the staged commit gate may link** (`prepare: { reuse: [node_modules] }` in `.gateforge/runtime.yml`): the gate runs on a checkout of the staged files only.
- **Pin the owner-approved policy digest LAST**, right before the first strict commit: read the full value from `gateforge enforcement doctor` and set it as `GATEFORGE_APPROVED_POLICY_DIGEST`. It changes whenever a policy input changes — `.gateforge.yml`, the policies, the classification policy, `planes.json`, adapters, `runtime.yml`, waivers, hooks — so re-pin after every such edit. Stage every policy file first (`git add`) — the commit gate digests the staged bytes, and `enforcement doctor` warns when they differ from the working tree.

## 1. What you need

| Your stack | Detector pack (installed by `init`) | Runner | What you write |
| --- | --- | --- | --- |
| Python + SQLAlchemy | `gateforge.pack-sqlalchemy` | any | models, evidence adapters |
| Python + FastAPI | `gateforge.pack-fastapi` | any | routes, evidence adapters |
| JavaScript/TypeScript + Express, Fastify, Nest | `gateforge.pack-http` | playwright or your own | routes, evidence adapters |
| HTTP clients (OpenAPI/GraphQL consumers) | `gateforge.pack-http` | any | — |
| Alembic migrations | `gateforge.pack-alembic` | any | revisions |
| Auth surfaces | `gateforge.pack-auth` | any | — |

`gateforge init` scans the repo, prints the recommended pack list, and
writes `.gateforge.yml`. Add or remove a pack later by editing the
`plugins:` list — that file is yours; an agent must not weaken it.

A complete entry looks like this (add one per pack):

```yaml
plugins:
  - id: gateforge.pack-sqlalchemy   # the detector's id, exactly as the pack declares it
    version: '0.2.0'                # the version THAT pack's detector declares — not the pack's npm version
    transport: in-process
    module: '@gate-forge/pack-sqlalchemy'
```

`version:` is the detector version the pack's own signals carry, and it
is NOT the pack's npm version (the pack publishes as 0.9.0 while its
detector declares, say, 0.2.0). Copying a neighbouring entry's value is
the usual mistake, and it makes every command exit 2: the detector
refuses to signal under a version the config did not pin. The error names
the value to write, and `gateforge init --plugins gateforge.pack-sqlalchemy`
writes the right pin for you.

**Your own detector or runner?** Both are public plugin surfaces: a
detector is a module exporting `discover(paths)` (see
`packages/plugin-protocol`), and a runner is an adapter implementing the
runner contract from `@gate-forge/witness/adapter` (see
`packages/cli/guides/RUNNER-NEUTRAL-EVIDENCE.md`). Write one when no
bundled pack understands your framework; you never have to change
Gateforge to add one.

## 2. `gateforge init`

```bash
npx gateforge init --blocking
```

It writes `.gateforge.yml`, `.gateforge/policies.yml`, the classification
policy, the `GATEFORGE.md` agent loop, and the adapter/waiver skeleton,
then wires the pre-commit hook and CI. It also adds Gateforge's own run
state (`.gateforge/test-gates/`) to your `.gitignore` — that directory is
regenerated by every run, and without the rule `git add -A` stages it and
the gate blocks on its own cache. Re-run it any time; it is idempotent and
never overwrites a file you edited. Anything it appends to a file you own
(your CI file, your `.pre-commit-config.yaml`, your `.gitignore`) is
reported as an in-place change with `undo: git restore -- <path>`, separate
from the `undo: rm -rf` line for files it created.

**Your first commit.** Everything `init` and `adopt` write is a Gateforge
policy input, not product code: the config and policy documents, the
exclusion declarations, the mapping sidecar, the adapter/waiver/baseline
records, the generated hook and CI templates, `GATEFORGE.md`, and your CI
and pre-commit config *while they still carry Gateforge's block*. Committing
them does not count as an untested behavior change, so the setup commit
passes `check --changed` in strict mode without `--no-verify`, and it does
not re-open the E2E debt you adopted. Those files are inside the approved
policy digest, so approve the digest `init` prints through the protected
`GATEFORGE_APPROVED_POLICY_DIGEST` setting before you rely on that in a
strict repository — an unapproved policy revision blocks, exactly as any
other change to your gate does. Removing the gate job from your CI config is
not a policy input: it goes back to blocking.

Exit code 2 means a configuration problem, not a code problem: the
message names the file and the key.

If the project already has an application, the first commit meets debt the
gate found before you ran anything. Record that debt once with
`gateforge adopt` (see `gateforge adopt --help`): it captures today's
findings as shrink-only forgiven debt and wires the gate. It is never
needed for a brand-new project, and it does not prove anything — new work
still blocks, and under `strictE2E` an adopted E2E obligation blocks again
as soon as a change touches it.

## 3. A test environment the gate may trust

The witness reads the app you point it at. That app must be **isolated
and reproducible** — a shared developer database makes every persistence
verdict a guess.

- Run the app on loopback, on a disposable database, seeded per run.
- Reset it before each run (`docker compose down -v && docker compose up -d`,
  `alembic reset`, or your test-data script).
- Keep the login state: either no auth, or a seeded account whose
  credentials live in your CI secret store — never in the repository.
- Present an environment marker: your app must answer
  `x-gateforge-env-fingerprint: <value>` on every route the adapters
  read. Export the same value as `GATEFORGE_TARGET_FINGERPRINT` in the
  environment that runs the gate. The witness refuses evidence from a
  different environment than the UI under test (GF-13).

Full rules, including what never belongs in a test environment:
`TEST-ENVIRONMENT.md`.

## 4. Runner

By default the supervised run drives Playwright. If your suite already
exists in another runner, declare it once:

```yaml
# .gateforge.yml
runner: vitest        # playwright (default) | pytest | vitest | cypress
```

Then implement the runner adapter contract (one function that reports
what the test did, through the witness) — the guide is
`RUNNER-NEUTRAL-EVIDENCE.md`. Gateforge drives your existing tests; it
never asks you to rewrite them.

## 5. Evidence adapters

An adapter is the small reviewed module that lets the **witness** look
up one row itself, GET-only, from its own process. It is the only place
where "the database says so" enters the gate, so it is reviewed like
code.

### 5a. Generate the starting points

```bash
export GATEFORGE_TARGET_FINGERPRINT=my-app-loopback-v1
npx gateforge adapters scaffold
npx gateforge adapters scaffold --dry-run    # print the plan, write nothing
```

For every business resource that has no adapter, this writes
`.gateforge/adapters/<resourceId>.mjs` from what Gateforge already
knows: the classified identity, the delete semantics the graph can
prove, every column the graph declares for the table, and the GET
routes the compiler found.

- It **never overwrites** an existing adapter.
- Every guess is listed in the file's own header comment. Read it.
- `fields` is every declared column except the primary key (that IS
  the id) and credential-shaped columns; the header names what it
  left out, so adding a field back is one line.
- `deletion` follows the graph's own soft-delete signal. When the
  graph proves nothing but the table carries a typical soft-delete
  column, the value is a guess and **needs you** says which column
  raised the question.
- It writes only from routes the engine **linked** to the resource. A
  path that merely *names* it is listed under **needs you** with the
  candidates, for you to confirm; a route linked to a different
  resource is never used.
- A per-parent route (`/contracts/{contractId}/invoices`) is never
  taken as the collection, and never as a by-id read of the resource.
- A route with a **literal segment between the resource and the id**
  (`/shipments/carrier/{id}` looks a carrier up through a shipment) is
  never taken as a by-id read either — whatever it answers, it is not
  one entity of that resource.
- When a route comes from a router **no app mounts** (the module is
  never included anywhere), the file still uses it — but marks the
  derived path as a guess and asks you to confirm it: the route exists
  in the source tree, and nothing serves it.
- When the app serves a complete collection and **no by-id route at
  all**, it writes a **list-only** adapter: the kit reads the member
  out of the collection. The file's header says so, because every read
  then walks the whole collection — slower than a by-id read. Add
  `readPath` as soon as the app serves one.
- Anything it will not guess is printed under **needs you**, with the
  reason: no read route, a composite key, no collection route (a create
  cannot be witnessed without one), a route only a name match points
  at, no projectable columns, an unknown target fingerprint, or a route
  that **exists but whose endpoint plane is unanswered**. That last
  case is named with its blocker — `GET /api/v2/accounts/{} exists but
  its plane is unanswered — answer the plane first` — and never
  reported as a missing route.

A generated adapter is a **starting point, not proof**. The gate grades
it exactly like a hand-written one.

### 5b. Review, and finish the hand-written part

The generated module is deliberately short; the kit
(`@gate-forge/witness/adapter-kit`) does the rest:

```js
import { defineHttpAdapter } from '@gate-forge/witness/adapter-kit';

export default defineHttpAdapter({
  resourceId: 'tenant.accounts',
  readPath: (id) => `/api/accounts/${encodeURIComponent(id)}`, // {id} also works
  itemWrapper: 'account',        // when the body wraps the entity
  listPath: '/api/accounts',     // needed to witness a create
  collectionKey: 'accounts',
  paging: { kind: 'page', pageSize: 100, maxPages: 50 },
  fields: ['id', 'first_name', 'status'],
  deletion: 'archive',           // or 'hard'
  environmentFingerprint: 'my-app-loopback-v1',
});
```

What the kit guarantees, so you do not have to re-derive it:

- **Paging is bounded and honest.** A walk that hits its cap with rows
  still unread fails with `result truncated` instead of returning a
  partial list — a partial list makes a created row look absent.
  Declare `paging: { kind: 'cursor' | 'page' | 'offset' }` to match
  your API.
- **Server-computed fields are declared, not hidden.** If the server
  rewrites a field the journey also typed (a derived label, a slug),
  declare it:
  ```js
  fields: ['title', 'slug'],
  volatileFields: ['slug'],
  ```
  The engine skips the exact-value echo for that field and **reports the
  skip** in the run's advisories. Drop the declaration if the app should
  store what was entered.
- **Redirects fail closed.** A read that only works through a 307/302
  throws with the `Location` it answered with. Point the path at the one
  your app really serves.
- **Logins stay in the witness environment.** Name the variables; never
  inline a credential:
  ```js
  auth: {
    kind: 'cookie-login',
    seats: { admin: {
      loginPath: '/api/admin/login',
      credentials: {
        username: 'GATEFORGE_ADAPTER_ADMIN_USER',
        password: 'GATEFORGE_ADAPTER_ADMIN_PASSWORD',
      },
    } },
    seat: 'admin',
  },
  ```
  The kit performs one login POST (the same request a browser performs)
  and then only GETs, re-logging in once on a 401. Set the variables in
  the environment that runs the gate; they never go into the repo, into
  argv, into a report, or into the suite.
- **A read that must happen inside a tenant the test just created**
  registers that tenant's login for the running session (plan Phase 4b
  item 3b), instead of reading as the fixed environment seat:
  ```js
  await evidence.registerSessionIdentity({
    seat: 'admin',
    values: {
      GATEFORGE_ADAPTER_ADMIN_USER: freshTenantUser,
      GATEFORGE_ADAPTER_ADMIN_PASSWORD: freshTenantPassword,
    },
  });
  ```
  `values` is keyed by the SAME witness env var names the seat declares
  and must carry every variable that seat declares. The registration is
  per session (it dies with the session, and a test can only register for
  its own), changes only WHO the engine reads as — the engine still
  performs every read, and a wrong tenant makes the row unfound — and the
  credential never reaches a record, the run state, a log or a report.
  A kit adapter resolves the identity by `ctx.sessionId` before the
  process-global seat, so a cookie logged in as one session is never
  served to another session's read. The full trust argument is in
  `TEST-ENVIRONMENT.md` ("Per-session login identity").
- **Fan-out collections** (members only reachable per parent) use
  `listCollection(readAll)`, which composes several paged reads.
- **A read whose entities live in the LIST the UI renders.** A real UI
  usually lists before it opens one row, so an observe read can name its
  entities in the response rows instead of in the path:
  ```js
  observe: {
    read: {
      method: 'GET',
      path: '/api/accounts',
      collection: { rowsKey: 'accounts', idKey: 'id' },
    },
  },
  ```
  `rowsKey` is optional — omit it when the response ROOT is the row
  array. The engine reads only the declared `idKey`, only out of the
  declared rows, only from the 2xx response it proxied itself, and
  credits only the entities it already held when the test session
  opened, read back through the adapter and graded as before. A count
  or total, a metadata-only body, a duplicate id, a row with no id, a
  non-JSON body, and a row created after the session opened all REFUSE
  the obligation with a typed note instead of satisfying it. It is
  opt-in: without `collection` a read binds `{id}` from the path
  exactly as before, and a collection may only be declared on a read +
  `GET` whose path carries no `{id}` — anything else is refused when
  the adapter loads. Two resources one test claims may share a route
  only by declaring the SAME shape. When they disagree, neither is read:
  the note names both declarations and no record is issued, because one
  resource's rows can never be read under another resource's
  `rowsKey`/`idKey`. With an identical shape the route is read once and
  that one response credits exactly one claim.

  **Size: a real list still proves.** A collection read is parsed from
  its OWN bounded copy of the response — up to 1 MiB and up to 10,000
  rows. A list that outgrows the engine's 16 KB response-snapshot cap
  (the tap that feeds the body digest and create attribution, itself
  unchanged) still proves: a real app's data growing must not make a
  passing test unprovable. A body or a page past those bounds is
  refused exactly as a truncated one always was — no ids, a typed note
  naming the bound and the measured size, no record. Both bounds live
  on the WITNESS side, so nothing about your adapter changes; a route
  that serves an unbounded collection should declare paging and a by-id
  read rather than rely on a larger bound.

Adapters are read-only by construction. If your app has state only the
database can answer, the frozen contract has a `probeServer` channel —
see the adapter interface doc in `@gate-forge/witness`.

### 5c. Check them

```bash
npx gateforge adapters check                       # load + validate every adapter
npx gateforge adapters check --probe \
    --base-url http://127.0.0.1:8000               # the app running: one GET each
npx gateforge enforcement doctor                   # the same audit as one summary line
```

`--probe` issues exactly one read-only GET per adapter and tells you
what actually happened: `ok`, `absent` (404), `auth` (401/403),
`fingerprint-mismatch` (GF-13), or `failed` (including a redirect-only
path). `adapters check` also lists the resources that still have no
adapter.

For a kit adapter the probe reads through the adapter's OWN seat —
same login, same cookie, same one re-login on 401 — so a collection
that only a logged-in session can read probes as `ok`, not as a 401
your correct credentials caused. When the seat's environment
variables are missing, the probe says which ones it needs (by name,
never by value) and reports `not probed` instead of inventing an
auth failure; when the app rejects the login, it names the login POST
status.

## 6. Test map

Intent is declared, proof is not:

```bash
npx gateforge tests discover            # inventory what already exists
npx gateforge tests suggest             # where existing tests may already cover
npx gateforge tests mark --test <key> --kind browser-e2e \
    --obligation tenant.accounts:persistence:read --reason "..."
```

Marking a test never satisfies an obligation; it only says which existing
test is *about* it. New proof goes in `tests/e2e/gateforge/`.

## 7. First run

```bash
npx gateforge check --changed --scope changed
```

Read the report. Every blocking entry names a cause, a why, and exactly
one `do:` line. `npx gateforge next` prints the single next action when
you want it by itself.

## 8. Hooks and CI

`gateforge init --blocking` wires the pre-commit hook and a CI workflow:

- **pre-commit** freezes the Git index, runs the gate against exactly
  those bytes, and only then lets the commit through.
- **CI** runs the same gate on the merge candidate, plus the supervised
  E2E run when the policy demands receipts.

For a quick re-check of one obligation while you work:

```bash
npx gateforge test-gates --test "creates an account" --result-only
```

## 9. What is your work, and what is Gateforge's

| Yours | Gateforge's |
| --- | --- |
| Your models, routes, and the JSON they serve | Classifying every resource and generating obligations |
| Reviewing (or writing) each evidence adapter | Loading, validating, and running adapters witness-side |
| A test environment that is isolated and seeded | Running the browser, the proxy, and the witness for you |
| Writing overlay proof in `tests/e2e/gateforge/` | Grading evidence and sealing a receipt for the exact bytes |
| Deciding policies, waivers, and baselines | Refusing to weaken any of them on its own |

## 10. The ten things that cost the first integration the most

1. **No isolated test environment.** Evidence read from a developer's
   database is a guess; reset and seed per run.
2. **No environment marker.** Without `x-gateforge-env-fingerprint` the
   witness cannot attest which environment it read.
3. **A collection read that only returns page 1.** Creates then look
   absent. Declare your paging, and read the `result truncated` error as
   the real bug it is.
4. **A collection key nobody declared.** `collectionKey` (or the
   generated `firstArrayOf`) tells the kit where the rows live.
5. **No list route at all.** Without one, a create cannot be witnessed
   (`ADAPTER_CANNOT_WITNESS`). Add the read endpoint, or bind a natural
   key with `identity: 'natural-key'`.
6. **Credentials in the repository.** They belong in the witness
   environment; the gate greps its own report for them.
7. **A field the server rewrites.** Declare it `volatileFields`, or fix
   the mutation path.
8. **A path that only works through a redirect.** Read paths must be
   the paths the app really serves.
9. **Rewriting existing journeys into the overlay.** Map them
   (`tests mark`) and add thin overlay proof only where none exists.
10. **Treating a green `check` as a receipt.** `check` is the static
    gate; a receipt comes from a witnessed `test-gates` run over the
    exact candidate bytes.

---

Next: `QUICKSTART.md` for the shortest path, `TEST-ENVIRONMENT.md` for
the environment rules, `RUNNER-NEUTRAL-EVIDENCE.md` for a non-Playwright
runner, and `UPGRADE-0.7-to-0.8.md` when you move versions.
