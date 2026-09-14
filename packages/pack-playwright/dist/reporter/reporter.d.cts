/**
 * CommonJS entry for `@gateforge/pack-playwright/reporter` (the
 * `require` export condition; compiled from this `.cts` to
 * `dist/reporter/reporter.cjs`).
 *
 * WHY a shim and not a compiled CJS build: the pack AND its dependency
 * `@gateforge/core` are ESM-only (`"type": "module"`), so no CJS
 * compilation of the reporter can `require()` the engine on every
 * supported Node runtime. What CJS consumers actually need is a
 * constructor: Playwright resolves custom reporters with
 * `require.resolve('@gateforge/pack-playwright/reporter')` (which needs
 * this condition to exist — without it CJS playwright configs died with
 * ERR_PACKAGE_PATH_NOT_EXPORTED) and then loads the resolved file with
 * require-or-import. Plain `require()` gets THIS module: a class whose
 * constructor synchronously returns while the ESM implementation loads
 * in the background. EVERY runner callback is forwarded (buffered until
 * the implementation arrives, in call order): `onTestBegin` is the
 * trusted-supervisor session open (plan Phase 1) — dropping it would
 * silently strip every test of its witness session and fail all
 * evidence primitives; `onTestEnd` seals claims + the supervision
 * outcome row; `onEnd` is awaited by the runner, so it can wait for the
 * load and fails closed if the implementation never loads (evidence is
 * never silently dropped).
 *
 * Supported syntaxes (both ESM and CJS playwright configs):
 *
 *   reporter: [['@gateforge/pack-playwright/reporter']]
 *
 * and from any CJS script:
 *
 *   const GateforgeReporter =
 *     require('@gateforge/pack-playwright/reporter');
 */
export {};
//# sourceMappingURL=reporter.d.cts.map