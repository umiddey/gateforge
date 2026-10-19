# GATEFORGE.md — agent loop (written by `gateforge init`; safe to edit)

You are gated by Gateforge. Work one blocking item at a time.

## The loop

1. If blocked, run `gateforge next` (or `gateforge next --json` for machines).
2. Read the single `next:` block: `cause`, `why`, and exactly one `do:` line.
3. Do the single `do:` line. Stop. Re-run `gateforge next`.


## Setup guides

- Environment rules: `node_modules/@gate-forge/cli/guides/TEST-ENVIRONMENT.md`.
- Quickstart: `node_modules/@gate-forge/cli/guides/QUICKSTART.md`.
  (both ship with the installed CLI package)

## Proof lives in the overlay

- New proof tests go in `tests/e2e/gateforge/` (engine-driven fixture:
  `evidence.ui.*` + `persistence.verify`).
- Never rewrite existing `tests/e2e/**` journeys into `evidence.ui`.
- Never run `gateforge tests mark` as proof — mappings declare intent;
  only witnessed overlay evidence satisfies an obligation.
- `tests suggest` is inspection, not a gate.
- E2E tests take `page` and `test` only from the Gateforge fixture
  (`@gate-forge/pack-playwright/fixture`): a plain `@playwright/test`
  page reaches the app directly and bypasses the witness — the run sees
  no traffic and proves nothing.
- Claims must be literal strings in the test file or mapped in
  `.gateforge/test-map.yml`: runtime-computed annotations are invisible
  to the commit gate.

## Never self-approve

- Never edit `.gateforge/policies.yml`, `coveragePolicy`, waivers,
  baselines, or plugin lists to make the gate pass. Those are
  owner-controlled; an agent edit never authorizes weaker checks.
- `gateforge coverage draft` only PRINTS the owner draft — it never
  writes. Under `strictE2E` an absent or empty `coveragePolicy` blocks
  with `COVERAGE_POLICY_ABSENT` until the OWNER reviews the draft, pastes
  it into `.gateforge.yml`, and repins. Pasting it is the owner act, like
  every other policy edit.
- `gateforge behavior draft` only PRINTS the owner draft — it never
  writes. An undeclared endpoint stays `ENDPOINT_BEHAVIOR_MISSING`
  until the OWNER reviews the draft, fills real cases or a disposition,
  pastes it into `.gateforge/behavior.yml`, and repins.
- `gateforge disposition list` only PRINTS dispositions. It never writes.
- `operational-only` is legal only on a positively classified health/ops
  route with no business-resource link. A business link, or any unmarked
  route, stays illegal.
- Coverage dispositions are owner acts. Strict-E2E waivers are not proof.
- Dispositions may carry an `expiresAt` timer: once it passes the
  disposition is void and the gate blocks with `DISPOSITION_EXPIRED`
  until the owner renews it with `gateforge disposition extend`.
  Extending is an owner act, like every other policy edit.

## Capability gaps

- `VERIFIER_UNSUPPORTED` means no honest proof channel exists: tell the
  human (remove the contract from `.gateforge/policies.yml` or drop the
  pack). Do not invent tests for it.
- `http:frontend-request-observed` has no independent browser channel;
  transport-only `http:request-observed` is a separate, weaker opt-in.
- Observe proof (`--proof observe`): existing suite-driven browser tests
  prove persistence via the witness (proxy traffic + independent adapter
  read) once mapped `--kind observed-e2e`. Weaker than overlay by
  design — proves "the server stored it", not "the engine typed it".
