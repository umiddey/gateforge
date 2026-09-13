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
| `gateforge check [--changed] [--format text\|json\|sarif]` | The full gate: discover → classify → obligations → claims → verdicts → report. `--changed` evaluates one effective scope: only obligations/blockers tied to files the resolved diff provider reports — unless the diff touches a gate-defining input (`.gateforge.yml`, configured policy/classification paths, planes/http-clients/fastapi configs, adapters, waivers, repo-local plugin modules, dependency manifests/lockfiles, ignore controls), which expands the run to all obligations (reported as `scope` metadata with `expandedBecause` reasons). Staged-vs-worktree mismatches under `local-staged` block with an explicit diagnostic. `--format` default `text`. Verifier key via `GATEFORGE_WITNESS_VERIFIER_KEY` env (see trust model). | 0 clean/waived, 1 unresolved, 2 config/usage |
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

## Endpoint plane rules (`.gateforge/planes.json`)

The same declarative plane document the packs apply to business tables
also carries endpoint-plane evidence. It is consumed by the endpoint
compiler (the pipeline stage that builds `http.endpoint` resources) with
the same strict reader, the same schema
(`{ rules: [{ match?, tables?, plane, reason }] }`), and the same
fail-closed posture.

**Endpoint plane rules are explicit human declarations keyed on the
router SOURCE FILE path — not automatic filename inference.** The config
IS the documented evidence (mirroring the classification policy's
declaration channels): a rule whose `match` glob (repo-root-relative,
posix, core classifier glob semantics) matches an endpoint's router file
asserts that endpoint's `plane` (`tenant` | `master` | `global`) with a
required non-empty `reason` as the review artifact. `tables` rules never
apply to endpoints — endpoints carry no table identity.

Evaluation per endpoint, deterministic and fail closed:

- **All matching rules agree** → the plane is applied as a plane-dimension
  declaration signal (`gateforge.endpoint-compiler:config`), the same
  evidence channel the classifier's inheritance pass uses, so the graph
  qualifies the endpoint id as `plane.<name>`.
- **Matching rules disagree** → a blocking `PLANE_RULE_CONTRADICTION`
  entry is emitted (the required `reason` of each matching rule rides the
  diagnostic) and NO plane is applied — never first-match-wins.
- **No rule matches** → no evidence; the endpoint stays on the existing
  channels (linked-resource inheritance, operational `global`, else
  `PLANE_UNRESOLVED`).

Interaction with the other plane channels: the config plane participates
as EVIDENCE, never as a blanket override. When the plane the classifier
would derive for the endpoint (exactly one linked business resource, or
the operational `global` rule) is already derivable from the detector
contributions and CONTRADICTS the config plane, the compiler emits both
assertions so the classifier blocks with `PLANE_CONTRADICTION`; when they
agree, one plane remains and the endpoint resolves.

Absence of `.gateforge/planes.json` is normal and byte-identical to not
having this channel; a malformed document (bad JSON, unknown keys, a rule
without `plane`/`reason`, an absolute or `..`-escaping `match`) fails the
run closed at startup (exit 2).

## test-gates protocol (G6 surface)

`gateforge test-gates` writes a run state directory (default
`.gateforge/test-gates/`, `--out` overrides):

| File | Content |
| --- | --- |
| `manifest.json` | Pin #4 RunManifest (runId, injected-clock startedAt, gitSha, provider, plugin registrations, plus the `test-gates`-minted `invocationId` and tested `inputDigest`). At shutdown the witness appends `recordIds` + the v2 `attestation` envelope (never a legacy `recordIdsMac`). |
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

**Layer 2 — versioned attestation binding evidence to tested inputs
(plan §11, F2).** A witnessed record is authorized only by ONE validated
v2 envelope that simultaneously matches its run id, the expected input
digest, the required invocation identity, and its record id:

- the durable manifest `attestation` (`attestationVersion: 2` with
  `runId`, `invocationId`, `inputDigest`, sorted unique `recordIds`, and
  `mac` — HMAC-SHA256 over the domain-tagged body
  `gateforge.ledger.v2`), written by the witness at shutdown from its
  FROZEN bound context plus EXACTLY its own ledger (pre-seeded forged
  ids are discarded, never signed), or
- the live `GET /ledger-attestation` response: the SAME signed object,
  fetched (and MAC-verified) by `test-gates` from a still-running wired
  witness and persisted into the manifest as the durable fallback
  before the witness stops (401 to the run token alone).

The `inputDigest` is a deterministic snapshot of everything the
pipeline examines (all Git-tracked files, nonignored untracked files,
configured scan inputs even when ignored, `.gateforge.yml`,
policies/classification/pack configs, adapters, local plugin modules,
manifests/lockfiles, effective obligations/classifications/routes —
`packages/cli/src/input-snapshot.ts`). A deleted file, an untracked
file, a policy edit, or a lockfile change all move the digest, so old
evidence blocks after any source/configuration change. The
`invocationId` is fresh per `test-gates` run, so a restored old bundle
cannot satisfy a new invocation. `check` (no suite) reuses a completed
signed run only for byte-identical inputs — it never equates its own
fresh manifest UUID with the evidence run UUID.

The witness never signs what a suite-writable file says: `test-gates`
binds the context with authenticated `POST /run-context` (run token
AND verifier key) BEFORE the suite starts, and the witness freezes it
in memory. Binding is allowed only before any observation or issuance;
a used witness answers 409, an identical rebind is idempotent, any
change is 409, and an unbound witness issues no attestation. A proxy
exchange in flight at bind time refuses the bind, and observations
that completed before binding are never consumable under the new
context.

The legacy v1 `recordIdsMac` (HMAC over `{runId, recordIds}` with no
digest binding) NEVER authorizes evidence — even when it verifies.
Invalid durable envelopes contribute nothing; live and durable
contexts are validated independently and never merged; mismatches
surface as explicit `evidence-context` blockers (missing vs malformed
vs forged stay distinguished) that waivers cannot hide.

The key travels by ENVIRONMENT (`GATEFORGE_WITNESS_VERIFIER_KEY`),
never argv — `/proc/<pid>/cmdline` is world-readable. `test-gates`
strips the var from the suite child's environment so a suite cannot
inherit it, and the witness binary reads it from the TRUSTED parent
env only (never argv/stdout/state/suite env). A suite-owned
Playwright global setup therefore cannot bootstrap trusted issuance
by inheriting the key — it fails closed unless an externally wired
trusted witness is provided. Residuals (not eliminable by env hygiene
alone): a same-uid process can read environ when yama
`ptrace_scope=0`, and env vars never isolate hostile same-user OS
processes — for strong isolation run the suite as a distinct user or
container. File-change capture is snapshot-based, not an OS sandbox:
it guards changes visible at capture points, not a malicious process
that changes and restores files between snapshots.

Fail closed: without the key, or when no envelope validates for the
expected context, every witnessed record demotes to claimed-tier
(blocking, never satisfied).

### Evidence migration (v1 → v2, no auto-migration)

- Existing evidence bundles need a FRESH run: there is no command
  that signs old records into the new format without observations, and
  none will be added (signing old records would certify untested code).
- Policies and waivers keep their explicit semantics: snapshot binding
  never rewrites their IDs to evade blockers.
- External witness setup: start `gateforge-witness` (or `startWitness`)
  with the run id/token from a TRUSTED parent env carrying
  `GATEFORGE_WITNESS_VERIFIER_KEY`, pass `--witness-url`/`--run-token`
  to `test-gates`, and start a FRESH witness per invocation (a witness
  used by an older invocation rejects binding with 409).
- Non-Git checkouts keep discovery but fail evidence authorization
  with a `snapshot-unavailable` diagnostic; submodules, escaping
  symlinks, and `--out` overlapping source fail closed with explicit
  diagnostics.

## Development

```bash
npm test              # workspace-wide (vitest projects)
npm run build         # compile to dist/ (dependency order: core → plugin-protocol → cli)
node bin/gateforge.js --help
```