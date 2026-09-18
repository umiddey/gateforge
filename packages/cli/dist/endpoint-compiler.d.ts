import { type HttpContractFact, type HttpMethod, type JoinBlock } from '@gate-forge/http-contract';
import { type DetectorOutput, type Finding } from '@gate-forge/core';
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
/**
 * Exact, non-fuzzy schema-symbol corroboration rule:
 * - take the symbol's LAST dotted segment, lowercased;
 * - candidate forms are the bare segment plus the segment with ONE of
 *   `SCHEMA_SYMBOL_SUFFIXES` stripped (case-insensitive, non-empty rest);
 * - the symbol corroborates the candidate when a form equals the
 *   candidate OR the candidate with ONE trailing 's' removed (plural
 *   tolerance, e.g. `AccountOut` corroborates `accounts`).
 * Total and deterministic: no substring or edit-distance matching.
 */
export declare function symbolCorroborates(symbol: string, candidate: string): boolean;
/**
 * Exact, non-fuzzy handler-name corroboration rule:
 * - take the handler symbol's LAST segment after the final ':' or '.',
 *   lowercased;
 * - normalize the candidate to singular by removing ONE trailing 's' if
 *   present;
 * - the handler corroborates the candidate when the candidate OR its
 *   singular form appears as a whole snake_case word, i.e. delimited by
 *   '_' or string start/end (equality, `_x`, `x_`, or `_x_`).
 * Total and deterministic: no substring or edit-distance matching.
 */
export declare function handlerCorroborates(handlerSymbol: string, candidate: string): boolean;
/**
 * Whether the canonical path IS an infrastructure-probe route: the bare
 * root `/`, or a route of depth <= 2 where some segment IS exactly
 * (case-insensitively) one of `OPERATIONAL_PROBE_SEGMENTS`. Deep business
 * routes never qualify, whatever their segments spell.
 */
export declare function isOperationalProbePath(canonicalPath: string): boolean;
/** Extracts and validates contract facts from every contribution. */
export declare function extractContractFacts(contributions: readonly DetectorOutput[]): {
    facts: HttpContractFact[];
    findings: Finding[];
};
/**
 * Optional compiler inputs. Omitted (default) — e.g. by direct callers
 * and existing tests — no config document is read and the compiled
 * output is byte-identical to the pre-config-channel compiler.
 */
export interface EndpointCompilerOptions {
    /**
     * Repo root. When provided, `.gateforge/planes.json` is read from it
     * (the same path convention the packs use) and its `match` rules
     * become endpoint-plane evidence keyed on router source paths, and
     * `.gateforge/endpoints.json` is read from it for declared endpoint
     * capabilities (the service-delegation escape hatch).
     */
    readonly cwd?: string;
}
/**
 * Compiles the endpoint inventory and the synthetic contribution.
 * Pure over its inputs.
 */
export declare function compileEndpointContribution(contributions: readonly DetectorOutput[], options?: EndpointCompilerOptions): CompileResult;
//# sourceMappingURL=endpoint-compiler.d.ts.map