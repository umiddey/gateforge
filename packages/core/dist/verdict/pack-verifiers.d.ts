/**
 * Positional match of a concrete observed path against a compiled
 * canonical shape (ADR 0004 D2/D3 semantics): literal segments must be
 * equal, `{}` matches any single non-empty segment, and a TRAILING `{*}`
 * matches one or more trailing segments. Non-trailing wildcards and any
 * other shape never match. Case-sensitive.
 *
 * Args:
 *   observedPath: the concrete observed path (query already stripped).
 *   canonicalPath: the endpoint's compiled canonical shape.
 *
 * Returns:
 *   boolean: true only when the observed path instantiates the shape.
 */
export declare function pathMatchesShape(observedPath: string, canonicalPath: string): boolean;
/** Registers every pack namespace + the http namespace. Idempotent. */
export declare function registerPackVerifiers(): void;
//# sourceMappingURL=pack-verifiers.d.ts.map