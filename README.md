# Gateforge

Gateforge converts recognized source artifacts into explicit, machine-verifiable
test obligations. A source change is detected, classified, and compiled into
obligations that tests must satisfy with trusted, witness-stamped evidence —
not with unrelated clicks, assertions, or API calls. Unresolved obligations
block CI; every failure explains which detector found the resource, which
policy created the obligation, and which evidence is missing or invalid.

The core flow:

```text
Source change
  -> Detector recognizes a resource
  -> Classifier establishes resource properties
  -> Policy produces test obligations
  -> Tests declare claims against obligations
  -> Trusted adapters collect evidence
  -> Verifier returns satisfied | missing | invalid | unclassified | unresolved | waived | stale
  -> CI blocks unresolved obligations
```

CRUD coverage is the first proof case, not the final architecture. The broader
product is a user-extensible test-policy compiler: creating or modifying code
artifacts automatically creates auditable testing responsibilities.

## Package map

| Package | Purpose |
|---|---|
| [`packages/core`](packages/core) | `@gateforge/core` — artifact schemas (zod), GF-canonical-JSON + fingerprints, witness provenance verification, resource graph, policy engine, verdict engine, baselines, waivers, reports |
| [`packages/plugin-protocol`](packages/plugin-protocol) | `@gateforge/plugin-protocol` — GPP/3 host (TS) + reference client (py): newline JSON, 8 MiB line cap, digest-checked envelopes |
| [`packages/cli`](packages/cli) | `@gateforge/cli` — bin `gateforge`: `init`, `discover`, `obligations`, `check [--changed]`, `test-gates`, `baseline update` |
| [`packages/pack-sqlalchemy`](packages/pack-sqlalchemy) | `@gateforge/pack-sqlalchemy` — Python SQLAlchemy detector plugin + TS registration + classification workflow |
| [`packages/pack-playwright`](packages/pack-playwright) | `@gateforge/pack-playwright` — witness service, evidence reporter, provenance stamping |
| [`packages/pack-auth`](packages/pack-auth) | `@gateforge/pack-auth` — auth contract pack (role/tenant/forged-token obligations) + NestJS/Express/Fastify/Hono detector |
| [`packages/pack-workflow`](packages/pack-workflow) | `@gateforge/pack-workflow` — workflow contract pack (transitions, terminal immutability, audit) + XState/FSM/enum-switch detector |
| [`packages/pack-webhook`](packages/pack-webhook) | `@gateforge/pack-webhook` — webhook contract pack (HMAC signatures, replay, retry bounds) + detector |
| [`packages/pack-task`](packages/pack-task) | `@gateforge/pack-task` — task/queue contract pack (idempotency, retries, terminal handling) + BullMQ/Bee-Queue detector |
| [`packages/pack-validation`](packages/pack-validation) | `@gateforge/pack-validation` — validation contract pack (boundary reject, no side effect on reject) + zod/joi/yup/class-validator detector |
| `example/` | Isolated demo app (plain node http server, accounts CRUD + archive) used by the e2e gate |

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Core engine (schemas, graph, policy, verdict, baselines, waivers, reports) | shipped (commit 3fb49e7) |
| 2 | CLI (`gateforge` bin: check, discover, baseline update, test-gates) | shipped (commit 3fb49e7) |
| 3 | SQLAlchemy CRUD pack | shipped (commit 3fb49e7) |
| 4 | Playwright evidence pack + witness service | shipped (commit 3fb49e7); provenance hardening 2026-08-31 (see below) |
| 5 | Aetherios dogfood migration | blocked on human decisions (out of scope) |
| 6–8 | Five additional contract packs (auth, workflow, webhook, task, validation) | shipped (commit 44b25da) — detectors + example-server integration tests; engine-level grading pending per-pack semantic verifiers |

**2026-08-31 audit remediation (five rounds).** Evidence trust now rests
on two layers. First, contracts are scoped by what the engine can actually
observe. UI-semantic `crud:*` contracts FAIL CLOSED — the suite owns the
browser, so a claimed UI action can never be independently verified.
Persistence-level `persistence:*` contracts are the gradable surface
(lifecycle-gated like crud): `satisfied` requires a claimed (suite-asserted)
action anchor plus a `persistence.entity` record the witness observed itself
(`origin: 'engine-observed'`) meeting the operation's postcondition, with
expectations that NEVER come from the suite — create ⇒ engine-side
pre-observation shows the entity absent before and present after; update ⇒
an engine-observed before/after field delta; read ⇒ presence; delete ⇒
absent (hard) or matching the classification's owner-declared
`archiveFields` (archive). Second, issuance is AUTHENTICATED: the witness's
manifest append carries a verifier-key HMAC over exactly its own ledger
(pre-seeded forged ids are discarded, never signed) and the live
`GET /ledger-attestation` serves the same authenticated set; the verifier
key travels by environment (never argv — `/proc cmdline` is world-readable)
and `test-gates` strips it from the suite child's env. Without the key, or
when neither authenticated set verifies, witnessed records demote — forged
bundles cannot reach `satisfied` (GF-23). Detector findings (e.g.
`PARSE_ERROR`) and stale references block `gateforge check` and are counted
in report summaries (SARIF surfaces them as tool-execution notifications).
Non-CRUD contracts (auth/workflow/webhook/task/validation) are fail-closed
in the engine — they stay blocking `missing` until each pack ships a
semantic verifier; the packs' current suites exercise their example servers
directly, not the CLI/witness/verdict engine.

## Development

```sh
npm install        # workspaces: packages/*
npm test           # vitest across all packages
npm run build      # tsc build per package
npm run typecheck  # tsc --noEmit per package
```

Node >= 20. TypeScript strict, ESM (NodeNext). Testing follows
[`docs/testing/TESTING_POLICY.md`](docs/testing/TESTING_POLICY.md) — the
canonical policy: retries 0, no skips on required flows, red-probe proof for
gates, deterministic offline runs. Known deviation: pack-workflow carries 2
skipped cases (a shared-audit e2e flake and a malformed-FSM detector case),
documented in its test files pending fixes.

## Documentation

- Plan: `docs/plans/immediate/20260830_2002_gateforge_test_obligation_engine.md`
- Decisions: `docs/decisions/0001-ontology.md`, `docs/decisions/0002-plugin-boundary.md`
- Adversarial fixtures: `docs/research/adversarial_fixture_suite.md`
