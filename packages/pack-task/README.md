# @gateforge/pack-task

Background-task discovery pack: a pure-TypeScript GPP/2 in-process detector that finds background-task signatures in `.ts`/`.js`/`.mjs` source — no Python subprocess, no execution, no external deps — plus an audit-trail entity-adapter schema and an example server that proves the five obligation contracts the pack claims.

## How discovery works

The detector scans `.ts`/`.tsx`/`.js`/`.mjs` files with regex-based AST-light patterns (matching `pack-auth`'s strategy) and emits:

| Source construct | Emitted as |
| --- | --- |
| `new Queue('email.send', ...)` / `new BullMQ.Queue(...)` | `task.resource` with `framework: 'bullmq'` + retry policy from `defaultJobOptions` |
| `new Bee('image.resize', ...)` | `task.resource` with `framework: 'bee-queue'` |
| `register('webhook.dispatch', handler)` | `task.resource` with `framework: 'custom-queue'` (single-line) |
| `new CustomQueue({ name, handler, ... })` | `task.resource` with `framework: 'custom-queue'` (multi-line, balanced-brace walk) |
| `onmessage = handler` / `.on('message', ...)` / `addEventListener('message', ...)` | `task.resource` with `framework: 'message-handler'` |
| `setInterval(handler, ms, ...)` / `setImmediate(handler, ...)` | `task.resource` with `framework: 'recurring'` |
| `@Task(...)` / `@Queue(...)` decorator annotations | `task.resource` with `framework: 'decorator'` |

### Detector vocabulary

- **Business task resource** — `kind: "task.resource"`, identity in
  `attributes.taskName`, plus:
  - `retryPolicy: { maxAttempts: number, backoff: 'fixed' | 'exponential' }` — extracted from `defaultJobOptions.attempts` / `.backoff.type`, defaults to `{maxAttempts: 1, backoff: 'fixed'}`.
  - `idempotencyKey: boolean` — true if `jobId` / `dedupKey` / `idempotencyKey` / `dedupe` appears in source.
  - `terminalOn: string[]` — error types from `terminalOn: [...]` (terminal = no retry).
  - `observability: boolean` — true if `metrics` / `tracing` / `.on('completed'|'failed'|'stalled', ...)` appears.
  - `source: { file, line, col }` — declaration location.
  - `framework: 'bullmq' | 'bee-queue' | 'custom-queue' | 'message-handler' | 'recurring' | 'decorator'`.

- **Findings**
  - `DUPLICATE_TASK_ID` — same id discovered twice; first wins.
  - `AMBIGUOUS_HANDLER` — `register(...)` or `new CustomQueue(...)` with no resolvable handler reference.
  - `PARSE_ERROR` — file could not be read.

## Resource id shape

`task.<name>` where `<name>` is the literal extracted from the source.
Examples: `task.email.send`, `task.billing.refund`, `task.image.resize`.

## Obligation contract vocabulary

Five contracts, every detected `task.resource` generates all of them:

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
    module: '@gateforge/pack-task'
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