import { type GateforgeConfig, type HttpRouteCandidate, type Obligation } from '@gateforge/core';
/** Snapshot format version hashed into every digest. */
export declare const INPUT_SNAPSHOT_VERSION = 1;
/**
 * Verification format bound into the digest: the verdict semantics this
 * digest authorizes evidence for. A future semantics change must mint a
 * new constant — never silently reauthorize old digests.
 */
export declare const GATEFORGE_VERIFIER_FORMAT = "gateforge.verdict.v1";
/** Known pack configuration files (absence is an explicit entry). */
export declare const PACK_CONFIGS: string[];
/**
 * Well-known dependency manifests/lockfiles: included explicitly when
 * present on disk (they can change detector/verifier behavior even when
 * a scan glob ignores them). Absent names produce no entry.
 *
 * Phase 7 reuses the basenames for changed-scope expansion (a manifest
 * at any depth is gate-defining), so this list is the single source of
 * truth — do not maintain a second manifest list elsewhere.
 */
export declare const MANIFEST_NAMES: string[];
/**
 * Git ignore/scope-control basenames: a change to any of these at any
 * depth can change the source inventory itself. The file bytes are
 * covered by the Git inventory above; Phase 7 reuses these basenames
 * for changed-scope expansion, so this list is the single source of
 * truth — do not maintain a second ignore-control list elsewhere.
 */
export declare const GIT_SCOPE_CONTROL_BASENAMES: string[];
/**
 * The input tree cannot be captured completely (submodule, escaping or
 * unresolvable symlink, unreadable required input). Evaluation must fail
 * closed with an explicit unsupported-snapshot block — never a partial
 * digest claimed complete.
 */
export declare class UnsupportedSnapshotError extends Error {
    constructor(message: string);
}
/**
 * No usable Git inventory exists (non-Git checkout, missing binary).
 * Discovery may still work, but evidence authorization fails closed
 * with a snapshot-unavailable diagnostic.
 */
export declare class SnapshotUnavailableError extends Error {
    constructor(message: string);
}
/** One snapshotted input file. */
export interface SnapshotFileEntry {
    /** Repo-root-relative posix path (or config-relative label for absence). */
    path: string;
    /** `file` = regular bytes, `symlink` = link+target bytes, `absent` = missing optional config, `deleted` = tracked but gone. */
    type: 'file' | 'symlink' | 'absent' | 'deleted';
    /** Hex digest binding path + type + content (or absence marker). */
    contentDigest: string;
}
/** Canonical gate context hashed alongside the file inventory. */
export interface SnapshotGateContext {
    /** Curated config subset (paths, plugins, scan roots, witness/clock bounds). */
    config: unknown;
    /** Pinned plugin registrations, sorted by id. */
    plugins: Array<{
        id: string;
        version: string;
    }>;
    /** Effective classifications keyed by plane-qualified id, sorted keys. */
    classifications: Record<string, unknown>;
    /** Effective obligations, sorted by id. */
    obligations: Array<{
        id: string;
        resourceId: string;
        contract: string;
        policyId: string;
        lifecycle: unknown;
    }>;
    /** Complete HTTP route inventory, sorted by resourceId. */
    httpRoutes: HttpRouteCandidate[];
}
/** The complete snapshot: inventory + context + digest. */
export interface InputSnapshot {
    snapshotVersion: 1;
    files: SnapshotFileEntry[];
    gateContext: SnapshotGateContext;
    verifierFormat: string;
    /** 64-char lowercase hex digest over the canonical snapshot body. */
    inputDigest: string;
}
/** Inputs for snapshot computation. */
export interface ComputeSnapshotInput {
    /** Absolute repo root. */
    cwd: string;
    /** Validated `.gateforge.yml`. */
    config: GateforgeConfig;
    /** Absolute run-state directory (the ONLY excluded tree). */
    stateDir: string;
    /** Effective classifications keyed by resource id (post-discovery). */
    classifications?: Record<string, unknown>;
    /** Generated obligations (post-discovery). */
    obligations?: readonly Obligation[];
    /** Complete HTTP route inventory (post-discovery). */
    httpRoutes?: readonly HttpRouteCandidate[];
    /** Pinned plugin registrations (post-discovery). */
    plugins?: Array<{
        id: string;
        version: string;
    }>;
}
/**
 * Normalizes a repo-local in-process plugin module specifier to a
 * repo-relative posix path.
 *
 * Args:
 *   module: the configured module specifier (e.g. `./plugin.mjs`).
 *
 * Returns:
 *   string | null: the normalized in-repo path, or null when the
 *   specifier is not repo-local (`./`/`../` prefix absent) or escapes
 *   the repository root via `..`.
 */
export declare function normalizeRepoModule(module: string): string | null;
/**
 * Rejects an unsafe output/source overlap: any declared input that would
 * hide under the run-state directory (and thus be excluded from the
 * digest) is a hole, not an exclusion. Also rejects the state directory
 * aliasing the repo root itself (including through a symlink).
 *
 * Args:
 *   cwd: absolute repo root.
 *   stateDir: absolute run-state directory.
 *   declaredInputs: repo-relative posix paths the snapshot hashes
 *     (pre-exclusion inventory, absence markers excluded).
 *
 * Throws:
 *   UsageError: overlap detected — the run must pick a disjoint `--out`.
 */
export declare function assertOutputDisjoint(cwd: string, stateDir: string, declaredInputs: readonly string[]): void;
/**
 * Builds the canonical gate context hashed into the digest.
 *
 * Args:
 *   config: validated `.gateforge.yml`.
 *   plugins: pinned plugin registrations (defaults to the config order).
 *   classifications: effective classifications by resource id.
 *   obligations: generated obligations.
 *   httpRoutes: complete HTTP route inventory.
 *
 * Returns:
 *   SnapshotGateContext: canonical, deterministically sorted context.
 */
export declare function buildGateContext(config: GateforgeConfig, plugins?: Array<{
    id: string;
    version: string;
}>, classifications?: Record<string, unknown>, obligations?: readonly Obligation[], httpRoutes?: readonly HttpRouteCandidate[]): SnapshotGateContext;
/**
 * Hashes the canonical snapshot body (never the random manifest UUID:
 * identical inputs in two invocations produce identical digests).
 *
 * Args:
 *   files: sorted snapshot file entries.
 *   gateContext: canonical gate context.
 *
 * Returns:
 *   string: 64-char lowercase hex input digest.
 */
export declare function digestSnapshot(files: readonly SnapshotFileEntry[], gateContext: SnapshotGateContext): string;
/**
 * Computes the full input snapshot: inventory, overlap rejection,
 * entries, canonical context, and digest.
 *
 * Args:
 *   input: cwd, config, stateDir, and (post-discovery) classifications,
 *   obligations, httpRoutes, and pinned plugins.
 *
 * Returns:
 *   InputSnapshot: files, gateContext, verifierFormat, and inputDigest.
 *
 * Throws:
 *   SnapshotUnavailableError: no usable Git inventory.
 *   UnsupportedSnapshotError: uncapturable input (submodule, escaping
 *   symlink, unreadable required file).
 *   UsageError: unsafe output overlap (exit 2).
 */
export declare function computeInputSnapshot(input: ComputeSnapshotInput): InputSnapshot;
/**
 * Collects only the file entries (pre-discovery inventory): the
 * discovery-stability check compares these before and after the pipeline
 * runs — the gate context does not exist yet before discovery.
 *
 * Args:
 *   cwd: absolute repo root.
 *   config: validated `.gateforge.yml`.
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   SnapshotFileEntry[]: sorted file entries (overlap-checked).
 */
export declare function collectInputFiles(cwd: string, config: GateforgeConfig, stateDir: string): SnapshotFileEntry[];
/**
 * Compares two file inventories for the discovery-stability check.
 *
 * Args:
 *   before: pre-discovery entries.
 *   after: post-discovery entries.
 *
 * Returns:
 *   string[]: human-readable differences (empty when stable).
 */
export declare function diffInputFiles(before: readonly SnapshotFileEntry[], after: readonly SnapshotFileEntry[]): string[];
//# sourceMappingURL=input-snapshot.d.ts.map