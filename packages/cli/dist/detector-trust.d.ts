import type { GateforgeConfig } from '@gate-forge/core';
/** Bundled detector id → the package that MUST provide it. Frozen trust base. */
export declare const TRUSTED_DETECTOR_PACKAGES: Readonly<Record<string, string>>;
/**
 * Validates that every policy coverage rule names a TRUSTED detector,
 * that the detector is configured, and that its implementation resolves
 * inside the trusted package. Any violation is a configuration error
 * (exit 2): coverage evidence from anywhere else is untrustworthy by
 * construction, so the run fails closed before discovery.
 *
 * Args:
 *   rules: the policy's declared coverage rules.
 *   plugins: the configured plugins.
 *   cwd: repo root (relative `module:` specifiers resolve against it).
 *
 * Throws:
 *   UsageError: naming the offending rule and the resolution path.
 */
export declare function validateCoverageTrust(rules: ReadonlyArray<{
    detector: string;
}>, plugins: GateforgeConfig['plugins'], cwd: string): void;
/**
 * Validates that every named detector is a bundled Gateforge detector,
 * configured, and loaded from its genuine package. Shared by coverage
 * rules (scan completeness) and trusted entry-point categories
 * (reachability evidence — red-team round 5).
 */
export declare function assertBundledDetectors(detectorIds: readonly string[], plugins: GateforgeConfig['plugins'], cwd: string, purpose: string): void;
//# sourceMappingURL=detector-trust.d.ts.map