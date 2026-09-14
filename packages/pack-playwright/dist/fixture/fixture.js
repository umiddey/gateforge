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
import { test as base, expect } from 'playwright/test';
import { createEvidence, SURFACE_DESCRIPTOR_VERSION, } from './evidence.js';
/**
 * The extended test runner. The `surface` fixture has NO default: a test
 * that needs `evidence` without a wired surface fails fast with the
 * actionable error below (fail closed — never generic selectors).
 */
export const test = base.extend({
    surface: async ({}, use) => {
        void use; // no usable default exists — fail closed with the setup action
        throw new Error('no surface descriptor is wired for the evidence fixture: extend the gateforge runner ' +
            'with `test.extend({ surface })` and pass your consumer-declared SurfaceDescriptor ' +
            `(schemaVersion ${String(SURFACE_DESCRIPTOR_VERSION)}). The pack ships no application ` +
            'selectors (plan Phase 1 item 7) — see example/e2e/accounts-surface.js');
    },
    evidence: async ({ page, surface }, use, testInfo) => {
        const evidence = await createEvidence({ page, testInfo, surface });
        await use(evidence);
    },
});
export { expect }; // re-exported so tests never need `playwright/test`
//# sourceMappingURL=fixture.js.map