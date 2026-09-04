# @gateforge/cli

The gateforge command-line interface: initialize a project, discover
resources and classification signals, inspect automatic decisions, evaluate
obligations, run the gate, orchestrate test-gates evidence runs, and maintain
baselines.

## Commands

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `gateforge init [--languages <comma,list>]` | Create `.gateforge.yml`, `.gateforge/policies.yml`, `.gateforge/classification-policy.yml`, `.gateforge/baselines/obligations.json`, and the `adapters/` + `waivers/` skeleton dirs. Idempotent — never overwrites existing files. Default language: `python`. Bundled detectors are preconfigured automatically for the selected Python, JavaScript, and TypeScript languages. | 0 |
| `gateforge discover [--json]` | Run every configured detector over the expanded `project.paths` and dump the resource graph (default: human listing; `--json`: GF-canonical JSON). | 0 |
| `gateforge classify [--json] [--write-snapshot <path>]` | Recompute effective classifications from detector signals and print decisions, traces, and typed blocks. Snapshots are derived review artifacts and never pipeline input. | 0/1/2 |
| `gateforge explain <resourceId> [--json]` | Show one resource's detector signals, classification rules, decision fingerprint, typed blocks, and generated obligations. | 0/1/2 |
| `gateforge obligations [--json]` | Evaluate policies against the automatically classified graph and dump obligations, blocking entries, and claim assessments. | 0/1/2 |
| `gateforge check [--changed] [--format text\|json\|sarif]` | The full gate: discover → classify → obligations → claims → verdicts → report. `--changed` restricts the gate to files the resolved diff provider reports (see below). `--format` default `text`. Verifier key via `GATEFORGE_WITNESS_VERIFIER_KEY` env (see trust model). | 0 clean/waived, 1 unresolved, 2 config/usage |
| `gateforge test-gates [--suite <cmd>] [--out <dir>] [--format F] [--witness-url <url>] [--run-token <token>]` | Orchestrate an evidence run: materialize the run state, optionally run the suite, evaluate its claims/records, and report. A nonzero suite exit fails the run. Verifier key via `GATEFORGE_WITNESS_VERIFIER_KEY` env. | 0/1/2 (suite failure forces 1) |

Global flags: `--help`, `--version`. Exit codes per architecture contract 4:
`0` clean/waived, `1` unresolved obligations, `2` config/usage error.

## Configuration

`.gateforge.yml` is loaded fail-closed from the working directory (the repo
root); see `@gateforge/core` for the pinned schema. All paths are
repo-root-relative. `changed.provider: auto` (the default) picks
`github-pr` when `GITHUB_BASE_REF` is set, `gitlab-mr` when
`CI_MERGE_REQUEST_DIFF_BASE_SHA` is set, else `local-staged`
(`git diff --cached --name-only`). `clock.mode: fixed` freezes the run
instant for deterministic reports; `system` (default) freezes it at run
start.

## Plugin invocation

Every configured plugin runs over the same expanded include path list
(`project.paths.include` minus `exclude`; `.git` and `node_modules` are
never scanned):

- **subprocess** (GPP/3): `command` argv is spawned via
  `@gateforge/plugin-protocol`'s `PluginSession` — pinned handshake, one
  lock-step `discover`, shutdown handshake, fail-closed on any protocol
  violation. Plugins run without network.
- **in-process**: `module` is dynamically imported and its *default
  export* must provide `discover(paths)` returning
  `{resources, unresolved, findings}` in the pinned discovery shape.
  Relative module specifiers resolve against the repo root; the result is
  schema-validated and fails closed on invalid output.

The plugin's `discover` receives repo-relative file paths; in-process
plugins resolve them against the process working directory, which for a
CLI run is the repo root.

## test-gates protocol (G6 surface)

`gateforge test-gates` writes a run state directory (default
`.gateforge/test-gates/`, `--out` overrides):

| File | Content |
| --- | --- |
| `manifest.json` | Pin #4 RunManifest (runId, injected-clock startedAt, gitSha, provider, plugin registrations). At shutdown the witness appends `recordIds` + `recordIdsMac`. |
| `obligations.json` | Every obligation the suite must cover, with pin #2 fingerprint and resource source/location. |
| `env.json` | `GATEFORGE_RUN_ID`, `GATEFORGE_RUN_TOKEN`, `GATEFORGE_STATE_DIR`, `GATEFORGE_OBLIGATIONS`, `GATEFORGE_WITNESS_URL`. |
| `claims.json` / `records.json` | Reporter output consumed by the verifier (written by the suite). |
| `report.json` | Canonical json-format run report after evaluation. |

The suite command (`--suite`) runs with those env vars; its reporter
extracts claims from `{type: 'gateforge', description: '<obligation id>'}`
annotations and posts evidence through the witness service (pin #7, header
`x-gateforge-run: <token>`; `GATEFORGE_WITNESS_URL` is set when a witness
service URL is provided via `--witness-url`). `gateforge check` reads the
same state directory for claims and records. Records whose provenance does
not verify never satisfy (GF-23).

### Provenance trust model (GF-23, audited 2026-08-31, three rounds)

`records.json` and `manifest.json` live in the suite-writable state
directory, so NEITHER proves anything on its own: a hostile suite can
fabricate records (the id hash `recordIdOf` is public) and can write any id
list into the manifest. Two layers close this.

**Layer 1 — trust follows origin.** A record's `origin` is part of its
hashed identity:

- `suite-submitted` (`ui.action`, `ui.visible-result` POSTed by the
  suite): the witness RECEIVED the assertion but cannot verify it
  happened — the suite owns the browser and holds the run token. These
  records are stamped `trust: 'claimed'` at issuance and only ANCHOR a
  claim (entity + operation).
- `engine-observed` (`persistence.entity`, stamped by the witness from
  its own adapter read): the only `trust: 'witnessed'` origin. This is
  where `satisfied` is earned — the engine requires a witnessed
  persistence record for the claimed entity, so fabricated outcomes can
  never satisfy.

Residual (documented, not eliminable without a witness-side observation
channel such as a witness-driven browser): the SUITE-ASSERTED part of a
flow — that a UI action happened at all — rests on the suite's word; what
is provable is that the claimed end-state genuinely exists.

**UI-semantic `crud:*` contracts fail closed (audit round 5).** No
witness-controlled UI observation channel exists (the suite owns the
browser), so a claimed UI action can never be verified. The gradable
surface is the lifecycle-gated `persistence:*` namespace, graded on the
witness's OWN engine-side observation
(`{resourceId, entityId, found, fields, before}`) with expectations that
NEVER come from the tested suite:

- `persistence:create`: an engine-side id-set PRE-OBSERVATION (`POST
  /witness/pre-observation`, backed by the adapter's optional `list`)
  shows the entity absent before the action; the post-read shows it
  present.
- `persistence:update`: an engine-side entity pre-observation exists,
  the engine observed an actual before/after field delta, AND the delta
  touches at least one classification-declared `updateableFields` entry
  (audit round 6) — bookkeeping drift such as `updated_at` alone never
  satisfies, and a resource whose classification omits
  `updateableFields` fails closed for update obligations.
- `persistence:read`: the entity is present in the engine-observed state.
- `persistence:delete`: a hard delete observes the entity ABSENT; an
  archive observes it present and matching the classification's
  owner-declared `archiveFields` (e.g. `{status: archived}`) — the suite
  cannot bless an unarchived entity by declaring its current state as
  the expected result.

Presence alone, contradicted observations, missing pre-observations, or
absent deltas grade `invalid` — even when every provenance check passes.
True UI observation (witness-driven browser) is roadmap work.

**Layer 2 — authenticated issuance.** A witnessed record additionally
requires its id to appear in a set whose integrity is protected by the
witness **verifier key** — an orchestrator secret the suite never
receives:

- the manifest append, whose `recordIdsMac` (HMAC-SHA256 over canonical
  `{runId, recordIds}`) must verify — and whose `recordIds` the witness
  replaces with EXACTLY its own ledger at shutdown (pre-seeded forged
  ids are discarded, never signed), or
- a live `GET /ledger-attestation` response the CLI fetched (and
  MAC-verified) from a still-running wired witness during `test-gates`
  (401 to the run token alone).

The key travels by ENVIRONMENT (`GATEFORGE_WITNESS_VERIFIER_KEY`),
never argv — `/proc/<pid>/cmdline` is world-readable. `test-gates`
strips the var from the suite child's environment so a suite cannot
inherit it. Residual: a same-uid process can read environ when yama
`ptrace_scope=0`; for strong isolation run the suite as a distinct user
or container.

Fail closed: without the key, or when neither authenticated set
verifies, every witnessed record demotes to claimed-tier (blocking,
never satisfied). The record's `runId` must also equal the manifest's
(or the live attestation's) `runId`, so sets cannot be transplanted
across runs.

## Development

```bash
npm test              # workspace-wide (vitest projects)
npm run build         # compile to dist/ (dependency order: core → plugin-protocol → cli)
node bin/gateforge.js --help
```