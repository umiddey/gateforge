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
export function derivePathResourceName(rawPath) {
    const withoutTail = rawPath.split('?')[0]?.split('#')[0] ?? rawPath;
    const segments = withoutTail.split('/').filter((segment) => segment !== '');
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index] ?? '';
        if (segment.startsWith(':') || segment.startsWith('{') || segment.startsWith('*'))
            continue;
        if (/^\d+$/.test(segment))
            continue;
        if (segment.includes('$') && segment.includes('{'))
            continue; // unresolved slot
        const cleaned = segment.replace(/\.(json|xml|txt|html)$/i, '');
        if (cleaned.length === 0)
            continue;
        // Dash→underscore NAME-FORM normalization only: kebab-case route
        // segments must derive the snake_case form so the candidate can link
        // an existing snake_case resource. Fail-closed doctrine: this never
        // guesses a plane, mints a new identity, or widens matching — a
        // candidate that names no discovered resource stays unlinked exactly
        // as before.
        return cleaned.toLowerCase().replaceAll('-', '_');
    }
    return null;
}
//# sourceMappingURL=linkage.js.map