/**
 * The browser-API-mutation refusal names the pin when the project's browser is
 * undetermined (an evaluate-only call). The rule itself does not change; only
 * the text does. Covers the refusal detail (inference) and the unnamed-project
 * config warning.
 */
import { describe, expect, it } from 'vitest';
import { unnamedProjectConfigWarning } from '../src/discovery/discover.js';
import { inferTestKind } from '../src/discovery/inference.js';
import type { StaticTestFacts } from '../src/discovery/static-discovery.js';

const SPEC = 'tests/checkout.spec.js';
const TAMPER = { file: SPEC, line: 7, col: 3 };

function factsWith(over: Partial<StaticTestFacts>): StaticTestFacts {
  return {
    signatureParams: ['page'],
    pageRoute: null,
    httpClientCall: null,
    fileHttpClientCall: null,
    fileMockImport: null,
    fileRouteInterception: null,
    fileRouteInterceptionNonEvaluate: null,
    gateforgeFixtureImport: false,
    ...over,
  } as StaticTestFacts;
}

function mockDetails(facts: StaticTestFacts, browserUndetermined?: boolean): string[] {
  return inferTestKind({ file: SPEC, title: 'checkout', titlePath: ['checkout'], facts, browserUndetermined }).mockSignals.map(
    (signal) => signal.detail,
  );
}

describe('undetermined project browser: tamper refusal text', () => {
  it('evaluate-only tamper on an undetermined browser says so and names the chromium pin', () => {
    const detail = mockDetails(
      factsWith({ fileRouteInterception: TAMPER, fileRouteInterceptionNonEvaluate: null }),
      true,
    ).find((text) => text.startsWith('PAGE_OBSERVATION_TAMPER_RISK'));
    expect(detail).toBeDefined();
    expect(detail).toContain('browser is undetermined');
    expect(detail).toContain("use: { browserName: 'chromium' }");
  });

  it('evaluate-only tamper on a named (non-undetermined) browser keeps the plain text', () => {
    const detail = mockDetails(
      factsWith({ fileRouteInterception: TAMPER, fileRouteInterceptionNonEvaluate: null }),
      false,
    ).find((text) => text.startsWith('PAGE_OBSERVATION_TAMPER_RISK'));
    expect(detail).toBe(`PAGE_OBSERVATION_TAMPER_RISK: browser API mutation at ${SPEC}:7 in the spec or its imported helper`);
  });

  it('a non-evaluate tamper refuses regardless of browser, so the pin hint is not added', () => {
    const detail = mockDetails(
      factsWith({ fileRouteInterception: TAMPER, fileRouteInterceptionNonEvaluate: TAMPER }),
      true,
    ).find((text) => text.startsWith('PAGE_OBSERVATION_TAMPER_RISK'));
    expect(detail).not.toContain('undetermined');
  });

  it('a chromium-pinned project reads no evaluate-only tamper (its facts carry no route interception)', () => {
    const details = mockDetails(factsWith({ fileRouteInterception: null, fileRouteInterceptionNonEvaluate: null }), false);
    expect(details.some((text) => text.startsWith('PAGE_OBSERVATION_TAMPER_RISK'))).toBe(false);
  });

  it('page.route keeps today text, with no undetermined-browser wording', () => {
    const details = mockDetails(factsWith({ pageRoute: TAMPER }), true);
    expect(details).toContain('page.route interception inside the test body');
    expect(details.join('\n')).not.toContain('undetermined');
  });
});

describe('unnamed project config warning', () => {
  it('suggests the browserName pin, not a bare project', () => {
    const line = unnamedProjectConfigWarning('playwright.config.ts');
    expect(line).toContain("projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]");
    expect(line).not.toContain('behaviour-neutral');
  });
});
