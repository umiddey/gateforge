/**
 * Compatibility re-export: `witness/browser` now lives in the runner-neutral
 * `@gate-forge/witness` package (plan 2026-09-25 phase 1).
 *
 * The move is physical, not behavioural: this module forwards every
 * export unchanged so `@gate-forge/pack-playwright`'s published import
 * paths — which consumers pin — keep resolving to the same values.
 */
export * from '@gate-forge/witness/witness/browser';

import { chromium } from 'playwright';
import {
  EngineBrowserManager as RunnerNeutralBrowserManager,
  type EngineBrowserLauncher,
} from '@gate-forge/witness/witness/browser';

/**
 * The Playwright-defaulting engine browser manager.
 *
 * The runner-neutral `EngineBrowserManager` REQUIRES a launcher: this
 * package is the one that knows about Playwright, so the default lives
 * here. Every construction site already passed a launcher explicitly,
 * so nothing changes — but a consumer that relied on the default keeps
 * getting Chromium from this path.
 */
export class EngineBrowserManager extends RunnerNeutralBrowserManager {
  constructor(launcher: EngineBrowserLauncher = chromium) {
    super(launcher);
  }
}
