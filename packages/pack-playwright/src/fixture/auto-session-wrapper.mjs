import { test as root } from '@playwright/test';
import { test as fixtureTest, request } from './fixture.js';
import forwardRoot from './auto-session-root.cjs';
export * from '@playwright/test';
export const test = forwardRoot(root, fixtureTest, request);
export { request };
export default test;
