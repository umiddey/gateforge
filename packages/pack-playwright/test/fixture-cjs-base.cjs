/**
 * A CommonJS consumer's shared base — the exact one-line shape the guides
 * document for suites that are not ESM (plan 0.9.2 finding E).
 *
 * Why this file exists: suite traffic reaches the session observation proxy
 * ONLY when `page` comes from Gateforge's fixture, so a suite that cannot
 * `require()` the fixture can never satisfy an `observed-e2e` transport
 * claim — it finalizes with "no HTTP exchange passed through this
 * session's observation proxy". CommonJS is the default shape of most
 * existing Playwright suites, so this entry must load through `require`.
 *
 * Run directly it is also the probe: it prints what it resolved, so a
 * suite can assert the real CommonJS loader (the `exports` map, and
 * `require(esm)` itself) outside any test-runner transform.
 */
'use strict';

const {
  test,
  expect,
  routePageThroughSessionProxy,
} = require('@gate-forge/pack-playwright/fixture');

module.exports = { test, expect, routePageThroughSessionProxy };

if (require.main === module) {
  process.stdout.write(
    `test=${typeof test} expect=${typeof expect} route=${typeof routePageThroughSessionProxy}\n`,
  );
}