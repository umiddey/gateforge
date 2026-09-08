import type { AdapterContext, EvidenceAdapter } from './types.js';
/**
 * Loads every `.mjs` adapter in `dir` into a frozen registry.
 *
 * Args:
 *   dir: the configured adapters directory (absolute).
 *
 * Returns:
 *   Map<string, EvidenceAdapter>: keyed by the file basename sans `.mjs`.
 *
 * Throws:
 *   AdapterRegistryError: fail-closed load problems — unreadable dir,
 *     unimportable module, or a module missing any contract member.
 */
export declare function loadAdapters(dir: string): Promise<Map<string, EvidenceAdapter>>;
/**
 * Validates one adapter module against the pin-#8 contract.
 *
 * Args:
 *   module: the default export of the adapter file.
 *   name: adapter name, used in diagnostics.
 *
 * Returns:
 *   EvidenceAdapter: the validated adapter.
 *
 * Throws:
 *   AdapterRegistryError: when any required member is missing or shaped
 *   wrong. Optional `baseUrl` (a string) overrides the witness's
 *   configured adapter base for this adapter.
 */
export declare function validateAdapter(module: unknown, name: string): EvidenceAdapter;
/** Fail-closed adapter-loading error (witness startup aborts). */
export declare class AdapterRegistryError extends Error {
    constructor(message: string);
}
/** The transport the witness hands to adapter `read` calls (GET-only). */
export declare function makeAdapterContext(baseUrl: string, resourceId: string, get: AdapterContext['get'], headers?: Record<string, string>): AdapterContext;
//# sourceMappingURL=adapter-registry.d.ts.map