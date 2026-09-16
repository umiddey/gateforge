"use strict";
/**
 * CommonJS entry for `@gate-forge/pack-playwright/reporter` (the
 * `require` export condition; compiled from this `.cts` to
 * `dist/reporter/reporter.cjs`).
 *
 * WHY a shim and not a compiled CJS build: the pack AND its dependency
 * `@gate-forge/core` are ESM-only (`"type": "module"`), so no CJS
 * compilation of the reporter can `require()` the engine on every
 * supported Node runtime. What CJS consumers actually need is a
 * constructor: Playwright resolves custom reporters with
 * `require.resolve('@gate-forge/pack-playwright/reporter')` (which needs
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
 *   reporter: [['@gate-forge/pack-playwright/reporter']]
 *
 * and from any CJS script:
 *
 *   const GateforgeReporter =
 *     require('@gate-forge/pack-playwright/reporter');
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
    onTestBegin(test, result) {
        this.forward('onTestBegin', [test, result]);
    }
    /** Runner callback (synchronous): buffered until the impl arrives. */
    onTestEnd(test, result) {
        this.forward('onTestEnd', [test, result]);
    }
    /** Runner callback (synchronous): buffered until the impl arrives. */
    onError(error) {
        this.forward('onError', [error]);
    }
    /** Runner callback (awaited): waits for the load, then delegates.
     * The FullResult argument MUST be forwarded — it is the only source
     * of the final run status the supervisor reads from the outcomes
     * document (dropping it fails every supervised run as 'unknown'). */
    async onEnd(result) {
        await this.ready;
        if (this.implementation === null) {
            throw (this.loadError ??
                new Error('gateforge reporter implementation failed to load (no error reported)'));
        }
        return this.implementation.onEnd(result);
    }
    /**
     * Buffers or dispatches one runner callback. Order is preserved: the
     * implementation replays the buffer in arrival order exactly once,
     * and post-load calls dispatch straight through.
     */
    forward(name, args) {
        if (this.implementation !== null) {
            this.dispatch(this.implementation, name, args);
            return;
        }
        this.buffered.push([name, args]);
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