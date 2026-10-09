'use strict';
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const wrapper = path.join(__dirname, 'auto-session-wrapper.cjs');
// Load the one fixture before ESM linking starts. A later CJS spec cannot
// synchronously require an ESM graph that is already being linked by a spec.
// The internal loader thread resolves modules, but must not evaluate the runner.
if (!require('node:worker_threads').isInternalThread) require('./fixture.js');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (specifier, parent, ...args) {
  if (specifier === '@playwright/test' && parent?.filename &&
      parent.filename !== wrapper && !parent.filename.replaceAll('\\', '/').includes('/node_modules/')) {
    return wrapper;
  }
  return resolveFilename.call(this, specifier, parent, ...args);
};
Module.register(pathToFileURL(path.join(__dirname, 'auto-session-loader.mjs')).href);
