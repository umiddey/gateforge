/**
 * Post-canonicalization for the FastAPI detector.
 *
 * The Python scanner emits raw effective paths; this module is the single
 * place where contract facts get their canonical `normalizedPath` (via
 * `@gateforge/http-contract`, so canonicalization has exactly one
 * implementation across languages).
 *
 * Classification signals (dogfood remediation phase 4): NONE. The wrapper
 * once minted `exposure: route` / `lifecycle.<op>` signals targeted at the
 * PATH-DERIVED resource name (`pathDerivedResourceName`) — a guess that
 * mostly names no discovered resource (route `/admin-bypasses` vs the real
 * table), so the signals surfaced as STALE_SIGNAL_TARGET blockers while
 * adding nothing: unknown exposure already defaults user-facing and unknown
 * lifecycle operations already default enabled (ADR 0003 D5). Route→resource
 * linkage belongs to the CLI endpoint compiler (schema-symbol/handler
 * corroboration over these very facts' `requestSchemaSymbols`/
 * `responseSchemaSymbols`/`handlerSymbol`, with typed
 * ENDPOINT_RESOURCE_LINK_UNRESOLVED blocks for ambiguity). Core's
 * STALE_SIGNAL_TARGET detection remains for genuinely stale authority
 * signals (declaration markers, adapter bindings, read-only declarations)
 * — this pack simply no longer produces false targets. The
 * `classificationSignals` outcome field stays in the wire shape (protocol
 * contract) and is always empty.
 */
import { HTTP_PATH_DYNAMIC, normalizeHttpPath, } from '@gateforge/http-contract';
/**
 * Canonicalizes python-emitted contract resources into typed facts.
 *
 * A fact whose effective path canonicalizes to a dynamic outcome becomes a
 * blocking `HTTP_PATH_DYNAMIC` unresolved entry — never a dropped claim
 * and never a guess. No classification signals are minted (phase 4; see
 * the module doc). Facts and resources are returned in deterministic
 * canonical order.
 */
export function canonicalizeFacts(resources) {
    const facts = [];
    const keptResources = [];
    const unresolved = [];
    // Phase 4: no classification signals are minted — the field stays in
    // the wire shape (protocol contract) and is always empty.
    const signals = [];
    for (const resource of resources) {
        if (resource.kind !== 'http.contract') {
            keptResources.push(resource);
            continue;
        }
        const attributes = resource.attributes;
        const effectivePath = attributes['effectivePath'];
        const method = attributes['method'];
        if (typeof effectivePath !== 'string' || typeof method !== 'string') {
            unresolved.push({
                code: HTTP_PATH_DYNAMIC,
                detail: `contract fact '${resource.id}' carries no provable effective path`,
                location: resource.location,
            });
            continue;
        }
        const canonical = normalizeHttpPath(effectivePath);
        if (!canonical.ok) {
            unresolved.push({
                code: HTTP_PATH_DYNAMIC,
                detail: `route '${effectivePath}' in ${resource.source}: ${canonical.detail}`,
                location: resource.location,
            });
            continue;
        }
        const fact = {
            schemaVersion: 1,
            role: 'server-route',
            method: method,
            normalizedPath: canonical.canonical,
            rawPath: effectivePath,
            framework: typeof attributes['framework'] === 'string' ? attributes['framework'] : 'fastapi',
            handlerSymbol: typeof attributes['handlerSymbol'] === 'string'
                ? attributes['handlerSymbol']
                : undefined,
            source: resource.location,
        };
        const responseModel = attributes['responseModel'];
        if (typeof responseModel === 'string' && responseModel.length > 0) {
            fact.responseSchemaSymbols = [responseModel];
        }
        const requestSchemas = attributes['requestSchemaSymbols'];
        if (Array.isArray(requestSchemas)) {
            const names = requestSchemas.filter((name) => typeof name === 'string' && name.length > 0);
            if (names.length > 0)
                fact.requestSchemaSymbols = names;
        }
        facts.push(fact);
        keptResources.push({
            ...resource,
            attributes: { ...attributes, normalizedPath: canonical.canonical },
        });
    }
    facts.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
    keptResources.sort((a, b) => compareText(a.id, b.id));
    unresolved.sort((a, b) => compareText(a.location.file, b.location.file) ||
        (a.location.line || 0) - (b.location.line || 0) ||
        compareText(a.code, b.code) ||
        compareText(a.detail, b.detail));
    return { facts, resources: keptResources, unresolved, classificationSignals: signals };
}
function compareText(a, b) {
    if (a === b)
        return 0;
    return a < b ? -1 : 1;
}
//# sourceMappingURL=facts.js.map