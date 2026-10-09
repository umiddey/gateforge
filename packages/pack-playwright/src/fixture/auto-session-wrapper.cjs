'use strict';
const { createRequire } = require('node:module');
const path = require('node:path');
const consumerRequire = createRequire(path.join(process.env.GATEFORGE_PLAYWRIGHT_CONFIG_DIR || process.cwd(), 'node_modules', '__gateforge__.cjs'));
const real = consumerRequire('@playwright/test');
const fixture = require('./fixture.js');
const test = require('./auto-session-root.cjs')(real.test, fixture.test, fixture.request);
module.exports = Object.assign(Object.create(null), real, { test, default: test, request: fixture.request });
