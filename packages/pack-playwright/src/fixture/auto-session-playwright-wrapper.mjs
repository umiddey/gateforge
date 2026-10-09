import wrapped from './auto-session-wrapper.cjs';
export * from 'playwright/test';
// Preserve native ESM exports while sharing the CJS bridge's root Proxy.
export const test = wrapped.test;
export const request = wrapped.request;
export default test;
