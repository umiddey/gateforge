import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
/** Detector contract: `discover(paths)` is sync (pure over file bytes). */
export interface ValidationDetector {
    discover(paths: readonly string[]): DiscoveryOutcome;
}
/** Options for {@link createValidationDetector}. */
export interface ValidationDetectorOptions {
    /** Repo root for repo-relative `source` paths (default: `process.cwd()`). */
    root?: string;
}
/** Resource kind emitted by this pack. */
export declare const VALIDATION_SCHEMA_KIND = "validation.schema";
/** Inferred resource id pattern. */
export type ValidationResourceId = `validation.${string}.${string}`;
export declare function createValidationDetector(options?: ValidationDetectorOptions): ValidationDetector;
//# sourceMappingURL=detector.d.ts.map