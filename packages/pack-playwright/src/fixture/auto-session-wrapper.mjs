import wrapped from './auto-session-wrapper.cjs';
export * from '@playwright/test';
// Reuse the CJS bridge's one root Proxy and fixture instance across import shapes.
export const test = wrapped.test;
export const request = wrapped.request;
export default test;
