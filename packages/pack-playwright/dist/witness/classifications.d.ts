import { type Classification } from '@gateforge/core';
/** The reporter-visible projection of one resource's classification. */
export interface ClassificationView {
    primaryKey: string[];
    exposure: string;
    plane: string;
    evidenceAdapter?: string;
    lifecycle: {
        create: boolean;
        read: boolean;
        update: boolean;
        delete: boolean;
        deleteSemantics?: 'hard' | 'archive';
    };
}
/**
 * Loads the classifications document.
 *
 * Args:
 *   path: absolute path to the classifications YAML (or null/'' = none).
 *
 * Returns:
 *   Record<string, Classification>: validated per-resource map (empty
 *   when no document is configured).
 *
 * Throws:
 *   AdapterRegistryError: fail-closed load/validation problems.
 */
export declare function loadClassifications(path: string | null | undefined): Record<string, Classification>;
/** Projects a classification for the reporter surface. */
export declare function toClassificationView(entry: Classification): ClassificationView;
//# sourceMappingURL=classifications.d.ts.map