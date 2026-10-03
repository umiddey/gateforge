/**
 * Compatibility re-export: `witness/server` now lives in the
 * runner-neutral `@gate-forge/witness` package (plan 2026-09-25
 * phase 1).
 *
 * The move is physical, not behavioural: this module forwards every
 * export unchanged so `@gate-forge/pack-playwright`'s published import
 * paths — which consumers pin — keep resolving to the same values.
 *
 * ONE behaviour lives here rather than in the neutral package: the
 * Chromium default for the engine browser. The runner-neutral witness
 * never assumes a browser, so `startWitness` there requires an
 * `EngineBrowserLauncher`; this package is the Playwright layer, so it
 * supplies pinned Chromium when the caller names none. Every other
 * witness behaviour is byte-identical.
 */
import { chromium } from 'playwright';
import {
  startWitness as startRunnerNeutralWitness,
  type WitnessHandle,
} from '@gate-forge/witness/witness/server';
import type { WitnessOptions } from '@gate-forge/witness/witness/types';

export * from '@gate-forge/witness/witness/server';

/**
 * Starts the loopback witness with the engine browser defaulted to
 * pinned Chromium.
 *
 * Args:
 *   options: witness options; `engineBrowserLauncher` defaults to
 *     Playwright's `chromium` when absent.
 *
 * Returns:
 *   Promise<WitnessHandle>: the running witness handle.
 */
export function startWitness(options: WitnessOptions): Promise<WitnessHandle> {
  return startRunnerNeutralWitness({
    ...options,
    engineBrowserLauncher: options.engineBrowserLauncher ?? chromium,
  });
}
