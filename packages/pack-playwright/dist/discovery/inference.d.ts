/**
 * Kind/category inference rules (plan 2026-09-13 phase 2 item 5): pure
 * functions over the facts a static scan collected. Every rule returns
 * its id plus the source location that fired it — no opaque confidence
 * scores, and no rule is allowed to silently become proof:
 *
 * - Strong kind rules (fixtures, request contexts, HTTP-client calls,
 *   network-less bodies) propose a {@link TestKind}.
 * - Agreeing proposals decide the kind; conflicting or absent proposals
 *   resolve to `unknown` (visible, never promoted).
 * - Title/folder keyword matches are WEAK signals only — recorded, but
 *   never kind-deciding (§3.2: "a unit test named 'creates account' is
 *   still a unit test").
 * - Known mock patterns (`page.route`, `vi.mock`/`jest.mock`) become
 *   suppression signals; they can disqualify later proof but do not
 *   classify the test by themselves.
 */
import type { CategorySignal, KindSignal, RuleEvidence, SuppressionSignal, TestKind, WeakSignal } from '@gateforge/core';
import type { StaticTestFacts } from './static-discovery.js';
/** Signature parameter names that prove a real API context is in play. */
export declare const API_FIXTURE_PARAMS: readonly string[];
/** The facts inference consumes (file-level facts shared by the scan). */
export interface InferenceFacts {
    /** Repo-relative file (weak path hints). */
    file: string;
    /** Test title (weak title hints, category keywords). */
    title: string;
    /** Full title path (weak title hints). */
    titlePath: readonly string[];
    /** The static facts of the call: fixtures + body/file patterns. */
    facts: StaticTestFacts;
}
/** What inference concluded for one test. */
export interface InferenceResult {
    /** The concluded kind (`unknown` when nothing or a conflict). */
    inferredKind: TestKind;
    /** Strong kind rules that fired (kind + code evidence). */
    kindSignals: KindSignal[];
    /** Weak title/folder hints (never kind-deciding). */
    weakSignals: WeakSignal[];
    /** EVERY rule that fired, in stable rule-id order. */
    rulesFired: RuleEvidence[];
    /** Behavior-category hints (labels only). */
    categorySignals: CategorySignal[];
    /** Mock-pattern suppression signals observed for this test. */
    mockSignals: SuppressionSignal[];
}
/**
 * Runs every rule over one test's facts and resolves the kind.
 *
 * Combination rule: distinct PROPOSED kinds are computed first — exactly
 * one distinct kind decides; zero or more-than-one resolve to
 * `unknown` (recorded, visible, never silently promoted).
 *
 * Args:
 *   input: the test's file/title/facts bundle.
 *
 * Returns:
 *   InferenceResult: kind, all fired rules with evidence locations,
 *   weak signals, category hints, and mock signals.
 */
export declare function inferTestKind(input: InferenceFacts): InferenceResult;
//# sourceMappingURL=inference.d.ts.map