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
import type {
  CategorySignal,
  KindSignal,
  Location,
  RuleEvidence,
  SuppressionSignal,
  TestKind,
  WeakSignal,
} from '@gateforge/core';
import type { StaticTestFacts } from './static-discovery.js';
import { BROWSER_FIXTURE_PARAMS } from './static-discovery.js';

/** Signature parameter names that prove a real API context is in play. */
export const API_FIXTURE_PARAMS: readonly string[] = ['request'];

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

/** Rules that propose a kind, strongest-first, with their evidence. */
const KIND_RULES: ReadonlyArray<{
  ruleId: string;
  kind: TestKind;
  applies: (input: InferenceFacts) => { evidence: string } | null;
}> = [
  {
    ruleId: 'browser-fixture',
    kind: 'browser-e2e',
    applies: (input) => {
      const browserParams = input.facts.signatureParams.filter((name) => BROWSER_FIXTURE_PARAMS.has(name));
      if (browserParams.length === 0) return null;
      return {
        evidence: `test signature declares browser fixture(s): ${browserParams.join(', ')}`,
      };
    },
  },
  {
    ruleId: 'api-request-fixture',
    kind: 'api-e2e',
    applies: (input) => {
      const apiParams = input.facts.signatureParams.filter((name) => API_FIXTURE_PARAMS.includes(name));
      if (apiParams.length === 0) return null;
      return { evidence: `test signature declares API fixture(s): ${apiParams.join(', ')}` };
    },
  },
  {
    ruleId: 'http-client-call',
    kind: 'api-e2e',
    applies: (input) => {
      const where = input.facts.httpClientCall ?? input.facts.fileHttpClientCall;
      if (where === null) return null;
      return {
        evidence: `HTTP client call at ${where.file}:${String(where.line)} reaches the application boundary`,
      };
    },
  },
  {
    // Network-less pure-function probe: no fixtures at all and no
    // app-boundary (HTTP) call anywhere in the file → unit hint.
    ruleId: 'networkless-unit',
    kind: 'unit',
    applies: (input) => {
      if (input.facts.signatureParams.length > 0) return null;
      if (input.facts.pageRoute !== null) return null;
      if (input.facts.httpClientCall !== null || input.facts.fileHttpClientCall !== null) return null;
      return { evidence: 'no fixtures and no application-boundary call: a network-less function probe' };
    },
  },
];

/** Weak keyword hints per title/path token. Never kind-deciding. */
const TITLE_KEYWORD_RULES: ReadonlyArray<{ token: string; hint: string }> = [
  { token: 'e2e', hint: 'title mentions e2e (weak)' },
  { token: 'integration', hint: 'title mentions integration (weak)' },
  { token: 'unit', hint: 'title mentions unit (weak)' },
];

/** Path segments treated as weak hints. */
const PATH_KEYWORD_RULES: ReadonlyArray<{ token: string; hint: string }> = [
  { token: 'e2e', hint: 'path segment mentions e2e (weak)' },
  { token: 'integration', hint: 'path segment mentions integration (weak)' },
  { token: 'unit', hint: 'path segment mentions unit (weak)' },
];

/** Category keyword → dotted label (hints only, never proof). */
const CATEGORY_KEYWORDS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bcreat|\badd/i, label: 'persistence.create' },
  { pattern: /\bupdate|\bedit/i, label: 'persistence.update' },
  { pattern: /\bdelet|\bremov|\bdestroy/i, label: 'persistence.delete' },
  { pattern: /\bread|\bshow|\bview|\blist|\bdisplay/i, label: 'persistence.read' },
  { pattern: /\blogin|\blogout|\bauth|\bsign[ -]?(in|up)/i, label: 'authentication' },
  { pattern: /\bvalid|\binvalid/i, label: 'validation' },
  { pattern: /\bnavigat|\bredirect/i, label: 'navigation' },
  { pattern: /\bworkflow|\bjourney/i, label: 'workflow' },
];

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
export function inferTestKind(input: InferenceFacts): InferenceResult {
  const kindSignals: KindSignal[] = [];
  const rulesFired: RuleEvidence[] = [];
  const weakSignals: WeakSignal[] = [];
  const categorySignals: CategorySignal[] = [];
  const mockSignals: SuppressionSignal[] = [];

  for (const rule of KIND_RULES) {
    const outcome = rule.applies(input);
    if (outcome === null) continue;
    // The evidence location: prefer the exact body location when the
    // rule observed one, else the first fixture param is located at the
    // call (unknown here) — inference callers pass call-level facts, so
    // the evidence points at what the rule saw.
    rulesFired.push({ ruleId: rule.ruleId, evidence: outcome.evidence, location: evidenceLocation(rule.ruleId, input) });
    kindSignals.push({ ruleId: rule.ruleId, kind: rule.kind, evidence: outcome.evidence, location: evidenceLocation(rule.ruleId, input) });
  }

  for (const rule of TITLE_KEYWORD_RULES) {
    const haystack = [...input.titlePath, input.title].join(' ').toLowerCase();
    if (haystack.includes(rule.token)) {
      weakSignals.push({ ruleId: 'title-keywords', evidence: rule.hint, location: weakLocation(input) });
      rulesFired.push({ ruleId: 'title-keywords', evidence: rule.hint, location: weakLocation(input) });
      break; // one title hint is enough; keep the trace small
    }
  }
  for (const rule of PATH_KEYWORD_RULES) {
    const segments = input.file.toLowerCase().split('/');
    if (segments.includes(rule.token)) {
      weakSignals.push({ ruleId: 'path-keywords', evidence: rule.hint, location: weakLocation(input) });
      rulesFired.push({ ruleId: 'path-keywords', evidence: rule.hint, location: weakLocation(input) });
      break;
    }
  }

  if (input.facts.pageRoute !== null) {
    mockSignals.push({
      kind: 'mock',
      detail: 'page.route interception inside the test body',
      location: input.facts.pageRoute,
    });
    rulesFired.push({ ruleId: 'mock-page-route', evidence: 'page.route call intercepts network', location: input.facts.pageRoute });
  }
  if (input.facts.fileMockImport !== null) {
    mockSignals.push({
      kind: 'mock',
      detail: 'vi.mock/jest.mock module mock in the test file',
      location: input.facts.fileMockImport,
    });
    rulesFired.push({ ruleId: 'mock-module-import', evidence: 'module-level mock call', location: input.facts.fileMockImport });
  }

  for (const rule of CATEGORY_KEYWORDS) {
    if (rule.pattern.test(input.title)) {
      categorySignals.push({ label: rule.label, ruleId: 'category-keywords', location: weakLocation(input) });
    }
  }

  const distinct = [...new Set(kindSignals.map((signal) => signal.kind))];
  const inferredKind: TestKind = distinct.length === 1 ? (distinct[0] as TestKind) : 'unknown';
  if (distinct.length > 1) {
    rulesFired.push({
      ruleId: 'kind-conflict',
      evidence: `rules propose conflicting kinds (${distinct.sort().join(', ')}): resolved to unknown`,
      location: weakLocation(input),
    });
  }

  return { inferredKind, kindSignals, weakSignals, rulesFired, categorySignals, mockSignals };
}

/** The location a strong rule's evidence points at. */
function evidenceLocation(ruleId: string, input: InferenceFacts): Location {
  if (ruleId === 'http-client-call') {
    return input.facts.httpClientCall ?? input.facts.fileHttpClientCall ?? { file: input.file, line: 1, col: 0 };
  }
  if (ruleId === 'mock-page-route') return input.facts.pageRoute ?? { file: input.file, line: 1, col: 0 };
  // Fixture/unit rules have no sharper location than the file itself at
  // line 1 — the catalog row carries the exact call location separately.
  return { file: input.file, line: 1, col: 0 };
}

/** Stable placeholder location for file-level weak signals. */
function weakLocation(input: InferenceFacts): Location {
  return { file: input.file, line: 1, col: 0 };
}
