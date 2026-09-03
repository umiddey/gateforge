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
        return cleaned.toLowerCase();
    }
    return null;
}
//# sourceMappingURL=linkage.js.map