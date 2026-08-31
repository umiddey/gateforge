import type { DetectorOutput, GraphFinding } from '../graph/index.js';
import type { Resource } from '../schemas/resource.js';
import type { TempRepo } from './temp-repo.js';
/** The canonical finding code for malformed source files. */
export declare const PARSE_ERROR_FINDING = "PARSE_ERROR";
/** One scanned file's parse outcome, as reported by a detector. */
export interface ParseAuditEntry {
    /** Repo-root-relative posix path of the scanned file. */
    file: string;
    /** True when the file parsed. */
    ok: boolean;
    /** 1-based line of the first syntax error; required when `ok` is false. */
    line?: number;
    /** Single-cause human explanation; required when `ok` is false. */
    detail?: string;
}
/** A detector's full parse audit: one entry per scanned file. */
export type ParseAudit = ParseAuditEntry[];
/** Inputs to the GF-19 rule. */
export interface ParseErrorRuleInput {
    /** Detector identity for finding provenance. */
    detectorId: string;
    /** Detector version for finding provenance. */
    detectorVersion: string;
    /** The detector's per-file parse audit. */
    audit: ParseAudit;
    /** The detector's raw discovery output (untrusted). */
    output: DetectorOutput;
}
/** Outcome of applying the GF-19 rule. */
export interface ParseErrorRuleResult {
    /**
     * All detector findings with provenance, PLUS a guaranteed
     * `PARSE_ERROR` finding per malformed file. Deterministically sorted.
     */
    findings: GraphFinding[];
    /** The `PARSE_ERROR` findings subset (assertion convenience). */
    parseErrors: GraphFinding[];
    /**
     * Resources allowed through: every resource sourced from a malformed
     * file has been stripped.
     */
    resources: Resource[];
    /**
     * Non-empty when the detector misbehaved: emitted resources from a
     * malformed file (silent resources) or failed to report a
     * `PARSE_ERROR` finding / a valid audit line number.
     */
    violations: string[];
}
/**
 * Applies the GF-19 rule to one detector contribution.
 *
 * Args:
 *   input: detector identity, parse audit, and raw output.
 *
 * Returns:
 *   ParseErrorRuleResult: guaranteed findings, vetted resources, and the
 *   detector's violations (empty when the detector behaved).
 */
export declare function applyParseErrorRule(input: ParseErrorRuleInput): ParseErrorRuleResult;
/**
 * Whether a finding list contains at least one `PARSE_ERROR` — the
 * fail-closed signal that a source file could not be read.
 *
 * Args:
 *   findings: graph or rule findings.
 *
 * Returns:
 *   boolean: true when malformed source is in play.
 */
export declare function hasParseErrors(findings: GraphFinding[]): boolean;
/** Options for {@link stubDetector}. */
export interface StubDetectorOptions {
    /** Detector id. Default `gateforge.stub-detector`. */
    id?: string;
    /** Detector version. Default `0.0.0`. */
    version?: string;
    /** Only scan files with these suffixes. Default: all non-`.git`/`.gateforge` files. */
    suffixes?: string[];
}
/** {@link stubDetector} result: discovery output plus its parse audit. */
export interface StubDetectorResult {
    /** Pinned discovery shape, ready for the gate runner. */
    output: DetectorOutput;
    /** Per-file parse audit for the GF-19 rule. */
    audit: ParseAudit;
}
/**
 * Detects resources in a fixture repository with a deliberately trivial
 * in-process parser: every top-level `name = value` line becomes a
 * resource (`kind: 'stub.declaration'`, `resourceName` attribute), any
 * other non-comment/non-blank line is a syntax error, and a file with a
 * syntax error yields a `PARSE_ERROR` finding at that line and no
 * resources. Malformed files never crash the scan.
 *
 * Args:
 *   repo: the fixture repository to scan.
 *   options: detector identity and optional suffix filter.
 *
 * Returns:
 *   StubDetectorResult: discovery output plus the parse audit for the
 *   GF-19 rule.
 */
export declare function stubDetector(repo: TempRepo, options?: StubDetectorOptions): StubDetectorResult;
//# sourceMappingURL=gf19.d.ts.map