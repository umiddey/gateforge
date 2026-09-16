/**
 * Run clock (pin #4/#9 wiring). The injected-clock discipline of the
 * fixture harness becomes a config surface in the CLI: `.gateforge.yml`
 * `clock.mode` is `system` (the run's instant is frozen once at start)
 * or `fixed` with an ISO-8601 `fixedAt` for deterministic runs.
 */
import { makeClock } from '@gate-forge/core';
/**
 * Builds the run clock from config.
 *
 * Args:
 *   config: validated `.gateforge.yml`.
 *
 * Returns:
 *   TestClock: canonical ISO-8601 `now()` — fixed at the configured
 *   instant, or frozen at the wall-clock start of the run.
 */
export function clockFromConfig(config) {
    if (config.clock.mode === 'fixed') {
        if (config.clock.fixedAt === undefined) {
            // Schema-enforced; unreachable for validated config.
            throw new Error("clock.mode 'fixed' requires 'fixedAt'");
        }
        return makeClock({ fixedAt: config.clock.fixedAt });
    }
    return makeClock({ fixedAt: new Date() });
}
//# sourceMappingURL=clock.js.map