/**
 * The evidence authority a grading pass needs (0.14 WP5).
 *
 * `check` authenticates the sealed witness records before it grades them:
 * the pre-discovery input inventory, the post-discovery stability check, the
 * input digest the records must match, and the verifier keys. `adopt` grades
 * its HTTP call findings the same way. Both call this module; the derivation
 * exists here and nowhere else.
 *
 * Without this authority `evaluateRun` discards every witness record, so the
 * HTTP call ledger is empty and no call finding can be graded.
 */
import { type GateforgeConfig } from '@gate-forge/core';
import { UsageError } from './errors.js';
import { loadCacheExclusions } from './cache-exclusions.js';
import { loadDocsExclusions } from './docs-exclusions.js';
import {
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
  type InputSnapshot,
  type SnapshotFileEntry,
} from './input-snapshot.js';
import type { PipelineResult } from './pipeline.js';
import type { RuntimeReuseMount } from './runtime-reuse.js';
import { httpRoutesView } from './state.js';
import type { VerifierKeyring } from './verifier-keys.js';

/** What the input inventory is taken over. */
export interface EvidenceScope {
  readonly cwd: string;
  readonly config: GateforgeConfig;
  readonly stateDir: string;
  readonly runtimeReuseDigest: string | null | undefined;
  readonly runtimeReuseMounts: readonly RuntimeReuseMount[];
  readonly docsExclusions: readonly string[];
  readonly cacheExclusions: readonly string[];
}

/** The pre-discovery capture, taken before `runPipeline`. */
export interface EvidencePreInventory {
  /** The pre-discovery inventory; null when the snapshot is unavailable. */
  readonly preFiles: SnapshotFileEntry[] | null;
  readonly snapshotUnavailable: boolean;
}

/** The authority derived after `runPipeline`. */
export interface EvidenceAuthority {
  /** Trusted current input digest, or null when it cannot be certified. */
  readonly expectedDigest: string | null;
  /** True when the input tree moved under discovery. */
  readonly changedInputs: boolean;
  readonly snapshotUnavailable: boolean;
  readonly currentSnapshot: InputSnapshot | null;
  /** The authentication inputs `evaluateRun` takes. */
  readonly witnessVerifierKey: string | undefined;
  readonly witnessVerifierKeys: string[] | undefined;
  readonly evidenceContext: {
    readonly expectedInputDigest: string | null;
    readonly snapshotUnavailable: boolean;
    readonly requireInvocationId: false;
    readonly changedInputs: boolean;
  };
}

/** The part of the pipeline result the input snapshot reads. */
export type EvidencePipeline = Pick<PipelineResult, 'graph' | 'policy' | 'manifest' | 'classificationsView'>;

/**
 * The scope an adoption grading pass uses: no runtime-reuse mounts (an
 * adoption run never stages a candidate checkout), the owner's documentation
 * and cache exclusions as the repository declares them.
 */
export function adoptionEvidenceScope(cwd: string, config: GateforgeConfig, stateDir: string): EvidenceScope {
  return {
    cwd,
    config,
    stateDir,
    runtimeReuseDigest: null,
    runtimeReuseMounts: [],
    docsExclusions: loadDocsExclusions(cwd, config),
    cacheExclusions: loadCacheExclusions(cwd, config),
  };
}

/** Captures the pre-discovery inventory. Call before `runPipeline`. */
export function captureEvidencePreInventory(scope: EvidenceScope): EvidencePreInventory {
  try {
    const preFiles = collectInputFiles(
      scope.cwd,
      scope.config,
      scope.stateDir,
      scope.runtimeReuseMounts,
      scope.docsExclusions,
      scope.cacheExclusions,
    );
    return { preFiles, snapshotUnavailable: false };
  } catch (error) {
    if (error instanceof SnapshotUnavailableError) {
      return { preFiles: null, snapshotUnavailable: true };
    }
    if (error instanceof UnsupportedSnapshotError) {
      throw new UsageError(`unsupported input snapshot: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Derives the authority after `runPipeline`. A changed input tree, or an
 * unavailable snapshot, leaves `expectedDigest` null: the records then fail
 * closed rather than being certified.
 */
export function deriveEvidenceAuthority(
  scope: EvidenceScope,
  pre: EvidencePreInventory,
  pipeline: EvidencePipeline,
  verifierKeyring: VerifierKeyring | null,
): EvidenceAuthority {
  let snapshotUnavailable = pre.snapshotUnavailable;
  let expectedDigest: string | null = null;
  let changedInputs = false;
  let currentSnapshot: InputSnapshot | null = null;
  if (!snapshotUnavailable) {
    try {
      const postFiles = collectInputFiles(
        scope.cwd,
        scope.config,
        scope.stateDir,
        scope.runtimeReuseMounts,
        scope.docsExclusions,
        scope.cacheExclusions,
      );
      if (pre.preFiles !== null && diffInputFiles(pre.preFiles, postFiles).length > 0) {
        changedInputs = true;
      } else {
        currentSnapshot = computeInputSnapshot({
          cwd: scope.cwd,
          config: scope.config,
          stateDir: scope.stateDir,
          classifications: pipeline.classificationsView.resources,
          obligations: pipeline.policy.obligations,
          httpRoutes: httpRoutesView(pipeline.graph),
          plugins: pipeline.manifest.plugins.map((plugin) => ({
            id: plugin.id,
            version: plugin.version,
          })),
          runtimeReuseDigest: scope.runtimeReuseDigest,
          runtimeReuseMounts: scope.runtimeReuseMounts,
          docsExclusions: scope.docsExclusions,
          cacheExclusions: scope.cacheExclusions,
        });
        expectedDigest = currentSnapshot.inputDigest;
      }
    } catch (error) {
      if (error instanceof SnapshotUnavailableError) {
        snapshotUnavailable = true;
      } else if (error instanceof UnsupportedSnapshotError) {
        throw new UsageError(`unsupported input snapshot: ${error.message}`);
      } else {
        throw error;
      }
    }
  }
  return {
    expectedDigest,
    changedInputs,
    snapshotUnavailable,
    currentSnapshot,
    witnessVerifierKey: verifierKeyring?.active.key,
    witnessVerifierKeys: verifierKeyring?.keys.map((entry) => entry.key),
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      requireInvocationId: false,
      changedInputs,
    },
  };
}
