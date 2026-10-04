# Gateforge

Gateforge converts recognized source artifacts into explicit, machine-verifiable
test obligations, and makes relevant, passing E2E checks a condition for AI
commits. A source change is detected, classified, and compiled into obligations
that a repository's EXISTING tests must satisfy with trusted, witness-stamped
evidence — not with newly generated plausible tests, labels, unrelated clicks,
or a reused old green report. Unresolved obligations block the gate; every
failure explains which detector found the resource, which policy created the
obligation, and which evidence is missing or invalid.

## Start here

- [CLI README — install and the first commands](packages/cli/README.md)
- [Connect your project](packages/cli/guides/CONNECT-YOUR-PROJECT.md)
- [Quickstart](packages/cli/guides/QUICKSTART.md)
- [Enable behavior cases (QUICKSTART §8a)](packages/cli/guides/QUICKSTART.md#8a-enable-behavior-cases) — what `init` finds, and the printed steps from a detected pack to a green gate
- [Test environment](packages/cli/guides/TEST-ENVIRONMENT.md)
- [Upgrade from 0.8 to 0.9](packages/cli/guides/UPGRADE-0.8-to-0.9.md)
- [Upgrade from 0.9 to 0.10](packages/cli/guides/UPGRADE-0.9-to-0.10.md)
- [Upgrade from 0.7 to 0.8](packages/cli/guides/UPGRADE-0.7-to-0.8.md)
- [Upgrade from 0.6 to 0.7](packages/cli/guides/UPGRADE-0.6-to-0.7.md)
- [Reference — commands, enforcement, protocols, configuration](packages/cli/guides/REFERENCE.md)
- [Changelog](CHANGELOG.md)

Usage documentation — the goal presets, the agent loop, the
supervised run, CI wiring, strictness, and the gate's
limitations — lives with the CLI:
[`packages/cli/README.md`](packages/cli/README.md) and
[`packages/cli/guides/REFERENCE.md`](packages/cli/guides/REFERENCE.md).

## Package map

| Package | Purpose |
|---|---|
| [`packages/core`](packages/core) | `@gate-forge/core` — artifact schemas (zod), GF-canonical-JSON + fingerprints, witness provenance verification, resource graph, policy engine, verdict engine + capability registry, test-catalog/mapping/coverage/receipt schemas, baselines, waivers, quarantines, strictness modes, reports |
| [`packages/plugin-protocol`](packages/plugin-protocol) | `@gate-forge/plugin-protocol` — GPP/3 host (TS) + reference client (py): newline JSON, 8 MiB line cap, digest-checked envelopes |
| [`packages/cli`](packages/cli) | `@gate-forge/cli` — bin `gateforge`: `init`, `next`, `discover`, `classify`, `explain`, `tests discover|catalog|suggest|mark|explain|diagnose`, `obligations`, `check [--changed] [--staged] [--require-e2e]`, `test-gates [--changed]`, `broker commit`, `enforcement doctor`, `baseline update` |
| [`packages/http-contract`](packages/http-contract) | `@gate-forge/http-contract` — canonical HTTP contract facts, typed block codes, deterministic frontend-call ↔ server-route join engine |
| [`packages/pack-sqlalchemy`](packages/pack-sqlalchemy) | `@gate-forge/pack-sqlalchemy` — Python SQLAlchemy detector plugin + TS registration + classification workflow |
| [`packages/pack-fastapi`](packages/pack-fastapi) | `@gate-forge/pack-fastapi` — FastAPI server-route detector (Python AST over GPP/3) |
| [`packages/pack-alembic`](packages/pack-alembic) | `@gate-forge/pack-alembic` — opt-in Alembic migration obligations (lineage, disposable-database roundtrip, data preservation) |
| [`packages/pack-http`](packages/pack-http) | `@gate-forge/pack-http` — TS route-registration detector (Express/Fastify/Hono/NestJS) + bounded frontend API-client dataflow |
| [`packages/pack-playwright`](packages/pack-playwright) | `@gate-forge/pack-playwright` — witness service, attestation proxy, trusted evidence fixture, reporter, test discovery (static + native reconciliation + pytest adapter), supervised runner |
| [`packages/pack-auth`](packages/pack-auth) | `@gate-forge/pack-auth` — auth contract pack (role/tenant/forged-token obligations) + NestJS/Express/Fastify/Hono detector |
| [`packages/pack-workflow`](packages/pack-workflow) | `@gate-forge/pack-workflow` — workflow contract pack (transitions, terminal immutability, audit) + XState/FSM/enum-switch detector |
| [`packages/pack-webhook`](packages/pack-webhook) | `@gate-forge/pack-webhook` — webhook contract pack (HMAC signatures, replay, retry bounds) + detector |
| [`packages/pack-task`](packages/pack-task) | `@gate-forge/pack-task` — task/queue contract pack (idempotency, retries, terminal handling) + BullMQ/Bee-Queue detector |
| [`packages/pack-validation`](packages/pack-validation) | `@gate-forge/pack-validation` — validation contract pack (boundary reject, no side effect on reject) + zod/joi/yup/class-validator detector |
| `example/` | Isolated demo app (plain node http server, accounts CRUD + archive) used by the e2e gate |

## Project history

Phase status and dated development notes: [`HISTORY.md`](HISTORY.md).

## Development

```sh
npm install        # workspaces: packages/*
npm test           # vitest across all packages
npm run build      # tsc build per package
npm run typecheck  # tsc --noEmit per package
```

Node >= 20. TypeScript strict, ESM (NodeNext). Testing policy: retries 0,
no skips on required flows, red-probe proof for gates, deterministic offline
runs.

Workflow test fixtures boot the real example app in an isolated child on an
OS-assigned loopback port (`listen(0)`) and give every boot its own audit
file, so parallel specs never collide on a port or on an audit log. No
consumer-facing default, port, or audit path changes.

Runner budget: the root config caps outer test-file workers at `maxWorkers: 2`
(`minWorkers: 1`). Each file worker may boot several real browser and runner
children, so a CPU-count-sized outer pool can oversubscribe the CPUs and
starve them. Files still run in parallel, two at a time. This bounds the test
runner only — no consumer-facing default, timeout, or retry changes.
