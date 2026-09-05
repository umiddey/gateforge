import { type Classification } from '@gateforge/core';
/** The reporter-visible projection of one resource's classification. */
export interface ClassificationView {
    primaryKey: string[];
    exposure: string;
    plane: string;
    evidenceAdapter?: string;
    /**
     * Which evidence lane proves user-facing reachability (`'claims'` =
     * the http.endpoint lane; adapter-free). MUST ride along: without it a
     * claims-lane entry (user-facing, no adapter) re-validates downstream
     * as "user-facing resources require an 'evidenceAdapter'" and the
     * reporter grades the claim unclassified.
     */
    evidenceLane?: 'adapter' | 'claims';
    lifecycle: {
        create: boolean;
        read: boolean;
        update: boolean;
        delete: boolean;
        deleteSemantics?: 'hard' | 'archive';
        archiveFields?: Record<string, string | number | boolean>;
        updateableFields?: string[];
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