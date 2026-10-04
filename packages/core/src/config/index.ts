/**
 * `.gateforge.yml` loading and validation (pin #6).
 *
 * Fail-closed by design: a missing file, unparsable YAML, an unknown
 * `schemaVersion`, or any schema violation raises
 * {@link GateforgeConfigError} carrying actionable diagnostics — each
 * with the source file, a JSON path, and expected-vs-got detail.
 * Exit code for this failure class is 2 (config/usage error).
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { SchemaVersionField, TransportSchema } from '../schemas/common.js';
import { CoveragePolicySchema } from '../schemas/coverage-policy.js';
import { QueueObserverConfigSchema } from '../schemas/queue-observer.js';
import { z } from 'zod';
import { StrictnessModeSchema } from '../strictness.js';
import { bindQueueObserver } from '../verdict/pack-verifiers.js';

/**
 * A plugin entry in `.gateforge.yml`. Unlike a run-manifest plugin
 * registration, a config entry also declares HOW to launch the plugin:
 * `subprocess` plugins get `command` (argv, run without network);
 * `in-process` plugins get `module` (a TS module specifier).
 */
export const ConfigPluginSchema = z
  .object({
    /** Plugin id, e.g. `gateforge.pack-sqlalchemy`. */
    id: z.string().min(1),
    /** Declared plugin version (handshake-checked at spawn, pin #5). */
    version: z.string().min(1),
    /** Transport over the plugin boundary (ADR 0002). */
    transport: TransportSchema,
    /** argv to spawn (subprocess transport only), executed with no network. */
    command: z.array(z.string().min(1)).min(1).optional(),
    /** Module specifier to import (in-process transport only). */
    module: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((plugin, ctx) => {
    // Issuer reservation (ADR 0003 D2/D6): `gateforge.core` is the
    // ENGINE's suppressive-signal authority. A plugin configured under
    // that id would let ordinary plugin output forge engine-issued
    // declarations, so the id is reserved at config validation — the
    // engine is not a configurable plugin.
    if (plugin.id === 'gateforge.core') {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message:
          "plugin id 'gateforge.core' is reserved: suppressive classification authority is engine-issued, never plugin-issued",
      });
    }
    if (plugin.transport === 'subprocess') {
      if (plugin.command === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['command'],
          message: `subprocess plugin '${plugin.id}' requires 'command' (argv to spawn)`,
        });
      }
      if (plugin.module !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['module'],
          message: `subprocess plugin '${plugin.id}' must not declare 'module' (in-process only)`,
        });
      }
    } else {
      if (plugin.module === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['module'],
          message: `in-process plugin '${plugin.id}' requires 'module' (module specifier to import)`,
        });
      }
      if (plugin.command !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['command'],
          message: `in-process plugin '${plugin.id}' must not declare 'command' (subprocess only)`,
        });
      }
    }
  });

/** Inferred config-plugin shape. */
export type ConfigPlugin = z.infer<typeof ConfigPluginSchema>;

/**
 * True when one declared glob is a usable repo-root-relative POSIX
 * pattern: not absolute, no Windows drive, no backslash, and no
 * `..` segment. A path that escapes the repo root is never a
 * declaration Gateforge can evaluate against a tree path, so it must
 * fail the config load rather than silently match nothing.
 */
function isRepoRelativeGlob(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '..' || segment === '');
}

/**
 * Enforcement-mode configuration (plan 2026-09-13 §3.4/§3.3, ADR 0005
 * D1/D4). OPTIONAL and off by default — enabling strict E2E is an
 * explicit, tracked owner decision.
 */
export const EnforcementConfigSchema = z
  .object({
    /**
     * `standard` = local hook + mandatory trusted server check (honest
     * about --no-verify); `managed` = authoritative commit broker outside
     * the agent's write/process boundary. Later phases enforce this; the
     * value is recorded here from Phase 0 on.
     */
    mode: z.enum(['standard', 'managed']).default('standard'),
    /**
     * Strict E2E mode (plan §3.3): when true, a waived or baselined
     * in-scope E2E obligation is NOT proof and cannot authorize the
     * change — the gate reports it blocking (ENFORCEMENT_UNTRUSTED), and
     * required contracts whose proof channel is unavailable fail the
     * setup closed (preflight capability validation).
     */
    strictE2E: z.boolean().default(false),
    /**
     * The OWNER-APPROVED policy revision digest (ADR 0005 D6 enforcement):
     * the `trustedPolicyDigest` value the owner pinned as the approved
     * policy revision. Gates compare the candidate's recomputed digest
     * against it, so a candidate that edits classifiers, exclusions,
     * waivers, baselines, or coverage cannot authorize its own weaker
     * checks.
     *
     * TRUST BOUNDARY: this value must NEVER come from candidate-controlled
     * files in strict mode. It is honored only when the config document
     * carrying it lives OUTSIDE the candidate repository (loaded through
     * the explicit `GATEFORGE_TRUSTED_CONFIG` path) or when the digest is
     * provisioned through `GATEFORGE_APPROVED_POLICY_DIGEST` /
     * `--approved-policy-digest`. Declaring it in the candidate's own
     * `.gateforge.yml` is never a trusted source: strict gates block with
     * ENFORCEMENT_UNTRUSTED instead of honoring it.
     */
    approvedPolicyDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'approvedPolicyDigest must be 64-char lowercase hex')
      .optional(),
    /**
     * Stage that requires a sealed E2E receipt. Omission preserves the
     * behavior of existing configurations.
     */
    receiptStage: z.enum(['pre-push', 'pre-commit', 'ci']).optional(),
    /**
     * ADDITIVE owner switch for the test-only re-seal path: after a
     * change that touches only test code, `test-gates --changed`
     * re-runs exactly the affected tests and re-seals a receipt that
     * carries the rest from the verified parent receipt. OPT-IN in
     * EVERY mode (strict included): only `true` enables it, so a
     * repository that declares nothing — or declares `false` — keeps
     * the pre-existing full-run behavior byte for byte. The consumer
     * recomputes every re-seal from the sealed trees (design rule 8),
     * so the switch turns on a cheaper run, never a weaker check.
     */
    reseal: z.boolean().optional(),
    /**
     * ADDITIVE owner declaration beside `enforcement.reseal`: repo-
     * root-relative POSIX globs for RUNTIME STATE THE RUN ITSELF
     * REWRITES inside the repository — a witnessed login stage's
     * storage state, a runner's own cache. Such bytes are gitignored
     * workspace state, so every sealed candidate tree differs from the
     * last one in them and no re-seal could ever succeed without a
     * declaration.
     *
     * The declaration is an OWNER ASSERTION (like the documentation
     * exclusions), so it is deliberately narrow: the re-seal
     * disregards a matching changed path ONLY when the path is absent
     * from BOTH sealed commits, i.e. when it exists solely as
     * untracked/ignored workspace bytes. A tracked path never matches,
     * so a declaration can never hide a source change. The receipt
     * records what was disregarded and CI recomputes it from the same
     * globs; a difference is `EVIDENCE_STALE`.
     *
     * Absent (the default) changes nothing: the classifier disregards
     * nothing and a run is byte-identical to before.
     */
    resealRuntimeFiles: z
      .array(z.string().min(1, 'resealRuntimeFiles entries must be non-empty strings'))
      .refine((entries) => entries.every(isRepoRelativeGlob), {
        message:
          'resealRuntimeFiles entries must be repo-root-relative globs (no absolute path, no backslash, no "." or ".." segment)',
      })
      .optional(),
    /**
     * Twin path coverage (E64, additive; ABSENT = off). A raw test and
     * its witnessed twin that the catalog/test-map links are compared by
     * REQUEST SHAPE: the run reports `TWIN_PATH_DIVERGENT` when the two
     * exercised different request paths (the shared-helper-defaults bug:
     * `?tab=all` in one, `?tab=open` in the other, so "green" proved
     * nothing about the path the witnessed twin covered).
     *
     * `advisory` reports the finding and leaves the exit code alone;
     * `block` makes it a blocking entry (exit 1). Absent, no proxy is
     * wired, no shape is recorded, no finding exists, and the report is
     * byte-identical to a run without this key.
     */
    twinPaths: z.enum(['advisory', 'block']).optional(),
    /**
     * Owner-declared query keys whose VALUES a twin shape may carry
     * (`enforcement.twinQueryKeys`). Absent or empty = keys only: a
     * shape says a parameter was sent and never says what it said, so
     * no non-allowlisted value can reach a report or the state
     * directory. The default is the safe one precisely because a shape
     * list is something an owner pastes into a bug.
     */
    twinQueryKeys: z
      .array(z.string().min(1, 'twinQueryKeys entries must be non-empty query-key names'))
      .optional(),
  })
  .strict();

/** Inferred enforcement-section shape (fields defaulted when the section is present). */
export type EnforcementConfig = z.infer<typeof EnforcementConfigSchema>;

/**
 * One configured diagnostic suite (plan 2026-09-13 §3.5, phase 2 item
 * 8): an EXISTING suite the owner registers for the advisory "red means
 * inspect this" alarm. Gateforge never discovers suites on its own — no
 * directory scans, no executing commands found on disk; everything comes
 * from this explicit, tracked configuration.
 *
 * Only `pytest` is accepted today: other runners stay explicitly
 * unsupported until an adapter exists (plan phase 2 item 6) — a typo'd
 * or aspirational runner name must fail the config load, not silently
 * disable a suite.
 */
export const DiagnosticSuiteSchema = z
  .object({
    /** Suite name used in reports and commands, e.g. `backend-pytest`. */
    name: z.string().min(1),
    /** The only runner with an adapter today (fail closed otherwise). */
    runner: z.enum(['pytest']),
    /** Repo-root-relative working directory the argv runs in. */
    cwd: z.string().min(1),
    /**
     * Interpreter + args, e.g. `['python', '-m', 'pytest']`. The adapter
     * appends collection/report flags; it never executes anything beyond
     * this configured argv.
     */
    argv: z.array(z.string().min(1)).min(1),
    /**
     * Paths handed to the runner VERBATIM (suite-`cwd`-relative), e.g.
     * `['tests']`. The adapter never widens them: gateforge never scans
     * directories the owner did not name here.
     */
    testPaths: z.array(z.string().min(1)).min(1),
    /** Finite wall-clock bound for one adapter invocation (seconds). */
    timeoutMs: z.number().int().min(1),
    /**
     * WITNESSED suite (server-witnessed persistence channel; default
     * false = advisory §3.5 diagnostics). A suite marked `witnessed:
     * true` is the SUPERVISED pytest participant: it does NOT run in the
     * advisory pre-step (where every GATEFORGE_* variable is stripped and
     * results never grade) — it runs INSIDE the supervised test-gates
     * window with a run-scoped env (GATEFORGE_STATE_DIR, GATEFORGE_RUN_ID,
     * GATEFORGE_WITNESS_URL, GATEFORGE_RUN_TOKEN — never the verifier
     * key), so its persistence-intent writes reach the trusted drain and
     * the witness can stamp `channel: 'server'` evidence for the
     * server-e2e obligations its tests are mapped to. The suite itself
     * stays untrusted: it can only WRITE intents; every observation is
     * the witness's own server probe, and a failed/incomplete witnessed
     * run blocks the gate (the mapped test's red is never graded green).
     */
    witnessed: z.boolean().optional(),
  })
  .strict();

/** Inferred diagnostic-suite shape. */
export type DiagnosticSuite = z.infer<typeof DiagnosticSuiteSchema>;

/**
 * The `diagnostics` config section (plan §3.5): registered diagnostic
 * suites. ABSENT = no diagnostic suites (the default; the alarm is
 * opt-in and never a commit blocker by itself).
 */
export const DiagnosticsConfigSchema = z
  .object({
    /** Explicitly registered diagnostic suites. */
    suites: z.array(DiagnosticSuiteSchema),
    /** Opt-in host load and disk sampling for supervised runs. */
    hostLoad: z.boolean().optional(),
  })
  .strict()
  .superRefine((diagnostics, ctx) => {
    // Duplicate suite names would make `tests diagnose --suite <name>`
    // and per-suite reporting ambiguous — reject at config load.
    const seen = new Set<string>();
    for (let index = 0; index < diagnostics.suites.length; index += 1) {
      const name = diagnostics.suites[index]?.name;
      if (name === undefined) continue;
      if (seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['suites', index, 'name'],
          message: `duplicate diagnostic suite name '${name}': suite selection must be unambiguous`,
        });
      }
      seen.add(name);
    }
  });

/** Inferred diagnostics-section shape. */
/** Inferred diagnostics-section shape. */
/**
 * One declared column copy that must survive a rename.
 */
export const AlembicColumnCopySchema = z
  .object({
    /** Column present at the previous head. */
    from: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    /** Column that must carry the same fingerprint after upgrade. */
    to: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  })
  .strict();

/** One owner-declared table whose rows must survive upgrade. */
export const AlembicSeedTableSchema = z
  .object({
    /** Table name. */
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    /** Columns whose fingerprints must be stable when they exist on both sides. */
    columns: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).min(1),
    /** Optional rename copies. Absent means no rename mapping. */
    copies: z.array(AlembicColumnCopySchema).optional(),
  })
  .strict();

/**
 * One named Alembic chain. Absent `alembic` config means the pack is off.
 */
export const AlembicChainSchema = z
  .object({
    /** Stable chain name. No dots or colons (resource id segment). */
    name: z.string().regex(/^[A-Za-z0-9_-]+$/),
    /** Repo-relative versions directory. */
    migrations: z.string().min(1),
    /** Model globs. A change here without a migration blocks. */
    models: z.array(z.string().min(1)).min(1),
    /** Importable module that owns the metadata. Defaults from the first model path. */
    modelsModule: z.string().min(1).optional(),
    /** Attribute path of the MetaData object. Defaults to `Base.metadata`. */
    metadata: z.string().min(1).optional(),
    /** Repo-relative alembic.ini, recorded as an input. Defaults to `alembic.ini`. */
    alembicIni: z.string().min(1).optional(),
  })
  .strict();

/**
 * Opt-in Alembic migration obligations. Absent means a repository behaves
 * exactly as it did before this key existed.
 */
export const AlembicConfigSchema = z
  .object({
    /** Named chains. One is enough. */
    chains: z.array(AlembicChainSchema).min(1),
    /**
     * Trusted admin URL. The engine creates `gf_tmp_<id>` in this server
     * and drops it. Never taken from the test environment.
     */
    scratch: z
      .object({
        adminUrl: z.string().min(1),
      })
      .strict(),
    /** Optional data-preservation seed and declared tables. */
    seed: z
      .object({
        path: z.string().min(1),
        tables: z.array(AlembicSeedTableSchema).min(1),
      })
      .strict()
      .optional(),
    /** Owner-pinned revisions that may skip downgrade. Visible in reports. */
    irreversible: z.array(z.string().min(1)).default([]),
    /** When set, lineage and roundtrip also run on the merge with this ref. */
    merge: z
      .object({
        targetRef: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Inferred Alembic config. */
export type AlembicConfig = z.infer<typeof AlembicConfigSchema>;
export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;

/**
 * The `.gateforge.yml` document schema (pin #6). All paths are
 * repo-root-relative. Unknown keys are rejected — a typo must fail the
 * config load, not silently disable a subsystem.
 */
export const GateforgeConfigSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Project-wide discovery settings. */
    project: z
      .object({
        /** Languages detectors should run for, e.g. ['python']. */
        languages: z.array(z.string().min(1)).min(1),
        /** Path filters applied to discovery. */
        paths: z
          .object({
            /** Globs to include. */
            include: z.array(z.string().min(1)).min(1),
            /** Globs to exclude. */
            exclude: z.array(z.string().min(1)),
          })
          .strict(),
      })
      .strict(),
    /**
     * Evidence-identity exclusions (plan 2026-10-04 §2, 0.10.0). Files
     * the owner asserts cannot affect evidence identity. Deliberately
     * NOT named after `project.paths.exclude` (scan scope): this key
     * says WHAT it affects. `docs` names documentation folders, `cache`
     * names exact Python bytecode files; both keep the loader's
     * filesystem, symlink and configured-input refusals. The key lives
     * in `.gateforge.yml`, so it is inside the trusted policy digest —
     * an agent cannot widen the exclusion list without the owner
     * repinning the policy revision, exactly like the 0.9 standalone
     * declaration files were. ABSENT = nothing leaves evidence identity.
     */
    evidence: z
      .object({
        exclude: z
          .object({
            /** Repo-relative documentation folders (was `.gateforge/docs-exclusions.yml`). */
            docs: z.array(z.string().min(1)).optional(),
            /** Exact repo-relative `.pyc`/`.pyo` paths (was `.gateforge/cache-exclusions.yml`). */
            cache: z.array(z.string().min(1)).optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    /** Plugin set: subprocess (GPP/3) and in-process detectors. */
    plugins: z.array(ConfigPluginSchema),
    /** Path to the policies YAML document. */
    policies: z.string().min(1),
    /**
     * Path to the classification-policy YAML document (plan phase 5,
     * ADR 0003 D5): repository-wide deterministic classification rules.
     * Effective classifications are computed from detector signals on
     * every run; there is no manual classifications document.
     */
    classificationPolicy: z.string().min(1),
    /** Directory of reviewed evidence adapters (.mjs, engine-loaded). */
    adapters: z.string().min(1),
    /** Directory of waiver documents. */
    waivers: z.string().min(1),
    /** Path to the baseline document (`.gateforge/baselines/obligations.json`). */
    baselines: z.string().min(1),
    /**
     * Supervised run surfaces (additive, optional). `progress` selects
     * the CI progress stream: `auto` (the default) writes it to stderr
     * under CI and OFF everywhere else, so a local run's output is
     * byte-identical to a run without this key; `off`, `stderr`, or
     * `file:<path>` say so explicitly. The stream is never evidence and
     * no gate reads it.
     */
    run: z
      .object({
        /** `auto` | `off` | `stderr` | `file:<path>`. */
        progress: z.string().min(1),
        /**
         * Timing-chaos bounds (E63). The SEED is never configured here:
         * only `gateforge test-gates --chaos <seed>` switches chaos on,
         * so a repository that configures bounds without the flag runs
         * byte-identically. `maxDelayMs` caps every applied delay
         * (default 400) and `reorder` decides whether a later response
         * on one route may be released before an earlier one (default
         * on). Neither is evidence and no gate reads them.
         */
        chaos: z
          .object({
            /** Upper bound of every applied delay, in whole milliseconds. */
            maxDelayMs: z.number().int().min(0).max(5000).optional(),
            /** Whether a later response may be released before an earlier one. */
            reorder: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** Changed-file provider selection (architecture contract 5). */
    changed: z
      .object({
        provider: z.enum(['auto', 'local-staged', 'github-pr', 'gitlab-mr']),
      })
      .strict(),
    /** Witness service bounds. */
    witness: z
      .object({
        /** Upper bound for a single witness call, in seconds. */
        maxDurationSeconds: z.number().int().min(1),
      })
      .strict(),
    /** Clock selection: system time, or a fixed instant for determinism. */
    clock: z
      .object({
        mode: z.enum(['system', 'fixed']),
        /** Required with mode 'fixed'; meaningless otherwise (rejected). */
        fixedAt: z.iso.datetime().optional(),
      })
      .strict()
      .superRefine((clock, ctx) => {
        if (clock.mode === 'fixed' && clock.fixedAt === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['fixedAt'],
            message: "clock.mode 'fixed' requires 'fixedAt' (ISO-8601 instant)",
          });
        }
        if (clock.mode === 'system' && clock.fixedAt !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['fixedAt'],
            message: "'fixedAt' is only valid with clock.mode 'fixed'",
          });
        }
      }),
    /**
     * Owner-chosen gate strictness:
     * `strict` (today's behavior, also the default when this key is
     * absent), `changed` (block only on debt this change touches), or
     * `warn` (evaluate and report everything, exit 0). It changes the
     * GATE, never the evidence: counts, verdicts and cause codes are
     * identical in every mode, and the active mode is printed in every
     * report. Security-sensitive: the key lives in `.gateforge.yml`, so
     * it is inside the trusted policy digest — an agent cannot soften
     * the gate without the owner repinning the policy revision.
     */
    mode: StrictnessModeSchema.optional(),
    /**
     * Enforcement modes (plan 2026-09-13 §3.3/§3.4, ADR 0005 D1/D4).
     * ABSENT = feature off (standard mode, strict E2E off) so existing
     * configs keep their exact behavior; enabling strict E2E is opt-in.
     */
    enforcement: EnforcementConfigSchema.optional(),
    /**
     * Closed-world CRUD coverage policy (plan 2026-09-13 §3.6, ADR 0005
     * D5): tracked, owner-owned enumeration of user-facing tables with
     * required operations and owner dispositions. ABSENT/empty = feature
     * off (opt-in). Validated against the current run's resource
     * inventory on every run when present.
     */
    coveragePolicy: CoveragePolicySchema.optional(),
    /**
     * Path to the complete-behavior document (plan 2026-09-19 §4.1).
     * ABSENT preserves basic table/transport behavior. Presence enables
     * the approved case catalog; there is no warnOnly or silent fallback.
     * Convention: `.gateforge/behavior.yml`.
     */
    behaviorPolicy: z.string().min(1).optional(),
    /**
     * Engine-owned queue observer: the
     * trusted read that lets the engine grade `task:*` contracts from
     * the queue's own job state instead of the test's word. ABSENT = no
     * queue reader exists, the `task` namespace stays unavailable, and
     * every `engine-task` case blocks fail-closed — the block lives in
     * `.gateforge.yml`, so it is inside the trusted policy digest and
     * the candidate cannot point the engine at a queue it controls.
     */
    queueObserver: QueueObserverConfigSchema.optional(),
    /**
     * Registered diagnostic suites (plan 2026-09-13 §3.5). ABSENT = no
     * suites; the advisory alarm is opt-in via explicit, tracked
     * configuration — gateforge never scans for or launches anything the
     * owner did not register here.
     */
    diagnostics: DiagnosticsConfigSchema.optional(),
    /**
     * Path to the staged-runtime document (plan 2026-09-21 witnessed
     * pre-commit). Convention: `.gateforge/runtime.yml`. ABSENT = the
     * owner has not declared a staged runtime; candidate execution then
     * runs with no dependency bridge and no services (fail closed).
     * Security-sensitive: hashed into the trusted policy digest and the
     * authenticated input snapshot.
     */
    runtime: z.string().min(1).optional(),
    /** Owner-declared test environment lifecycle commands; absent means off. */
    harness: z
      .object({
        up: z.string().min(1).optional(),
        reset: z.string().min(1).optional(),
        seed: z.string().min(1).optional(),
        health: z.string().min(1).optional(),
        down: z.string().min(1).optional(),
        serviceLogs: z.object({
          command: z.string().min(1),
          services: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)).min(1),
          lines: z.number().int().min(1).max(1000).default(100),
        }).strict().optional(),
      })
      .strict()
      .optional(),
    /** Local run-history retention; absent or 'off' disables history. */
    history: z
      .object({
        retentionDays: z.union([z.literal('off'), z.number().int().min(1).max(90)]).default(14),
      })
      .strict()
      .optional(),
    /**
     * Opt-in Alembic migration obligations. ABSENT = feature off. A
     * repository without this key generates no migration obligations
     * and sees no other behavior change.
     */
    alembic: AlembicConfigSchema.optional(),
    /**
     * The test runner the supervised gate drives (plan 2026-09-25,
     * runner-agnostic evidence): `playwright` (the default and today's
     * only wired surface), `pytest`, `vitest`, or `cypress`. ABSENT
     * means `playwright`, so an existing repository parses and behaves
     * byte-identically. The key lives in `.gateforge.yml`, so it is
     * inside the trusted policy digest: switching runners is an
     * owner-approved policy-revision change, never an agent-editable
     * toggle. An unknown value fails the load through the plain
     * config-error path (exit 2).
     */
    runner: z.enum(['playwright', 'pytest', 'vitest', 'cypress']).default('playwright'),
    /**
     * Owner-declared tenant scope (plan 2026-09-25 Phase 4b item 3a).
     * The sqlalchemy pack recognizes a FIXED default list of tenant
     * scope column names (`tenant_id`, `tenant`, `tenantId`,
     * `tenant_uuid`, `tenant_key`); an application whose scope column is
     * spelled differently (`contractor_id`, `org_id`, ...) declares it
     * here so a per-tenant singleton table is still recognized. The
     * declaration REPLACES the default list — it never extends it, so
     * the recognized scope is exactly what the owner said. ABSENT = the
     * default list, byte-identical to today's behavior for every
     * repository that has no opinion. Security-sensitive: the key lives
     * in `.gateforge.yml`, so it is inside the trusted policy digest —
     * an agent cannot widen the recognized tenant scope without the
     * owner repinning the policy revision.
     */
    tenancy: z
      .object({
        /**
         * The column names that carry the tenant scope in this
         * repository. A nonempty list is required when the key is
         * present: an empty list is a claim ("nothing is tenant
         * scoped") that would silently disable the tag, so it is
         * rejected instead.
         */
        scopeColumns: z.array(z.string().min(1)).min(1).optional(),
      })
      .strict()
      .optional(),
    /**
     * Endpoint-compilation findings the owner grades rather than the
     * engine deciding alone (0.9.0, owner decision D7).
     *
     * `endpoints.unmatchedRoutes` decides whether
     * `ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED` blocks a commit. ABSENT =
     * the entries are reported as advisories and NEVER block, with a
     * banner in `check` and `next` naming the count, the first examples
     * and this exact key: an existing repository that upgrades must not
     * start blocking commits over a finding it never chose. `warn` is
     * the same non-blocking behavior once the owner has SAID so (no
     * "you have not chosen" sentence). `block` restores the strict
     * behavior, where the entry is a blocking entry like every other.
     *
     * Security-sensitive: the key lives in `.gateforge.yml`, so it is
     * inside the trusted policy digest — an agent cannot silence a
     * gate-visible finding without the owner repinning the revision. An
     * unknown value fails the load through the plain config-error path
     * (exit 2).
     */
    endpoints: z
      .object({
        /**
         * `block` = the unmatched-route entry is blocking (today's
         * 0.9.0 behavior). `warn` or ABSENT = advisory + banner, never
         * blocking.
         */
        unmatchedRoutes: z.enum(['block', 'warn']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Inferred `.gateforge.yml` shape. */
export type GateforgeConfig = z.infer<typeof GateforgeConfigSchema>;

/**
 * Inferred `.gateforge.yml` `tenancy` section (plan Phase 4b item 3a):
 * the owner-declared tenant scope columns. ABSENT means the pack's
 * default list — today's behavior, byte-identical.
 */
export type TenancyConfig = NonNullable<GateforgeConfig['tenancy']>;

/**
 * Inferred `.gateforge.yml` `endpoints` section (0.9.0, owner decision
 * D7): how the owner grades `ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED`.
 * ABSENT means the advisory + banner behavior — an existing repository
 * never starts blocking commits over a setting it never chose.
 */
export type EndpointsConfig = NonNullable<GateforgeConfig['endpoints']>;

/**
 * One actionable config diagnostic: where, what, and expected-vs-got.
 */
export interface ConfigDiagnostic {
  /** File the diagnostic came from ('<inline>' for direct parse calls). */
  file: string;
  /** JSON path into the document, e.g. `$.plugins[0].transport`. */
  jsonPath: string;
  /** What is wrong. */
  message: string;
  /** What the schema expected, when known. */
  expected?: string;
  /** What was found, rendered compactly. */
  got?: string;
}

/** Error raised for any fail-closed config problem. */
export class GateforgeConfigError extends Error {
  /** All collected diagnostics (first is the primary cause). */
  readonly diagnostics: ConfigDiagnostic[];

  /**
   * Builds the error from diagnostics.
   *
   * Args:
   *   diagnostics: nonempty list of actionable diagnostics.
   */
  constructor(diagnostics: ConfigDiagnostic[]) {
    super(formatDiagnostics(diagnostics));
    this.name = 'GateforgeConfigError';
    this.diagnostics = diagnostics;
  }
}

/**
 * Renders a diagnostic input value compactly for `got` fields.
 *
 * Args:
 *   value: the offending value from the parsed document.
 *
 * Returns:
 *   string: single-line, length-capped rendering of the value.
 */
function renderGot(value: unknown): string {
  let rendered: string;
  if (typeof value === 'string') {
    rendered = JSON.stringify(value);
  } else if (value === undefined) {
    rendered = 'undefined';
  } else {
    try {
      rendered = JSON.stringify(value) ?? String(value);
    } catch {
      rendered = String(value);
    }
  }
  return rendered.length > 80 ? `${rendered.slice(0, 77)}...` : rendered;
}

/**
 * Converts a zod issue path to a JSONPath-style string (`$.a.b[0]`).
 *
 * Args:
 *   path: zod issue path segments.
 *
 * Returns:
 *   string: JSON path with a leading `$`.
 */
export function jsonPathFor(path: PropertyKey[]): string {
  let out = '$';
  for (const segment of path) {
    out += typeof segment === 'number' ? `[${String(segment)}]` : `.${String(segment)}`;
  }
  return out;
}

/**
 * Reads the offending value out of the original document by issue path.
 * Zod v4 issues do not carry the rejected input, so we recover it here.
 *
 * Args:
 *   input: the original parsed document handed to the schema.
 *   path: zod issue path segments.
 *
 * Returns:
 *   unknown: the value at the path, or undefined when unreachable.
 */
function valueAtPath(input: unknown, path: PropertyKey[]): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/**
 * Extracts the "expected" detail from a zod issue when available:
 * enum/literal issues carry `values`, type issues carry `expected`.
 *
 * Args:
 *   issue: the zod issue.
 *
 * Returns:
 *   string | undefined: rendered expectation, when the issue has one.
 */
function expectedFromIssue(issue: z.ZodIssue): string | undefined {
  const record = issue as unknown as Record<string, unknown>;
  const values = record['values'];
  if (Array.isArray(values) && values.length > 0) {
    return values.map((value) => JSON.stringify(value)).join(' | ');
  }
  return typeof record['expected'] === 'string' ? record['expected'] : undefined;
}

/**
 * Converts zod issues into actionable config diagnostics.
 *
 * Args:
 *   error: failed zod result error.
 *   file: file name to attach to every diagnostic.
 *   input: the original parsed document, used to recover got-values.
 *
 * Returns:
 *   ConfigDiagnostic[]: one diagnostic per issue, same order.
 */
export function diagnosticsFromZodError(
  error: z.ZodError,
  file: string,
  input?: unknown,
): ConfigDiagnostic[] {
  return error.issues.map((issue) => {
    const gotValue = input === undefined ? undefined : valueAtPath(input, issue.path);
    return {
      file,
      jsonPath: jsonPathFor(issue.path),
      message: issue.message,
      expected: expectedFromIssue(issue),
      got: gotValue === undefined ? undefined : renderGot(gotValue),
    };
  });
}

/**
 * Formats diagnostics into the multi-line message users see.
 *
 * Args:
 *   diagnostics: diagnostics to render.
 *
 * Returns:
 *   string: human-readable, single-cause-first listing.
 */
export function formatDiagnostics(diagnostics: ConfigDiagnostic[]): string {
  const head =
    diagnostics.length === 1
      ? 'invalid gateforge config (1 error)'
      : `invalid gateforge config (${String(diagnostics.length)} errors)`;
  const lines = diagnostics.map((diagnostic) => {
    const parts = [diagnostic.file, diagnostic.jsonPath, diagnostic.message];
    if (diagnostic.expected !== undefined) {
      parts.push(`expected: ${diagnostic.expected}`);
    }
    if (diagnostic.got !== undefined) {
      parts.push(`got: ${diagnostic.got}`);
    }
    return `  - ${parts.filter((part) => part.length > 0).join(': ')}`;
  });
  return [head, ...lines].join('\n');
}

/**
 * Validates an already-parsed config document against the schema.
 *
 * Args:
 *   input: parsed YAML/JSON document (an unknown value).
 *   file: source file name for diagnostics (default '<inline>').
 *
 * Returns:
 *   GateforgeConfig: the validated config.
 *
 * Raises:
 *   GateforgeConfigError: on any schema violation, including unknown
 *   schemaVersion (never migrated) and unknown keys (typos fail loud).
 */
export function parseConfig(
  input: unknown,
  { file = '<inline>' }: { file?: string } = {},
): GateforgeConfig {
  // Migration diagnostic (plan phase 5): the authoritative manual
  // classifications document was removed in the automatic-classification
  // cutover. Fail with the exact migration steps, never a generic
  // unknown-key error.
  if (input !== null && typeof input === 'object' && 'classifications' in input) {
    throw new GateforgeConfigError([
      {
        file,
        jsonPath: '$.classifications',
        message:
          "config key 'classifications' was removed: classification is now automatic. " +
          "Delete the key and add `classificationPolicy: .gateforge/classification-policy.yml` " +
          '(create it with `gateforge init`); its scanRoots gate every closed-world proof. ' +
          'Per-resource entries became `gateforge classify --write-snapshot` output ' +
          '(a derived artifact — never authoritative input) or source declarations.',
      },
    ]);
  }
  const result = GateforgeConfigSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new GateforgeConfigError(diagnosticsFromZodError(result.error, file, input));
}

/**
 * Loads and validates `.gateforge.yml` from disk. Fail-closed: a missing
 * file, unparsable YAML, or schema violations all raise
 * {@link GateforgeConfigError} with actionable diagnostics.
 *
 * Args:
 *   path: config file path (default '.gateforge.yml').
 *
 * Returns:
 *   GateforgeConfig: the validated config.
 *
 * Raises:
 *   GateforgeConfigError: for missing/unreadable/unparsable/invalid config.
 */
export function loadConfig(path = '.gateforge.yml'): GateforgeConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    const hint =
      code === 'ENOENT'
        ? 'run the init command or pass an explicit config path'
        : 'check file permissions';
    throw new GateforgeConfigError([
      {
        file: path,
        jsonPath: '$',
        message: `cannot read config file (${code}); ${hint}`,
      },
    ]);
  }

  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (cause) {
    throw new GateforgeConfigError([
      {
        file: path,
        jsonPath: '$',
        message: `invalid YAML: ${(cause as Error).message.split('\n')[0] ?? 'parse error'}`,
      },
    ]);
  }

  const config = parseConfig(document, { file: path });
  // The `queueObserver` block decides whether the engine owns a queue
  // reader at all, so loading the owner's config is exactly where the
  // `task` namespace's availability is bound. A repository without the
  // block binds "none" and every task contract stays fail-closed.
  bindQueueObserver(config.queueObserver);
  return config;
}
