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
//# sourceMappingURL=registry.js.map