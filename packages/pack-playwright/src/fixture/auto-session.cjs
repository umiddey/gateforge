'use strict';
// NODE_OPTIONS reaches app servers and helper CLIs too. Playwright's own
// entry scripts identify its runner and forked test processes before imports.
// TEST_WORKER_INDEX is set after preload and is inherited by helper children.
const entry = (process.argv[1] ?? '').replaceAll('\\', '/');
const runner = /\/node_modules\/(?:@playwright\/test|playwright)\/cli\.js$/.test(entry) &&
  process.argv[2] === 'test';
const worker = /\/node_modules\/playwright\/lib\/common\/process\.js$/.test(entry);
if (!runner && !worker) return;
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const wrapper = path.join(__dirname, 'auto-session-wrapper.cjs');
// Load the one fixture before ESM linking starts. A later CJS spec cannot
// synchronously require an ESM graph that is already being linked by a spec.
// The internal loader thread resolves modules, but must not evaluate the runner.
if (!require('node:worker_threads').isInternalThread) {
  try {
    require('./fixture.js');
  } catch (cause) {
    throw new Error(
      `gateforge auto-session: cannot load the witnessed fixture for runner ${process.argv[1]}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (specifier, parent, ...args) {
  if ((specifier === '@playwright/test' || specifier === 'playwright/test') && parent?.filename &&
      parent.filename !== wrapper && !parent.filename.replaceAll('\\', '/').includes('/node_modules/')) {
    return wrapper;
  }
  return resolveFilename.call(this, specifier, parent, ...args);
};
Module.register(pathToFileURL(path.join(__dirname, 'auto-session-loader.mjs')).href);
