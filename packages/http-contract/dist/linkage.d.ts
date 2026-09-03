/**
 * Path-derived business-resource name candidate (ADR 0004 D5).
 *
 * Mirrors `resourceNameFromPath` in pack-http and the fastapi wrapper:
 * the LAST non-empty, non-parameter, non-numeric path segment,
 * lower-cased, extension stripped. This is a NON-AUTHORITATIVE linkage
 * CANDIDATE only — the endpoint compiler links an endpoint to a business
 * resource solely when the derived name matches exactly one discovered
 * business resource; ambiguity is `ENDPOINT_RESOURCE_LINK_UNRESOLVED`.
 */
export declare function derivePathResourceName(rawPath: string): string | null;
//# sourceMappingURL=linkage.d.ts.map