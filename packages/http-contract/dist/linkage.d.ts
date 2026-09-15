/**
 * Path-derived business-resource name candidate (ADR 0004 D5).
 *
 * Mirrors `resourceNameFromPath` in pack-http and the fastapi wrapper:
 * the LAST non-empty, non-parameter, non-numeric path segment,
 * lower-cased, extension stripped, dashes normalized to underscores
 * (kebab-case route segments derive their snake_case form, e.g.
 * `/email-accounts/{id}` derives `email_accounts`). This is a
 * NON-AUTHORITATIVE linkage
 * CANDIDATE only — the endpoint compiler links an endpoint to a business
 * resource solely when the derived name matches exactly one discovered
 * business resource; ambiguity is `ENDPOINT_RESOURCE_LINK_UNRESOLVED`.
 */
export declare function derivePathResourceName(rawPath: string): string | null;
//# sourceMappingURL=linkage.d.ts.map