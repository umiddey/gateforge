# @gate-forge/pack-task

Background-task discovery pack: a pure-TypeScript GPP/3 in-process detector that finds background-task signatures in `.ts`/`.js`/`.mjs` source — no Python subprocess, no execution, no external deps — plus an audit-trail entity-adapter schema and an example server that proves the five obligation contracts the pack claims.

## How discovery works

The detector scans `.ts`/`.tsx`/`.js`/`.mjs` files with regex-based AST-light patterns (matching `pack-auth`'s strategy). It recognizes the task constructs below and reports its verdict through the discovery outcome's typed blocking vocabulary — the pack emits no resources and no classification signals of its own:

| Source construct | Recognized as |
| --- | --- |
| `new Queue('email.send', ...)` / `new BullMQ.Queue(...)` | BullMQ task + retry policy from `defaultJobOptions` |
| `new Bee('image.resize', ...)` | Bee-Queue task |
| `register('webhook.dispatch', handler)` | custom-queue task (single-line) |
| `new CustomQueue({ name, handler, ... })` | custom-queue task (multi-line, balanced-brace walk) |
| `navigator.serviceWorker.register(...)` / `*.serviceWorker.register(...)` / `serviceWorkerRegistration.register(...)` / `workbox.*` / `caches.*` / `window.*` / `document.*` | nothing — browser/platform registration APIs, never task queues (excluded before matching). The receiver chain is rebuilt across MULTI-LINE call expressions too, so `navigator.serviceWorker` on its own line above the `register(...)` continuation line is still excluded (the exact unified-dogfood false positive) |
| `onmessage = handler` / `.on('message', ...)` / `addEventListener('message', ...)` | message-handler task |
| `setInterval(handler, ms, ...)` / `setImmediate(handler, ...)` | recurring task |
| `@Task(...)` / `@Queue(...)` decorator annotations | decorator task |

### Classification signals (phase 4): none

The pack mints **no** `classificationSignals`. It once emitted
`internality`/`worker` reachability signals targeted at model names
GUESSED from the worker file (model/repository import-path segments,
every PascalCase identifier, stripped task-name fragments). Those
targets are guesses about OTHER detectors' resources — this pack
discovers no resources itself — so in real repos they mostly matched
nothing and every miss surfaced as a `STALE_SIGNAL_TARGET` blocker
(236 in the unified dogfood) while adding no information: unknown
exposure already defaults user-facing and unknown lifecycle already
defaults enabled (ADR 0003 D5), so removal flips no classification and
shrinks no obligation set. Core's `STALE_SIGNAL_TARGET` detection
remains for genuinely stale authority signals. The
`trustedInternalEntryPoints` worker category binding
(`detector: gateforge.pack-task`) stays syntactically valid but is
unexercised: internality certification that relied on guessed worker
reachability is now honestly unavailable
(`INCOMPLETE_PROOF_SCOPE`, conservative user-facing default) instead
of guess-based.

### Detector vocabulary

- **Recognized task inventory** — each recognized construct carries:
  - `retryPolicy: { maxAttempts: number, backoff: 'fixed' | 'exponential' }` — extracted from `defaultJobOptions.attempts` / `.backoff.type`, defaults to `{maxAttempts: 1, backoff: 'fixed'}`.
  - `idempotencyKey: boolean` — true if `jobId` / `dedupKey` / `idempotencyKey` / `dedupe` appears in source.
  - `terminalOn: string[]` — error types from `terminalOn: [...]` (terminal = no retry).
  - `observability: boolean` — true if `metrics` / `tracing` / `.on('completed'|'failed'|'stalled', ...)` appears.
  - `source: { file, line, col }` — declaration location.
  - `framework: 'bullmq' | 'bee-queue' | 'custom-queue' | 'message-handler' | 'recurring' | 'decorator'`.

  The inventory itself is not emitted on the wire (no resources, no
  signals — phase 4); it drives the blocking vocabulary below and the
  obligation contracts the pack claims.

- **Findings**
  - `DUPLICATE_TASK_ID` — same id discovered twice; first wins.
  - `AMBIGUOUS_HANDLER` — `register(...)` or `new CustomQueue(...)` with no resolvable handler reference. For the single-line `register(...)` shape this fires only when the file shows real queue evidence (an import from a known queue library — `bullmq`, `bull`, `bee-queue`, `celery`, `kue`, `agenda`, `pg-boss`, `sidekiq` — a queue-named module, or a queue constructor such as `new Queue(...)` / `new CustomQueue(...)`).
  - `PARSE_ERROR` — file could not be read.

- **Unresolved**
  - `UNPROVEN_QUEUE_REGISTRATION` — a handler-less `register('name')` in a file with no queue evidence: the shape is not provably a task registration, so the detector emits no worker signal and reports this typed blocking reason instead of the vague `AMBIGUOUS_HANDLER` finding (a browser service-worker registration produces nothing at all).

## Obligation contract vocabulary

Five contracts, every detected task generates all of them:

| Contract | Meaning | Example test in `example/task/` |
| --- | --- | --- |
| `task:retry-policy-enforced` | flaky task retries up to `maxAttempts` before final failure | flaky profile, 5 attempts before success |
| `task:idempotent` | same idempotency key is deduplicated | duplicate profile, side-effect runs once |
| `task:terminal-handled` | errors whose type is in `terminalOn` are NOT retried | terminal profile, 1 attempt only |
| `task:observability-recorded` | every execution (success + failure) emits an audit row in `runs.json` | every profile |
| `task:duplicate-delivery-handled` | duplicate deliveries produce exactly one side effect | duplicate profile |

The full obligation id is `<resourceId>:<contract>` — e.g.
`task.email.send:task:retry-policy-enforced`.

## Setup

```yaml
# .gateforge.yml
plugins:
  - id: gateforge.pack-task
    version: 0.1.0
    transport: in-process
    module: '@gate-forge/pack-task'
```

The pack's default export is the pinned `{ discover(paths) }` contract.

## Entity adapter schema + audit trail

Every detected task generates `runs.json` audit rows when run against the example server. The witness reads them via the adapter contract:

```ts
{
  resourceId: 'task.runs',
  read(ctx, id)         -> Promise<{ runId, attempts, sideEffectCount, terminal, ... }>,
  normalize(body)       -> { entityId, fields: { id, retries, sideEffectCount, terminal } },
  deletion: 'archive',
  environmentFingerprint: 'task-loopback-v1',
}
```

`TaskAuditAdapterSchema` + `validateTaskAuditAdapter` (mirrors
`pack-sqlalchemy`'s `EntityAdapterSchema`) enforce the contract
fail-closed.

## Example app

`example/task/server.js` (port 3004, `node:http` only):

| Route | Method | Behaviour |
| --- | --- | --- |
| `/health` | GET | `{ ok: true }` |
| `/tasks` | GET | list of registered task names |
| `/enqueue` | POST | `{ name, key?, profile, payload }` — enqueues a task |
| `/runs` | GET | audit trail (`runs.json`) |

Profiles:
- `flaky` — fails on attempts `1..maxAttempts-1`, succeeds on the last
- `duplicate` — always succeeds; same `key` is deduped
- `terminal` — throws `AuthError` immediately; no retry
- `normal` — always succeeds

Usage:
```sh
node example/task/server.js --port 3004
```

## Adversarial coverage

| Case | Behaviour asserted in `test/e2e.test.ts` |
| --- | --- |
| (a) flaky | 5 attempts, last attempt succeeds, 4 retry rows + 1 success row |
| (b + e) duplicate | same key deduped, `sideEffectCount` stays at 1 across two calls |
| (c) terminal | 1 attempt only, no retry, `terminal: true` |
| (d) observability | every enqueue appends to `runs.json` |
| (i) fake-green idempotent | `sideEffectCount` ≠ 2 on duplicate key (regression line) |
| (ii) fake-green terminal-handled | terminal does NOT retry (regression line) |

## Determinism

Same input paths + same file bytes → byte-identical discovery output:
no `Date.now()` / `Math.random()`; every array sorted; every name a
literal from the source; fixed key order on the wire.

## Development

```sh
npm test                    # vitest run
npm run typecheck
npm run build               # tsc → dist/
node ../example/task/server.js --port 3004  # ad-hoc serve
```