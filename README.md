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
| [`packages/core`](packages/core) | `@gateforge/core` — artifact schemas (zod), GF-canonical-JSON + fingerprints, config loading; later: resource graph, policy engine, verdicts, baselines, waivers, reports |
| [`packages/plugin-protocol`](packages/plugin-protocol) | `@gateforge/plugin-protocol` — GPP/2 host (TS) + reference client (py): newline JSON, 8 MiB line cap, digest-checked envelopes |
| [`packages/cli`](packages/cli) | `@gateforge/cli` — bin `gateforge`: `init`, `discover`, `obligations`, `check [--changed]`, `test-gates`, `baseline update` |
| [`packages/pack-sqlalchemy`](packages/pack-sqlalchemy) | `@gateforge/pack-sqlalchemy` — Python SQLAlchemy detector plugin + TS registration + classification workflow |
| [`packages/pack-playwright`](packages/pack-playwright) | `@gateforge/pack-playwright` — witness service, evidence reporter, provenance stamping |
| `example/` | Isolated demo app (plain node http server, accounts CRUD + archive) used by the e2e gate |

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Core engine (schemas, graph, policy, verdict, baselines, waivers, reports) | in progress |
| 2 | CLI (`gateforge` bin: check, discover, baseline update) | in progress |
| 3 | SQLAlchemy CRUD pack | in progress |
| 4 | Playwright evidence pack + witness service | in progress |
| 5 | Aetherios dogfood migration | blocked on human decisions (out of scope) |

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
gates, deterministic offline runs.

## Documentation

- Plan: `docs/plans/immediate/20260830_2002_gateforge_test_obligation_engine.md`
- Decisions: `docs/decisions/0001-ontology.md`, `docs/decisions/0002-plugin-boundary.md`
- Adversarial fixtures: `docs/research/adversarial_fixture_suite.md`
