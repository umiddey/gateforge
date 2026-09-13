/**
 * Verdict engine (G3) — the pure pin-#9 evaluator plus its batch
 * wrapper. See ./evaluate.ts for the encoded ADR 0001 rules.
 */
export { BLOCKING_VERDICTS, GateforgeVerdictError, evaluateObligation, evaluateObligations, parseInstant, } from './evaluate.js';
export { registerContractVerifier, verifierFor, registeredNamespaces, } from './registry.js';
/**
 * Deterministic runtime route attribution (plan §9, D2): the single
 * path interpretation plus the complete-inventory resolver the HTTP
 * transport verifier grades against. No literal-precedence shortcut;
 * ambiguity blocks.
 */
export { registerPackVerifiers, interpretObservedPath, resolveHttpRoute, pathMatchesShape, } from './pack-verifiers.js';
//# sourceMappingURL=index.js.map