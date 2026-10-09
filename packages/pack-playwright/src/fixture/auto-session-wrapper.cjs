'use strict';
const { createRequire } = require('node:module');
const path = require('node:path');
const consumerRequire = createRequire(path.join(process.env.GATEFORGE_PLAYWRIGHT_CONFIG_DIR || process.cwd(), 'node_modules', '__gateforge__.cjs'));
const real = consumerRequire('@playwright/test');
const { test, request } = require('./fixture.js');
require('./auto-session-root.cjs')(real.test, test, request);
module.exports = Object.assign(Object.create(null), real, { test, default: test, request });
