# GATEFORGE.md — agent loop (written by `gateforge init`; safe to edit)

You are gated by Gateforge. Work one blocking item at a time.

## The loop

1. If blocked, run `gateforge next` (or `gateforge next --json` for machines).
2. Read the single `next:` block: `cause`, `why`, and exactly one `do:` line.
3. Do the single `do:` line. Stop. Re-run `gateforge next`.

`next` prints ONE action — never a dump. Mapping is intent, not proof.

## Setup guides

- Environment rules: `packages/cli/guides/TEST-ENVIRONMENT.md`.
- Quickstart: `packages/cli/guides/QUICKSTART.md`.

## Proof lives in the overlay

- New proof tests go in `tests/e2e/gateforge/` (engine-driven fixture:
  `evidence.ui.*` + `persistence.verify`).
- Never rewrite existing `tests/e2e/**` journeys into `evidence.ui`.
- Never run `gateforge tests mark` as proof — mappings declare intent;
  only witnessed overlay evidence satisfies an obligation.
- `tests suggest` is inspection, not a gate.

## Never self-approve

- Never edit `.gateforge/policies.yml`, `coveragePolicy`, waivers,
  baselines, or plugin lists to make the gate pass. Those are
  owner-controlled; an agent edit never authorizes weaker checks.
- Coverage dispositions are owner acts. Strict-E2E waivers are not proof.

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
