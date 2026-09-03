/**
 * Post-canonicalization and signal minting for the FastAPI detector.
 *
 * The Python scanner emits raw effective paths; this module is the single
 * place where contract facts get their canonical `normalizedPath` (via
 * `@gateforge/http-contract`, so canonicalization has exactly one
 * implementation across languages) and where the pack's classification
 * signals (exposure/lifecycle facts about business resources, ADR 0003
 * D1) are minted with the pack's pinned detector identity.
 */
import { HTTP_PATH_DYNAMIC, normalizeHttpPath, } from '@gateforge/http-contract';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
/**
 * Mirrors pack-http's `resourceNameFromPath`: the last non-parameter,
 * non-numeric, non-empty path segment, lower-cased, extension-stripped.
 * Returns `null` when no name can be derived — the caller must emit
 * nothing rather than guess.
 */
export function pathDerivedResourceName(rawPath) {
    const withoutTail = rawPath.split('?')[0]?.split('#')[0] ?? rawPath;
    const segments = withoutTail.split('/').filter((segment) => segment !== '');
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index] ?? '';
        if (segment.startsWith(':') || segment.startsWith('{') || segment.startsWith('*'))
            continue;
        if (/^\d+$/.test(segment))
            continue;
        const cleaned = segment.replace(/\.(json|xml|txt|html)$/i, '');
        if (cleaned.length === 0)
            continue;
        return cleaned.toLowerCase();
    }
    return null;
}
/** HTTP verb → lifecycle operation, mirroring pack-http (`null` = none). */
export function operationForMethod(method) {
    switch (method) {
        case 'POST':
            return 'create';
        case 'GET':
        case 'HEAD':
            return 'read';
        case 'PUT':
        case 'PATCH':
            return 'update';
        case 'DELETE':
            return 'delete';
        default:
            return null;
    }
}
function signal(dimension, assertion, location, targetName) {
    return {
        schemaVersion: 1,
        target: { resourceName: targetName },
        dimension: dimension,
        assertion,
        basis: 'code-positive',
        source: PACK_PLUGIN_ID,
        location,
        detector: { id: PACK_PLUGIN_ID, version: PACK_VERSION },
    };
}
/**
 * Canonicalizes python-emitted contract resources into typed facts and
 * mints the pack's classification signals.
 *
 * A fact whose effective path canonicalizes to a dynamic outcome becomes a
 * blocking `HTTP_PATH_DYNAMIC` unresolved entry — never a dropped claim
 * and never a guess. Facts and signals are returned in deterministic
 * canonical order.
 */
export function canonicalizeFacts(resources) {
    const facts = [];
    const keptResources = [];
    const unresolved = [];
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
        const targetName = pathDerivedResourceName(effectivePath);
        if (targetName !== null) {
            signals.push(signal('exposure', 'route', resource.location, targetName));
            const operation = operationForMethod(method);
            if (operation !== null) {
                signals.push(signal(`lifecycle.${operation}`, true, resource.location, targetName));
            }
        }
    }
    facts.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
    keptResources.sort((a, b) => compareText(a.id, b.id));
    signals.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
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