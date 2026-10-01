/**
 * Staged-runtime configuration schema (plan 2026-09-21 witnessed
 * pre-commit): the OWNER-REVIEWED document describing how a materialized
 * staged candidate becomes a runnable runtime — dependency preparation,
 * dependency reuse, and candidate-owned application/database/worker
 * services with readiness probes. The document is security-sensitive:
 * it participates in the trusted policy digest and the authenticated
 * input snapshot, so a candidate that edits its own runtime commands
 * cannot approve the edit in the same commit (a provisioned pin rejects
 * the self-approved revision before any test runs).
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';

/**
 * Checks that a runtime reuse path is a canonical repository-relative POSIX
 * path. Backslashes are rejected so the same document has one meaning on
 * POSIX and Windows hosts.
 *
 * Args:
 *   value: the configured reuse path.
 *
 * Returns:
 *   boolean: true when the path has no traversal, empty, or dot segments.
 */
export function isNormalizedRepoRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false;
  return segments.join('/') === value;
}

/** Schema for one dependency directory explicitly reused by a staged run. */
const RuntimeReusePathSchema = z
  .string()
  .min(1)
  .refine(isNormalizedRepoRelativePath, {
    message: 'reuse path must be a normalized repository-relative path without traversal',
  });

/** Placeholder referencing a supervisor-assigned service port. */
export const SERVICE_PORT_PLACEHOLDER = '${service:<id>:port}';

/** Placeholder referencing a supervisor-assigned service base URL. */
export const SERVICE_URL_PLACEHOLDER = '${service:<id>:url}';

/** Default budget for one preparation command, in seconds. */
export const DEFAULT_PREPARE_TIMEOUT_SECONDS = 600;

/** Default budget for one service readiness probe, in seconds. */
export const DEFAULT_READY_TIMEOUT_SECONDS = 60;

/**
 * One managed-run recipe step (managed-run plan (2026-09-29), Part B): the app-owned
 * lifecycle command Gateforge sequences for `gateforge run`. Commands
 * are argv lists (never a shell string), each step carries its own
 * timeout, and a step may be retried a bounded number of times.
 */
export const RecipeStepSchema = z
  .object({
    /** Commands to run in order; the first non-zero exit fails the step. */
    commands: z.array(z.array(z.string().min(1)).min(1)).min(1),
    /** Wall-clock budget for the whole step (default 600s). */
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    /** Extra attempts after the first failure (0 = run once, the default). */
    retries: z.number().int().min(0).max(10).optional(),
  })
  .strict();

/** Inferred recipe step shape. */
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

/** Default wall-clock budget for one managed-run recipe step, in seconds. */
export const DEFAULT_RECIPE_STEP_TIMEOUT_SECONDS = 600;

/**
 * Environment file a recipe may load, as a PATH only. An entry carrying
 * a value (`NAME=value`) is rejected: the recipe never holds secret
 * material, and `gateforge run` never prints the values it loads.
 */
export const RecipeEnvFileSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('='), {
    message: 'env_files entries are paths only — put the secret in the file, never inline',
  });


/**
 * One service readiness probe: a log line matching `log` (regex source
 * over the captured stdout+stderr) OR an `http` GET returning 2xx.
 * Exactly one kind must be declared.
 */
export const RuntimeReadinessSchema = z
  .object({
    log: z.string().min(1).optional(),
    http: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  })
  .strict()
  .superRefine((ready, ctx) => {
    const kinds = [ready.log !== undefined, ready.http !== undefined].filter(Boolean).length;
    if (kinds !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['log'],
        message: "readiness requires exactly one of 'log' (regex source) or 'http' (2xx GET url)",
      });
    }
  });

/** Inferred readiness shape. */
export type RuntimeReadiness = z.infer<typeof RuntimeReadinessSchema>;

/**
 * One candidate-owned service (application, database, worker). The
 * supervisor assigns a free loopback port per service and exposes it to
 * commands through `${service:<id>:port}` / `${service:<id>:url}`
 * placeholders (substituted into `command`, `env` values, and readiness
 * URLs BEFORE spawn). `attested` fronts the service with the gate's
 * loopback attestation proxy and REQUIRES `fingerprint` — the
 * environment marker the proxy stamps and reviewed adapters must
 * declare (GF-13). `target` marks the attested service whose proxy URL
 * becomes the run's attested target (at most one per document).
 */
export const RuntimeServiceSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'service id must be lowercase kebab-case'),
    command: z.string().min(1),
    env: z.record(z.string(), z.string()).optional(),
    attested: z.boolean().optional(),
    fingerprint: z.string().min(1).optional(),
    target: z.boolean().optional(),
    ready: RuntimeReadinessSchema,
  })
  .strict()
  .superRefine((service, ctx) => {
    if (service.attested === true && service.fingerprint === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['fingerprint'],
        message: `attested service '${service.id}' requires 'fingerprint' (the GF-13 environment marker the proxy stamps)`,
      });
    }
    if (service.target === true && service.attested !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: `service '${service.id}' marks target: true — only an attested service can be the attested target`,
      });
    }
  });

/** Inferred service shape. */
export type RuntimeService = z.infer<typeof RuntimeServiceSchema>;

/**
 * The `.gateforge/runtime.yml` document. ABSENT means the owner has not
 * declared a staged runtime: pre-commit then runs with NO dependency
 * bridge and NO services (fail closed — discovery needing installed
 * dependencies blocks honestly instead of silently reusing the
 * worktree's environment).
 */
export const RuntimeConfigSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Preparation executed INSIDE the materialized candidate checkout. */
    prepare: z
      .object({
        /** Command to run in the checkout (package-manager install, build). */
        command: z.string().min(1).optional(),
        /**
         * Managed-run preparation commands (managed-run plan (2026-09-29), Part B):
         * argv lists `gateforge run` executes before the recipe
         * lifecycle. Absent = no preparation step.
         */
        commands: z.array(z.array(z.string().min(1)).min(1)).min(1).optional(),
        /** Wall-clock budget for `gateforge run`'s preparation step. */
        runTimeoutSeconds: z.number().int().min(1).max(3600).optional(),
        /** Extra attempts of the preparation step after a failure. */
        runRetries: z.number().int().min(0).max(10).optional(),
        /**
         * Repo-relative dependency directories explicitly allowed to be
         * reused from the user repository (linked, never copied as
         * candidate source). The ONLY sanctioned dependency bridge.
         */
        reuse: z.array(RuntimeReusePathSchema).optional(),
        timeoutSeconds: z.number().int().min(1).max(3600).optional(),
        preflight: z.array(z.object({
          name: z.string().min(1),
          command: z.string().min(1),
          timeoutSeconds: z.number().int().min(1).max(3600).optional(),
        }).strict()).optional(),
      })
      .strict()
      .optional(),
    health: z.array(z.object({
      name: z.string().min(1),
      tcp: z.string().min(1).optional(),
      http: z.string().url().optional(),
      command: z.string().min(1).optional(),
      logAbsent: z.object({
        command: z.string().min(1),
        pattern: z.string().min(1),
      }).strict().optional(),
      tls: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    }).strict().superRefine((probe, ctx) => {
      const kinds = [probe.tcp !== undefined, probe.http !== undefined, probe.command !== undefined, probe.logAbsent !== undefined].filter(Boolean).length;
      if (kinds !== 1) ctx.addIssue({ code: 'custom', path: ['tcp'], message: "health requires exactly one of 'tcp', 'http', 'command', or 'logAbsent'" });
      if (probe.tls === true && probe.http === undefined) ctx.addIssue({ code: 'custom', path: ['tls'], message: "'tls' requires an 'http' health probe" });
    })).optional(),
    /** Managed-run lifecycle: start the candidate's own services. */
    services_up: RecipeStepSchema.optional(),
    /** Managed-run lifecycle: stop those services (always the last step). */
    services_down: RecipeStepSchema.optional(),
    /** Managed-run lifecycle: reset the database/state under test. */
    reset: RecipeStepSchema.optional(),
    /** Managed-run lifecycle: seed the fixture the suite expects. */
    seed: RecipeStepSchema.optional(),
    /** Managed-run lifecycle: readiness probe for the started services. */
    healthcheck: RecipeStepSchema.optional(),
    /** Environment files the recipe loads, as paths only (no values). */
    env_files: z.array(RecipeEnvFileSchema).optional(),
    /** Candidate-owned services to start, probe, and clean up. */
    services: z.array(RuntimeServiceSchema).optional(),
    /** Operator environment names allowed through to commands, services and supervised tests. */
    envAllowlist: z.array(z.string().min(1)).optional(),
    /** Whole-run execution budget handed to the supervised gate. */
    executionTimeoutSeconds: z.number().int().min(1).max(3600).optional(),
  })
  .strict()
  .superRefine((runtime, ctx) => {
    const services = runtime.services ?? [];
    const seen = new Set<string>();
    for (let index = 0; index < services.length; index += 1) {
      const service = services[index];
      if (service === undefined) continue;
      if (seen.has(service.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'id'],
          message: `duplicate service id '${service.id}' — service addressing must be unambiguous`,
        });
      }
      seen.add(service.id);
    }
    const targets = services.filter((service) => service.target === true);
    if (targets.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['services'],
        message: `at most one service may mark target: true (got ${String(targets.length)})`,
      });
    }
  });

/** Inferred runtime document shape. */
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
