const verifiers = new Map();
/**
 * Registers the semantic verifier for a contract namespace. Throws when
 * the namespace is already registered — verifier registration cannot
 * override another namespace's semantics (plan phase 5 checklist).
 */
export function registerContractVerifier(namespace, verifier) {
    if (verifiers.has(namespace)) {
        throw new Error(`a semantic verifier for contract namespace '${namespace}' is already registered; ` +
            'registration cannot override another namespace');
    }
    verifiers.set(namespace, verifier);
}
/** The verifier for a contract's namespace, or null when unregistered. */
export function verifierFor(contract) {
    const separator = contract.indexOf(':');
    const namespace = separator === -1 ? contract : contract.slice(0, separator);
    return verifiers.get(namespace) ?? null;
}
/** All registered namespaces (sorted; for diagnostics and tests). */
export function registeredNamespaces() {
    return [...verifiers.keys()].sort();
}
const capabilities = new Map();
/**
 * Registers the capability metadata for one contract namespace. Throws
 * when the namespace already carries a capability record — like verifier
 * registration (first-wins), a later registration can never redefine or
 * weaken another namespace's advertised capability (plan Phase 0
 * acceptance: no protected verifier can be replaced by registration
 * order).
 *
 * Args:
 *   capability: the capability record (namespace, implemented contracts,
 *     required observer, test kinds, availability).
 *
 * Throws:
 *   Error: when the namespace already has a capability record.
 */
export function registerContractCapabilities(capability) {
    if (capabilities.has(capability.namespace)) {
        throw new Error(`a capability record for contract namespace '${capability.namespace}' is already registered; ` +
            'registration cannot override another namespace');
    }
    capabilities.set(capability.namespace, capability);
}
/**
 * The capability record for a contract's namespace, or null when the
 * namespace has none (an unregistered namespace is itself unsupported).
 *
 * Args:
 *   contract: a contract name (`namespace:operation`); the namespace is
 *     the text before the first colon (same split as `verifierFor`).
 *
 * Returns:
 *   ContractCapability | null: the namespace's capability record.
 */
export function capabilityFor(contract) {
    const separator = contract.indexOf(':');
    const namespace = separator === -1 ? contract : contract.slice(0, separator);
    return capabilities.get(namespace) ?? null;
}
/** All registered capability records, sorted by namespace (diagnostics/tests). */
export function allCapabilities() {
    return [...capabilities.values()].sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
}
//# sourceMappingURL=registry.js.map