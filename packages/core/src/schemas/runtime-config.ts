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
         * Repo-relative dependency directories explicitly allowed to be
         * reused from the user repository (linked, never copied as
         * candidate source). The ONLY sanctioned dependency bridge.
         */
        reuse: z.array(RuntimeReusePathSchema).optional(),
        timeoutSeconds: z.number().int().min(1).max(3600).optional(),
      })
      .strict()
      .optional(),
    /** Candidate-owned services to start, probe, and clean up. */
    services: z.array(RuntimeServiceSchema).optional(),
    /** Operator environment variable names allowed through to commands/services. */
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
