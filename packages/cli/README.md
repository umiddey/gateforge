# @gateforge/cli

The gateforge command-line interface: initialize a project, run detectors,
evaluate obligations, run the gate, orchestrate test-gates evidence runs,
and maintain baselines.

## Commands

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `gateforge init [--languages <comma,list>]` | Create `.gateforge.yml`, `.gateforge/policies.yml`, `.gateforge/classifications.yml`, `.gateforge/baselines/obligations.json`, and the `adapters/` + `waivers/` skeleton dirs. Idempotent — never overwrites existing files. Default languages: `python`. | 0 |
| `gateforge discover [--json]` | Run every configured detector over the expanded `project.paths` and dump the resource graph (default: human listing; `--json`: GF-canonical JSON). | 0 |
| `gateforge obligations [--json]` | Evaluate policies against the graph and dump obligations, blocking entries, and claim assessments. | 0 |
| `gateforge check [--changed] [--format text\|json\|sarif]` | The full gate: discover → obligations → claims → verdicts → report. `--changed` restricts the gate to files the resolved diff provider reports (see below). `--format` default `text`. | 0 clean/waived, 1 unresolved, 2 config/usage |
| `gateforge test-gates [--suite <cmd>] [--out <dir>] [--format F] [--witness-url <url>]` | Orchestrate an evidence run: materialize the run state, optionally run the suite, evaluate its claims/records, and report. A nonzero suite exit fails the run. | 0/1/2 (suite failure forces 1) |
| `gateforge baseline update <fingerprint...>` | Shrink the baseline to the given fingerprints (strict subset only, invariant 4). Rejections are exit 2. | 0, 2 |

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

- **subprocess** (GPP/2): `command` argv is spawned via
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
| `manifest.json` | Pin #4 RunManifest (runId, injected-clock startedAt, gitSha, provider, plugin registrations). |
| `obligations.json` | Every obligation the suite must cover, with pin #2 fingerprint and resource source/location. |
| `env.json` | `GATEFORGE_RUN_ID`, `GATEFORGE_RUN_TOKEN`, `GATEFORGE_STATE_DIR`, `GATEFORGE_OBLIGATIONS`, `GATEFORGE_WITNESS_URL`. |
| `claims.json` / `records.json` | Reporter output consumed by the verifier (written by the suite). |
| `report.json` | Canonical json-format run report after evaluation. |

The suite command (`--suite`) runs with those env vars; its reporter
extracts claims from `{type: 'gateforge', description: '<obligation id>'}`
annotations and posts evidence through the witness service (pin #7, header
`x-gateforge-run: <token>`; `GATEFORGE_WITNESS_URL` is set when a witness
service URL is provided via `--witness-url`). `gateforge check` reads the
same state directory for claims and records. Records without
service-issued provenance never satisfy (GF-23).

## Development

```bash
npm test              # workspace-wide (vitest projects)
npm run build         # compile to dist/ (dependency order: core → plugin-protocol → cli)
node bin/gateforge.js --help
```