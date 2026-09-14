/**
 * The gateforge Playwright fixture (plan §5.3, GF-24, invariant 6;
 * Phase 1: consumer-declared surface + supervisor-issued sessions).
 *
 * `test` is `test.extend` exposing the `evidence` fixture built from
 * {@link createEvidence} — the ONLY way tests interact with gateforge:
 * the trusted primitives (`ui`, `visible`, `persistence`, `http`,
 * `finalize`) submit witness-stamped records under the supervisor-issued
 * test session; there is no boolean escape hatch and no direct record
 * API. Consumers MUST extend this runner with their declarative
 * `surface` descriptor (`test.extend({ surface })`) — the pack carries
 * no application-specific selectors (plan Phase 1 item 7). Tests must
 * import `{ test, expect }` FROM A RUNNER EXTENDED LIKE THIS — importing
 * raw `playwright/test` bypasses the fixture and produces claims with no
 * records (the engine grades the obligation `missing`; GF-24).
 */
import { expect } from 'playwright/test';
import { type EvidenceApi, type SurfaceDescriptor } from './evidence.js';
/** Fixture map this pack adds to every test. */
export type EvidenceFixtures = {
    /**
     * The consumer-declared surface descriptor (list page, selectors,
     * form templates, status values). Declare it once per consumer:
     * `const test = gateforgeTest.extend({ surface: mySurface })`.
     */
    surface: SurfaceDescriptor;
    /** The trusted evidence primitive surface for the running test. */
    evidence: EvidenceApi;
};
/**
 * The extended test runner. The `surface` fixture has NO default: a test
 * that needs `evidence` without a wired surface fails fast with the
 * actionable error below (fail closed — never generic selectors).
 */
export declare const test: import("playwright/test").TestType<import("playwright/test").PlaywrightTestArgs & import("playwright/test").PlaywrightTestOptions & EvidenceFixtures, import("playwright/test").PlaywrightWorkerArgs & import("playwright/test").PlaywrightWorkerOptions>;
export { expect };
//# sourceMappingURL=fixture.d.ts.map