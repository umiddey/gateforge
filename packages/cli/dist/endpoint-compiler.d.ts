/**
 * The endpoint compiler (ADR 0004 D5/D6, plan phase 4): a deterministic
 * CLI-pipeline stage that consumes every detector contribution's
 * `http.contract` facts, joins frontend calls to backend routes
 * (`@gateforge/http-contract`), classifies endpoint capabilities with
 * rules over detector FACTS (never framework syntax), links endpoints to
 * business resources only through unambiguous evidence, and emits a
 * synthetic `gateforge.endpoint-compiler` contribution whose endpoint
 * resources are classified like any other resource.
 *
 * Guarantees:
 * - pure function of the contributions; input permutation yields
 *   byte-identical output;
 * - unwired calls, ambiguous joins, unresolved semantics, and ambiguous
 *   linkage become typed blocking entries — never guesses, never
 *   first-match-wins, never absence-as-internal;
 * - HTTP method is one candidate among many: command suffixes beat
 *   methods, and every `crud-*` rule demands corroboration (schema
 *   symbols, response model, or a linked business resource);
 * - entity linkage is an explicit attribute, never the path-derived name
 *   itself (the route/table collision red probe stays green).
 */
import { type HttpContractFact, type HttpMethod, type JoinBlock } from '@gateforge/http-contract';
import { type DetectorOutput, type Finding } from '@gateforge/core';
/** Detector id of the synthetic compiler contribution (engine-issued). */
export declare const ENDPOINT_COMPILER_DETECTOR_ID = "gateforge.endpoint-compiler";
/** Schema version of the compiler's output payloads. */
export declare const ENDPOINT_COMPILER_VERSION = "1";
/** One compiled endpoint and every fact behind it. */
export interface EndpointRecord {
    method: HttpMethod;
    canonicalPath: string;
    identity: string;
    resourceName: string;
    capabilities: string[];
    capabilityTrace: Array<{
        capability: string;
        rule: string;
        evidence: string;
    }>;
    linkedResourceName: string | null;
    frontendConsumed: boolean;
    deleteSemantics: 'hard' | 'archive' | null;
    routes: HttpContractFact[];
    calls: HttpContractFact[];
}
export interface EndpointInventory {
    /** All parsed contract facts, canonical order. */
    facts: HttpContractFact[];
    /** Every compiled endpoint (consumed and unconsumed), sorted by identity. */
    endpoints: EndpointRecord[];
    /** Unmatched frontend calls (typed blocks). */
    unwired: JoinBlock[];
    /** Ambiguous joins (typed blocks). */
    ambiguous: JoinBlock[];
}
export interface CompileResult {
    /** Synthetic contribution to merge into buildResourceGraph inputs. */
    contribution: DetectorOutput;
    inventory: EndpointInventory;
}
/** Extracts and validates contract facts from every contribution. */
export declare function extractContractFacts(contributions: readonly DetectorOutput[]): {
    facts: HttpContractFact[];
    findings: Finding[];
};
/**
 * Compiles the endpoint inventory and the synthetic contribution.
 * Pure over its inputs.
 */
export declare function compileEndpointContribution(contributions: readonly DetectorOutput[]): CompileResult;
//# sourceMappingURL=endpoint-compiler.d.ts.map