"use strict";
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
 * in the background. The runner's synchronous callback (`onTestEnd`)
 * is buffered until the implementation arrives; `onEnd` is awaited by
 * the runner, so it can wait for the load and fails closed if the
 * implementation never loads (evidence is never silently dropped).
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
Object.defineProperty(exports, "__esModule", { value: true });
class GateforgeReporterCjs {
    options;
    buffered = [];
    implementation = null;
    loadError = null;
    ready;
    constructor(options = {}) {
        this.options = options;
        this.ready = import('./reporter.js').then((module) => {
            const implementation = new module.GateforgeReporter(this.options);
            this.implementation = implementation;
            const buffered = this.buffered.splice(0, this.buffered.length);
            for (const [name, args] of buffered) {
                this.dispatch(implementation, name, args);
            }
        }, (error) => {
            this.loadError = error instanceof Error ? error : new Error(String(error));
        });
    }
    /** Runner callback (synchronous): buffered until the impl arrives. */
    onTestEnd(test, result) {
        if (this.implementation !== null) {
            this.dispatch(this.implementation, 'onTestEnd', [test, result]);
            return;
        }
        this.buffered.push(['onTestEnd', [test, result]]);
    }
    /** Runner callback (awaited): waits for the load, then delegates. */
    async onEnd() {
        await this.ready;
        if (this.implementation === null) {
            throw (this.loadError ??
                new Error('gateforge reporter implementation failed to load (no error reported)'));
        }
        return this.implementation.onEnd();
    }
    dispatch(implementation, name, args) {
        const method = implementation[name];
        if (typeof method !== 'function') {
            throw new Error(`gateforge reporter implementation has no ${name} method`);
        }
        void method.apply(implementation, args);
    }
}
// Playwright expects the constructor itself (require-or-import default
// resolution); the named/default aliases cover destructuring consumers.
module.exports = GateforgeReporterCjs;
module.exports['GateforgeReporter'] =
    GateforgeReporterCjs;
module.exports['default'] = GateforgeReporterCjs;
//# sourceMappingURL=reporter.cjs.map