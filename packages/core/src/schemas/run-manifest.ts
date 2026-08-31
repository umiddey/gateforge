/**
 * RunManifest schema (pin #4): identity of a single gateforge run. Every
 * verdict and every witnessed evidence record references its run.
 *
 * `startedAt` comes from the injected clock (deterministic tests), never
 * the wall clock. At shutdown the witness service appends the record ids
 * it issued to the manifest (pin #7).
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';
import { PluginRegistrationSchema } from './plugin.js';

/** Which changed-file provider backs the run (pin #5 of architecture contracts). */
export const ChangedProviderSchema = z.enum([
  'local-staged',
  'github-pr',
  'gitlab-mr',
  'all-files',
]);

/** Inferred changed-provider shape. */
export type ChangedProvider = z.infer<typeof ChangedProviderSchema>;

/** The run manifest artifact. */
export const RunManifestSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** UUIDv4 identifying this run. */
    runId: z.uuid(),
    /** Run start instant, ISO-8601, from the injected clock. */
    startedAt: z.iso.datetime(),
    /** HEAD git sha of the repo under test, or null when unavailable. */
    gitSha: z.string().regex(/^[0-9a-f]{40}$/, 'gitSha must be a 40-char lowercase sha1 hex').nullable(),
    /** Changed-file provider backing this run. */
    provider: ChangedProviderSchema,
    /** Plugin set with pinned versions (handshake identity, pin #5). */
    plugins: z.array(PluginRegistrationSchema),
    /** Disposable-environment attestation scope, or null when unset. */
    attestationScope: z.string().nullable(),
  })
  .strict();

/** Inferred run-manifest shape. */
export type RunManifest = z.infer<typeof RunManifestSchema>;
