/**
 * The gateforge Playwright fixture (plan §5.3, GF-24, invariant 6).
 *
 * `test` is `test.extend` exposing the `evidence` fixture built from
 * {@link createEvidence} — the ONLY way tests interact with gateforge:
 * the trusted primitives (`ui`, `visible`, `persistence`, `finalize`)
 * submit witness-stamped records; there is no boolean escape hatch and
 * no direct record API. Tests must import `{ test, expect }` FROM THIS
 * PACKAGE — importing raw `playwright/test` bypasses the fixture and
 * produces claims with no records (the engine grades the obligation
 * `missing`; GF-24).
 */
import { expect } from 'playwright/test';
import { type EvidenceApi } from './evidence.js';
/** Fixture map this pack adds to every test. */
export type EvidenceFixtures = {
    /** The trusted evidence primitive surface for the running test. */
    evidence: EvidenceApi;
};
/**
 * The extended test runner. Workers get `evidence` bound to their page
 * and testInfo; primitives resolve the app base + witness from env.
 */
export declare const test: import("playwright/test").TestType<import("playwright/test").PlaywrightTestArgs & import("playwright/test").PlaywrightTestOptions & EvidenceFixtures, import("playwright/test").PlaywrightWorkerArgs & import("playwright/test").PlaywrightWorkerOptions>;
export { expect };
//# sourceMappingURL=fixture.d.ts.map